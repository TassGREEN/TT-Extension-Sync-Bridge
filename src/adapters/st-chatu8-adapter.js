import { canonicalJson } from '../core/canonical-json.js';
import { mergeRedacted, redactClone, stripRedacted } from '../core/redaction.js';
import { isEncryptedEnvelope } from '../core/sensitive-envelope.js';

export const ST_CHATU8_SETTINGS_KEY = 'st-chatu8';
const PLUGIN_ID = 'third-party/st-chatu8';
const SUPPORTED_VERSION = /^2\.8\./;
const SENSITIVE_CONTEXT = 'st-chatu8/settings/v1';
const GALLERY_DATABASE = 'chatu8_gallery';
const GALLERY_DATABASE_VERSION = 6;
const MANUAL_TAG_STORE = 'tags';
const MANUAL_TAG_INDEX = 'fileName';
const MANUAL_TAG_INDEX_VALUE = 'manual';

const DEVICE_ONLY_PATHS = [
  '$.settings.cache',
  '$.settings.cacheStorageMigrated',
  '$.settings.edgePingCache',
  '$.settings.imageGenStats',
  '$.settings.log',
  '$.settings.logState',
  '$.settings.lastTab',
  '$.settings.regexTestMode',
  '$.settings.ai_test_output',
  '$.settings.ai_test_system',
  '$.settings.ai_test_user',
  '$.settings.chatu8_fab_position',
  '$.settings.chatu8_fab_size',
  '$.settings.chatu8_fab_icon_image_id',
  '$.settings.chatu8_fab_video_paths',
  '$.settings.jiuguanStorage',
];
const DEVICE_ONLY_KEYS = new Set(DEVICE_ONLY_PATHS.map(path => path.slice('$.settings.'.length)));

const SENSITIVE_KEY_PATTERNS = [
  /^api[_-]?key$/i,
  /token/i,
  /secret/i,
  /pass(word)?/i,
  /auth/i,
  /authorization/i,
  /credential/i,
  /cookie/i,
  /^(?:account(?:_?id)?|user(?:name|_name|_?id)|email(?:address|_address)?)$/i,
  /url$/i,
  /^(?:novelaiApi|api)$/i,
  /site$/i,
  /endpoint/i,
  /^ai_private$/i,
  /^chatu8_code$/i,
];

const INDEXED_DB_SUPPORT = Object.freeze([
  Object.freeze({
    database: 'chatu8_gallery',
    version: 6,
    stores: Object.freeze([
      Object.freeze({
        name: 'tags',
        included: 'manual-only',
        index: MANUAL_TAG_INDEX,
        equals: MANUAL_TAG_INDEX_VALUE,
        identity: 'name',
      }),
      Object.freeze({ name: 'tupianhuancun', included: false }),
      Object.freeze({ name: 'vocabularies', included: false }),
      Object.freeze({ name: 'groups', included: false }),
      Object.freeze({ name: 'subgroups', included: false }),
    ]),
    reason: 'Only user-created manual tags are portable; image metadata and installed vocabularies remain excluded.',
  }),
  Object.freeze({
    database: 'chatu8_config_images',
    version: 2,
    stores: Object.freeze(['config_images']),
    included: false,
    reason: 'Contains configuration images and SD/ComfyUI caches.',
  }),
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function supported(version) {
  return typeof version === 'string' && SUPPORTED_VERSION.test(version);
}

function stableTextCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeManualTags(records) {
  if (!Array.isArray(records)) throw new TypeError('st-chatu8 manual tags must be an array');
  const seen = new Set();
  const normalized = records.map(record => {
    if (!isPlainObject(record) || typeof record.name !== 'string' || record.name.trim() === '') {
      throw new TypeError('st-chatu8 manual tag name must be a non-empty string');
    }
    if (seen.has(record.name)) {
      throw new Error(`Duplicate st-chatu8 manual tag name: ${record.name}`);
    }
    seen.add(record.name);
    if (record.translation !== undefined && typeof record.translation !== 'string') {
      throw new TypeError('st-chatu8 manual tag translation must be a string');
    }
    if (record.hot !== undefined && (!Number.isFinite(record.hot) || !Number.isInteger(record.hot))) {
      throw new TypeError('st-chatu8 manual tag hot value must be an integer');
    }
    return {
      name: record.name,
      translation: record.translation ?? '',
      hot: record.hot ?? 0,
      fileName: MANUAL_TAG_INDEX_VALUE,
    };
  });
  return normalized.sort((left, right) => (
    stableTextCompare(left.name, right.name)
    || stableTextCompare(left.translation, right.translation)
    || left.hot - right.hot
  ));
}

async function readManualTags(host) {
  if (typeof host.indexedDb?.getAllByIndex !== 'function') {
    return { captured: false, records: [], reason: 'indexeddb-host-unavailable', incompatibleVersion: null };
  }
  const result = await host.indexedDb.getAllByIndex({
    database: GALLERY_DATABASE,
    version: GALLERY_DATABASE_VERSION,
    store: MANUAL_TAG_STORE,
    index: MANUAL_TAG_INDEX,
    value: MANUAL_TAG_INDEX_VALUE,
  });
  if (!result?.available) {
    const reason = result?.reason ?? 'indexeddb-unavailable';
    const versionMatch = /^database-version-(\d+)$/.exec(reason);
    return {
      captured: false,
      records: [],
      reason,
      incompatibleVersion: versionMatch ? Number(versionMatch[1]) : null,
    };
  }
  return { captured: true, records: normalizeManualTags(result.records), reason: null, incompatibleVersion: null };
}

function manualTagsEqual(left, right) {
  return canonicalJson(normalizeManualTags(left)) === canonicalJson(normalizeManualTags(right));
}

function validatePayload(payload) {
  if (!isPlainObject(payload) || payload.dataVersion !== 2 || !isPlainObject(payload.settings)) {
    throw new TypeError('st-chatu8 payload is invalid');
  }
  if (!supported(payload.pluginVersion)) {
    throw new Error(`Unsupported st-chatu8 snapshot version ${String(payload.pluginVersion)}`);
  }
  if (payload.encryptedSettings !== undefined && !isEncryptedEnvelope(payload.encryptedSettings)) {
    throw new TypeError('st-chatu8 encrypted settings payload is invalid');
  }
  if (!Array.isArray(payload.indexedDb) || canonicalJson(payload.indexedDb) !== canonicalJson(INDEXED_DB_SUPPORT)) {
    throw new TypeError('st-chatu8 IndexedDB support metadata is invalid');
  }
  if (!isPlainObject(payload.manualTags) || typeof payload.manualTags.captured !== 'boolean') {
    throw new TypeError('st-chatu8 manual tags payload is invalid');
  }
  if (payload.manualTags.captured) {
    normalizeManualTags(payload.manualTags.records);
  } else if (!Array.isArray(payload.manualTags.records) || payload.manualTags.records.length !== 0) {
    throw new TypeError('Uncaptured st-chatu8 manual tags must have no records');
  }
}

function preserveDeviceOnly(current, restored) {
  if (!isPlainObject(current) || !isPlainObject(restored)) return restored;
  for (const key of DEVICE_ONLY_KEYS) {
    if (Object.hasOwn(current, key)) restored[key] = clone(current[key]);
    else delete restored[key];
  }
  return restored;
}

async function unlockedSettings(payload, sensitiveCodec) {
  if (payload.encryptedSettings === undefined) {
    return { settings: payload.settings, containsSensitive: false };
  }
  if (!sensitiveCodec?.decrypt) return null;
  const sensitive = await sensitiveCodec.decrypt(payload.encryptedSettings, SENSITIVE_CONTEXT);
  if (!isPlainObject(sensitive) || !isPlainObject(sensitive.settings)) {
    throw new TypeError('st-chatu8 decrypted settings payload is invalid');
  }
  return { settings: sensitive.settings, containsSensitive: true };
}

function mergeSettings(current, unlocked) {
  if (unlocked.containsSensitive) {
    return preserveDeviceOnly(current, clone(unlocked.settings));
  }
  return mergeRedacted(current, unlocked.settings, {
    preserveLocalKeyPatterns: SENSITIVE_KEY_PATTERNS,
  });
}

async function refreshRuntime(host) {
  try {
    await host.stChatu8?.refresh?.();
  } catch (error) {
    console.warn('[TT Extension Sync Bridge] st-chatu8 runtime refresh failed:', error);
  }
}

export const stChatu8Adapter = {
  id: 'st-chatu8',
  label: 'st-chatu8',
  version: 2,

  migratePayload(payload, fromVersion) {
    if (fromVersion !== 1 || !isPlainObject(payload) || payload.dataVersion !== 1) {
      throw new Error(`Unsupported st-chatu8 adapter migration from version ${String(fromVersion)}`);
    }
    const migrated = { ...payload, dataVersion: 2 };
    validatePayload(migrated);
    return migrated;
  },

  async capture(host, { includeSensitive = false, sensitiveCodec } = {}) {
    const current = host.extensionSettings.get(ST_CHATU8_SETTINGS_KEY);
    const pluginVersion = host.pluginVersion(PLUGIN_ID);
    if (!isPlainObject(current) && pluginVersion === null) {
      return { available: false, sourceVersion: null, payload: null, diagnostics: { excludedPaths: [] } };
    }
    if (!supported(pluginVersion)) {
      throw new Error(`Unsupported st-chatu8 version ${String(pluginVersion)}`);
    }
    if (!isPlainObject(current)) {
      throw new TypeError('st-chatu8 settings are unavailable or malformed');
    }
    if (includeSensitive && !sensitiveCodec?.encrypt) {
      throw new Error('An encryption passphrase is required for st-chatu8 sensitive sync');
    }
    const redacted = redactClone(
      { settings: current },
      {
        sensitiveKeyPatterns: SENSITIVE_KEY_PATTERNS,
        excludedPaths: DEVICE_ONLY_PATHS,
      },
    );
    let encryptedSettings;
    if (includeSensitive) {
      const portableRedacted = redactClone(
        { settings: current },
        { excludedPaths: DEVICE_ONLY_PATHS },
      );
      const portable = stripRedacted(portableRedacted.value);
      if (!isPlainObject(portable?.settings)) {
        throw new TypeError('Unable to build portable st-chatu8 settings');
      }
      encryptedSettings = await sensitiveCodec.encrypt({ settings: portable.settings }, SENSITIVE_CONTEXT);
    }
    const manualTags = await readManualTags(host);
    if (manualTags.incompatibleVersion !== null) {
      throw new Error(`Unsupported st-chatu8 gallery database version ${manualTags.incompatibleVersion}`);
    }
    if (!manualTags.captured) {
      throw new Error(`Unable to capture st-chatu8 manual tags: ${manualTags.reason}`);
    }
    const payload = {
      dataVersion: 2,
      pluginVersion,
      settings: redacted.value.settings,
      ...(encryptedSettings ? { encryptedSettings } : {}),
      indexedDb: clone(INDEXED_DB_SUPPORT),
      manualTags: { captured: manualTags.captured, records: manualTags.records },
    };
    validatePayload(payload);
    return {
      available: true,
      sourceVersion: pluginVersion,
      payload,
      diagnostics: {
        excludedPaths: redacted.redactions.map(item => item.path),
        manualTags: { captured: manualTags.captured, reason: manualTags.reason },
      },
    };
  },

  async preview(host, payload, { sensitiveCodec } = {}) {
    validatePayload(payload);
    const unlocked = await unlockedSettings(payload, sensitiveCodec);
    if (unlocked === null) return { status: 'locked', reason: 'passphrase-required' };
    const current = host.extensionSettings.get(ST_CHATU8_SETTINGS_KEY);
    const targetVersion = host.pluginVersion(PLUGIN_ID);
    if (!isPlainObject(current) && targetVersion === null) return { status: 'missing-target' };
    if (!supported(targetVersion)) {
      return { status: 'incompatible', message: `Target st-chatu8 version ${String(targetVersion)} is not supported` };
    }
    if (!isPlainObject(current)) return { status: 'empty-target' };
    const restored = mergeSettings(current, unlocked);
    const settingsEqual = canonicalJson(current) === canonicalJson(restored);
    if (!payload.manualTags.captured) {
      return { status: settingsEqual ? 'noop' : 'would-change' };
    }
    const currentManualTags = await readManualTags(host);
    if (currentManualTags.incompatibleVersion !== null) {
      return {
        status: 'incompatible',
        message: `Target st-chatu8 gallery database version ${currentManualTags.incompatibleVersion} is not supported`,
      };
    }
    if (!currentManualTags.captured) {
      return { status: 'deferred', reason: currentManualTags.reason };
    }
    const tagsEqual = manualTagsEqual(currentManualTags.records, payload.manualTags.records);
    return {
      status: settingsEqual && tagsEqual ? 'noop' : 'would-change',
      safeToApply: settingsEqual && currentManualTags.records.length === 0,
    };
  },

  async restore(host, payload, { sensitiveCodec } = {}) {
    validatePayload(payload);
    const unlocked = await unlockedSettings(payload, sensitiveCodec);
    if (unlocked === null) return { status: 'locked', reason: 'passphrase-required' };
    const current = host.extensionSettings.get(ST_CHATU8_SETTINGS_KEY);
    const targetVersion = host.pluginVersion(PLUGIN_ID);
    if (!isPlainObject(current) && targetVersion === null) return { status: 'missing-target' };
    if (!supported(targetVersion)) {
      return { status: 'incompatible', message: `Target st-chatu8 version ${String(targetVersion)} is not supported` };
    }
    const currentManualTags = payload.manualTags.captured ? await readManualTags(host) : null;
    if (currentManualTags?.incompatibleVersion !== null && currentManualTags?.incompatibleVersion !== undefined) {
      return {
        status: 'incompatible',
        message: `Target st-chatu8 gallery database version ${currentManualTags.incompatibleVersion} is not supported`,
      };
    }
    const restored = mergeSettings(current, unlocked);
    const settingsChanged = !isPlainObject(current) || canonicalJson(current) !== canonicalJson(restored);
    let tagsChanged = false;
    if (payload.manualTags.captured) {
      if (!currentManualTags.captured) {
        if (settingsChanged) {
          host.extensionSettings.set(ST_CHATU8_SETTINGS_KEY, restored);
          await host.saveSettings();
          await refreshRuntime(host);
        }
        return { status: 'deferred', reason: currentManualTags.reason };
      }
      tagsChanged = !manualTagsEqual(currentManualTags.records, payload.manualTags.records);
      if (tagsChanged) {
        const replaced = await host.indexedDb.replaceByIndex({
          database: GALLERY_DATABASE,
          version: GALLERY_DATABASE_VERSION,
          store: MANUAL_TAG_STORE,
          index: MANUAL_TAG_INDEX,
          value: MANUAL_TAG_INDEX_VALUE,
          records: normalizeManualTags(payload.manualTags.records),
        });
        if (!replaced?.available) return { status: 'deferred', reason: replaced?.reason ?? 'indexeddb-unavailable' };
      }
    }
    if (settingsChanged) {
      host.extensionSettings.set(ST_CHATU8_SETTINGS_KEY, restored);
      await host.saveSettings();
    }
    if (settingsChanged || tagsChanged) await refreshRuntime(host);
    return settingsChanged || tagsChanged ? { status: 'applied' } : { status: 'noop' };
  },
};
