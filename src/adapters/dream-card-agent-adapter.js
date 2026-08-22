import { canonicalJson } from '../core/canonical-json.js';
import { isRedacted, mergeRedacted, redactClone } from '../core/redaction.js';
import { isEncryptedEnvelope } from '../core/sensitive-envelope.js';

export const DREAM_SETTINGS_KEY = 'dream-card-agent';
export const DREAM_SCRIPT_ID = '41179c00-7593-4cf5-b32b-4d6bb3a6b0c2';
const SUPPORTED_PLUGIN_DATA_VERSION = 4;
const SENSITIVE_CONTEXT = 'dream-card-agent/providers/v1';
const DEVICE_ONLY_PATHS = [
  '$.settings.floatingButtonOffset',
  '$.settings.syncRevision',
];
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

function validatePayload(payload) {
  if (!isPlainObject(payload) || payload.dataVersion !== 2 || !isPlainObject(payload.settings)) {
    throw new TypeError('Dream creator payload is invalid');
  }
  if (payload.pluginDataVersion !== SUPPORTED_PLUGIN_DATA_VERSION) {
    throw new Error(`Unsupported dream creator snapshot version ${String(payload.pluginDataVersion)}`);
  }
  if (payload.settings.version !== SUPPORTED_PLUGIN_DATA_VERSION) {
    throw new Error('Dream creator payload version does not match its envelope');
  }
  if (payload.encryptedProviders !== undefined && !isEncryptedEnvelope(payload.encryptedProviders)) {
    throw new TypeError('Dream creator encrypted provider payload is invalid');
  }
}

function providerSensitivePaths(settings) {
  if (!Array.isArray(settings?.providers)) return [];
  return settings.providers.flatMap((_provider, index) => [
    `$.settings.providers[${index}].baseURL`,
    `$.settings.providers[${index}].baseUrl`,
  ]);
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

async function unlockedSettings(payload, sensitiveCodec) {
  if (payload.encryptedProviders === undefined) return payload.settings;
  if (!sensitiveCodec?.decrypt) return null;
  const sensitive = await sensitiveCodec.decrypt(payload.encryptedProviders, SENSITIVE_CONTEXT);
  if (!isPlainObject(sensitive) || !Array.isArray(sensitive.providers)) {
    throw new TypeError('Dream creator decrypted provider payload is invalid');
  }
  return { ...payload.settings, providers: sensitive.providers };
}

export const dreamCardAgentAdapter = {
  id: 'dream-card-agent',
  label: '梦境创客',
  version: 2,

  migratePayload(payload, fromVersion) {
    if (fromVersion !== 1 || !isPlainObject(payload) || payload.dataVersion !== 1) {
      throw new Error(`Unsupported dream creator adapter migration from version ${String(fromVersion)}`);
    }
    return { ...payload, dataVersion: 2 };
  },

  async capture(host, { includeSensitive = false, sensitiveCodec } = {}) {
    const current = host.extensionSettings.get(DREAM_SETTINGS_KEY);
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
      host.extensionSettings.set(DREAM_SETTINGS_KEY, current);
      await host.saveSettings();
    }
    if (includeSensitive && !sensitiveCodec?.encrypt) {
      throw new Error('An encryption passphrase is required for Dream creator sensitive sync');
    }
    const redacted = redactClone(
      { settings: current },
      {
        includeSensitive: false,
        sensitiveKeyPatterns: SENSITIVE_KEY_PATTERNS,
        excludedPaths: [...DEVICE_ONLY_PATHS, ...providerSensitivePaths(current)],
      },
    );
    const payload = {
      dataVersion: 2,
      pluginDataVersion: current.version,
      settings: redacted.value.settings,
      ...(includeSensitive
        ? { encryptedProviders: await sensitiveCodec.encrypt({ providers: current.providers ?? [] }, SENSITIVE_CONTEXT) }
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
    const incomingSettings = await unlockedSettings(payload, sensitiveCodec);
    if (incomingSettings === null) return { status: 'locked', reason: 'passphrase-required' };
    const current = host.extensionSettings.get(DREAM_SETTINGS_KEY);
    if (!isPlainObject(current)) {
      return typeof host.hasTavernScript === 'function' && host.hasTavernScript(DREAM_SCRIPT_ID)
        ? { status: 'empty-target' }
        : { status: 'missing-target' };
    }
    if (current.version !== payload.pluginDataVersion) {
      return {
        status: 'incompatible',
        message: `Target dream-card-agent version ${String(current.version)} is not supported`,
      };
    }
    const restored = mergeDreamSettings(current, incomingSettings);
    return { status: canonicalJson(current) === canonicalJson(restored) ? 'noop' : 'would-change' };
  },

  async restore(host, payload, { sensitiveCodec } = {}) {
    validatePayload(payload);
    const incomingSettings = await unlockedSettings(payload, sensitiveCodec);
    if (incomingSettings === null) return { status: 'locked', reason: 'passphrase-required' };
    const current = host.extensionSettings.get(DREAM_SETTINGS_KEY);
    if (!isPlainObject(current)) {
      if (typeof host.hasTavernScript !== 'function' || !host.hasTavernScript(DREAM_SCRIPT_ID)) {
        return { status: 'missing-target' };
      }
      const initialized = mergeDreamSettings(undefined, incomingSettings);
      host.extensionSettings.set(DREAM_SETTINGS_KEY, initialized);
      await host.saveSettings();
      return { status: 'applied' };
    }
    if (current.version !== payload.pluginDataVersion) {
      return {
        status: 'incompatible',
        message: `Target dream-card-agent version ${String(current.version)} is not supported`,
      };
    }
    const restored = mergeDreamSettings(current, incomingSettings);
    if (canonicalJson(current) === canonicalJson(restored)) return { status: 'noop' };
    host.extensionSettings.set(DREAM_SETTINGS_KEY, restored);
    await host.saveSettings();
    return { status: 'applied' };
  },
};
