import { canonicalJson } from '../core/canonical-json.js';
import { isRedacted, mergeRedacted, redactClone, stripRedacted } from '../core/redaction.js';
import { isEncryptedEnvelope } from '../core/sensitive-envelope.js';

export const DREAM_SETTINGS_KEY = 'dream-card-agent';
export const DREAM_CACHE_KEY = 'dream-card-agent:settings:v4';
export const DREAM_SETTINGS_CHANNEL = 'dream-card-agent:settings';
export const DREAM_SCRIPT_ID = '41179c00-7593-4cf5-b32b-4d6bb3a6b0c2';
const DREAM_SCRIPT_NAMES = new Set(['梦境创客', '梦境创客（TokenRhythm代理修复）']);
const SUPPORTED_PLUGIN_DATA_VERSION = 4;
const LEGACY_PROVIDER_CONTEXT = 'dream-card-agent/providers/v1';
const SENSITIVE_CONTEXT = 'dream-card-agent/settings/v2';
const DEVICE_ONLY_PATHS = [
  '$.settings.floatingButtonOffset',
  '$.settings.syncRevision',
];
const DEVICE_ONLY_KEYS = new Set(DEVICE_ONLY_PATHS.map(path => path.slice('$.settings.'.length)));
const SENSITIVE_KEY_PATTERNS = [
  /^api[_-]?key$/i,
  /token/i,
  /secret/i,
  /pass(word)?/i,
  /^auth/i,
  /authorization/i,
  /credential/i,
  /cookie/i,
  /^(?:account(?:_?id)?|user(?:name|_name|_?id)|email(?:address|_address)?)$/i,
  /^api$/i,
  /endpoint/i,
];

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function revisionOf(value) {
  return Number.isFinite(value?.syncRevision) ? Math.max(0, Number(value.syncRevision)) : 0;
}

function collectScriptRecords(trees) {
  if (!Array.isArray(trees)) return [];
  return trees.flatMap(tree => {
    if (tree?.type === 'script') return [tree];
    if (tree?.type === 'folder' && Array.isArray(tree.scripts)) {
      return tree.scripts.filter(script => script?.type === 'script');
    }
    return [];
  });
}

function hasDreamScript(host) {
  if (typeof host.hasTavernScript === 'function' && host.hasTavernScript(DREAM_SCRIPT_ID)) return true;
  if (typeof host.tavernHelperScripts?.get !== 'function') return false;
  const result = host.tavernHelperScripts.get();
  return Boolean(
    result?.available
    && collectScriptRecords(result.trees).some(script => DREAM_SCRIPT_NAMES.has(script?.name)),
  );
}

function readCache(host) {
  const raw = host.localStorage.get(DREAM_CACHE_KEY);
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readDreamState(host) {
  const tavern = host.extensionSettings.get(DREAM_SETTINGS_KEY);
  const validTavern = isPlainObject(tavern) ? tavern : undefined;
  const cached = readCache(host);
  const latest = cached && (!validTavern || revisionOf(cached) > revisionOf(validTavern)) ? cached : validTavern;
  return {
    tavern: validTavern,
    cached,
    latest: latest ? clone(latest) : undefined,
    maxRevision: Math.max(revisionOf(validTavern), revisionOf(cached)),
  };
}

function storesAligned(state, value) {
  return Boolean(
    state.tavern
    && state.cached
    && canonicalJson(state.tavern) === canonicalJson(value)
    && canonicalJson(state.cached) === canonicalJson(value)
  );
}

async function persistDreamSettings(host, settings) {
  host.localStorage.set(DREAM_CACHE_KEY, JSON.stringify(settings));
  host.extensionSettings.set(DREAM_SETTINGS_KEY, settings);
  await host.saveSettings();
  host.broadcast?.post?.(DREAM_SETTINGS_CHANNEL, {
    revision: revisionOf(settings),
    type: 'settings-updated',
  });
}

function validatePayload(payload) {
  if (!isPlainObject(payload) || payload.dataVersion !== 3 || !isPlainObject(payload.settings)) {
    throw new TypeError('Dream creator payload is invalid');
  }
  if (payload.pluginDataVersion !== SUPPORTED_PLUGIN_DATA_VERSION) {
    throw new Error(`Unsupported dream creator snapshot version ${String(payload.pluginDataVersion)}`);
  }
  if (payload.settings.version !== SUPPORTED_PLUGIN_DATA_VERSION) {
    throw new Error('Dream creator payload version does not match its envelope');
  }
  if (payload.encryptedProviders !== undefined && !isEncryptedEnvelope(payload.encryptedProviders)) {
    throw new TypeError('Dream creator legacy encrypted provider payload is invalid');
  }
  if (payload.encryptedSettings !== undefined && !isEncryptedEnvelope(payload.encryptedSettings)) {
    throw new TypeError('Dream creator encrypted settings payload is invalid');
  }
  if (payload.encryptedProviders !== undefined && payload.encryptedSettings !== undefined) {
    throw new TypeError('Dream creator payload cannot contain both encrypted settings formats');
  }
}

function providerSensitivePaths(settings) {
  if (!Array.isArray(settings?.providers)) return [];
  return settings.providers.flatMap((_provider, index) => [
    `$.settings.providers[${index}].baseURL`,
    `$.settings.providers[${index}].baseUrl`,
  ]);
}

function portableSettings(settings) {
  const portableRedacted = redactClone(
    { settings },
    { excludedPaths: DEVICE_ONLY_PATHS },
  );
  const portable = stripRedacted(portableRedacted.value);
  if (!isPlainObject(portable?.settings)) {
    throw new TypeError('Unable to build portable Dream creator settings');
  }
  return portable.settings;
}

function repairLegacyCharacterStoreUrls(settings) {
  if (!isPlainObject(settings?.characterStores)) return 0;
  let repaired = 0;
  for (const [key, reference] of Object.entries(settings.characterStores)) {
    if (
      !isPlainObject(reference)
      || typeof reference.url === 'string'
      || typeof reference.bindingId !== 'string'
      || reference.bindingId !== key
      || !Number.isInteger(reference.revision)
      || reference.revision < 0
      || !Number.isInteger(reference.size)
      || reference.size < 0
      || typeof reference.sha256 !== 'string'
      || !/^[a-f\d]{64}$/iu.test(reference.sha256)
    ) continue;
    const safeBindingId = reference.bindingId.replace(/[^a-zA-Z\d_-]/gu, '_').slice(0, 80);
    reference.url = `/user/files/DreamCreator--Meta--${safeBindingId}.json`;
    repaired += 1;
  }
  return repaired;
}

function mergeDreamSettings(current, incoming) {
  const local = isPlainObject(current) ? current : {};
  const restored = mergeRedacted(current, incoming, {
    preserveLocalKeyPatterns: SENSITIVE_KEY_PATTERNS,
  });
  if (!Array.isArray(restored?.providers) || !Array.isArray(incoming?.providers)) return restored;

  const localProviders = new Map(
    (Array.isArray(local.providers) ? local.providers : [])
      .filter(provider => isPlainObject(provider) && typeof provider.id === 'string')
      .map(provider => [provider.id, provider]),
  );
  const incomingProviders = new Map(
    incoming.providers
      .filter(provider => isPlainObject(provider) && typeof provider.id === 'string')
      .map(provider => [provider.id, provider]),
  );
  restored.providers = restored.providers.filter(provider => {
    const incomingProvider = incomingProviders.get(provider?.id);
    if (!incomingProvider || !isRedacted(incomingProvider.secrets)) return true;
    return isPlainObject(localProviders.get(provider.id)?.secrets);
  });
  return restored;
}

function mergePortableSettings(current, incoming) {
  const restored = clone(incoming);
  const local = isPlainObject(current) ? current : {};
  for (const key of DEVICE_ONLY_KEYS) {
    if (Object.hasOwn(local, key)) restored[key] = clone(local[key]);
    else delete restored[key];
  }
  return restored;
}

async function unlockedSettings(payload, sensitiveCodec) {
  if (payload.encryptedSettings !== undefined) {
    if (!sensitiveCodec?.decrypt) return null;
    const sensitive = await sensitiveCodec.decrypt(payload.encryptedSettings, SENSITIVE_CONTEXT);
    if (!isPlainObject(sensitive) || !isPlainObject(sensitive.settings)) {
      throw new TypeError('Dream creator decrypted settings payload is invalid');
    }
    return { settings: sensitive.settings, fullPortable: true };
  }
  if (payload.encryptedProviders !== undefined) {
    if (!sensitiveCodec?.decrypt) return null;
    const sensitive = await sensitiveCodec.decrypt(payload.encryptedProviders, LEGACY_PROVIDER_CONTEXT);
    if (!isPlainObject(sensitive) || !Array.isArray(sensitive.providers)) {
      throw new TypeError('Dream creator decrypted provider payload is invalid');
    }
    return { settings: { ...payload.settings, providers: sensitive.providers }, fullPortable: false };
  }
  return { settings: payload.settings, fullPortable: false };
}

export const dreamCardAgentAdapter = {
  id: 'dream-card-agent',
  label: '梦境创客',
  version: 3,

  migratePayload(payload, fromVersion) {
    if (fromVersion === 1 && isPlainObject(payload) && payload.dataVersion === 1) {
      return { ...payload, dataVersion: 3 };
    }
    if (fromVersion === 2 && isPlainObject(payload) && payload.dataVersion === 2) {
      return { ...payload, dataVersion: 3 };
    }
    throw new Error(`Unsupported dream creator adapter migration from version ${String(fromVersion)}`);
  },

  async capture(host, { includeSensitive = false, sensitiveCodec } = {}) {
    let state = readDreamState(host);
    let current = state.latest;
    if (!isPlainObject(current)) {
      return {
        available: false,
        sourceVersion: null,
        payload: null,
        diagnostics: { excludedPaths: [], repairedReferenceCount: 0 },
      };
    }
    if (current.version !== SUPPORTED_PLUGIN_DATA_VERSION) {
      throw new Error(`Unsupported dream-card-agent data version ${String(current.version)}`);
    }
    const repairedReferenceCount = repairLegacyCharacterStoreUrls(current);
    if (repairedReferenceCount > 0) {
      current.syncRevision = state.maxRevision + 1;
      await persistDreamSettings(host, current);
      state = readDreamState(host);
      current = state.latest;
    }
    if (includeSensitive && !sensitiveCodec?.encrypt) {
      throw new Error('An encryption passphrase is required for Dream creator sensitive sync');
    }
    const redacted = redactClone(
      { settings: current },
      {
        sensitiveKeyPatterns: SENSITIVE_KEY_PATTERNS,
        excludedPaths: [...DEVICE_ONLY_PATHS, ...providerSensitivePaths(current)],
      },
    );
    const payload = {
      dataVersion: 3,
      pluginDataVersion: current.version,
      settings: redacted.value.settings,
      ...(includeSensitive
        ? {
            encryptedSettings: await sensitiveCodec.encrypt(
              { settings: portableSettings(current) },
              SENSITIVE_CONTEXT,
            ),
          }
        : {}),
    };
    validatePayload(payload);
    return {
      available: true,
      sourceVersion: String(current.version),
      payload,
      diagnostics: {
        excludedPaths: redacted.redactions.map(item => item.path),
        repairedReferenceCount,
      },
    };
  },

  async preview(host, payload, { sensitiveCodec } = {}) {
    validatePayload(payload);
    const unlocked = await unlockedSettings(payload, sensitiveCodec);
    if (unlocked === null) return { status: 'locked', reason: 'passphrase-required' };
    const state = readDreamState(host);
    const current = state.latest;
    if (!isPlainObject(current)) {
      return hasDreamScript(host) ? { status: 'empty-target' } : { status: 'missing-target' };
    }
    if (current.version !== payload.pluginDataVersion) {
      return {
        status: 'incompatible',
        message: `Target dream-card-agent version ${String(current.version)} is not supported`,
      };
    }
    const restored = unlocked.fullPortable
      ? mergePortableSettings(current, unlocked.settings)
      : mergeDreamSettings(current, unlocked.settings);
    const contentEqual = canonicalJson(current) === canonicalJson(restored);
    return { status: contentEqual && storesAligned(state, current) ? 'noop' : 'would-change' };
  },

  async restore(host, payload, { sensitiveCodec } = {}) {
    validatePayload(payload);
    const unlocked = await unlockedSettings(payload, sensitiveCodec);
    if (unlocked === null) return { status: 'locked', reason: 'passphrase-required' };
    const state = readDreamState(host);
    const current = state.latest;
    if (!isPlainObject(current)) {
      if (!hasDreamScript(host)) return { status: 'missing-target' };
      const initialized = unlocked.fullPortable
        ? mergePortableSettings(undefined, unlocked.settings)
        : mergeDreamSettings(undefined, unlocked.settings);
      initialized.syncRevision = state.maxRevision + 1;
      await persistDreamSettings(host, initialized);
      return { status: 'applied' };
    }
    if (current.version !== payload.pluginDataVersion) {
      return {
        status: 'incompatible',
        message: `Target dream-card-agent version ${String(current.version)} is not supported`,
      };
    }
    const restored = unlocked.fullPortable
      ? mergePortableSettings(current, unlocked.settings)
      : mergeDreamSettings(current, unlocked.settings);
    const contentChanged = canonicalJson(current) !== canonicalJson(restored);
    if (!contentChanged && storesAligned(state, current)) return { status: 'noop' };
    restored.syncRevision = contentChanged ? state.maxRevision + 1 : revisionOf(current);
    await persistDreamSettings(host, restored);
    return { status: 'applied' };
  },
};
