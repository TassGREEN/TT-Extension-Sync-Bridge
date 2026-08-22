import { canonicalJson } from '../core/canonical-json.js';
import { mergeRedacted, redactClone } from '../core/redaction.js';

export const DREAM_SETTINGS_KEY = 'dream-card-agent';
export const DREAM_SCRIPT_ID = '41179c00-7593-4cf5-b32b-4d6bb3a6b0c2';
const SUPPORTED_PLUGIN_DATA_VERSION = 4;
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
  /url$/i,
  /^api$/i,
  /endpoint/i,
];

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validatePayload(payload) {
  if (!isPlainObject(payload) || payload.dataVersion !== 1 || !isPlainObject(payload.settings)) {
    throw new TypeError('Dream creator payload is invalid');
  }
  if (payload.pluginDataVersion !== SUPPORTED_PLUGIN_DATA_VERSION) {
    throw new Error(`Unsupported dream creator snapshot version ${String(payload.pluginDataVersion)}`);
  }
  if (payload.settings.version !== SUPPORTED_PLUGIN_DATA_VERSION) {
    throw new Error('Dream creator payload version does not match its envelope');
  }
}

export const dreamCardAgentAdapter = {
  id: 'dream-card-agent',
  label: '梦境创客',
  version: 1,

  async capture(host, { includeSensitive = false } = {}) {
    const current = host.extensionSettings.get(DREAM_SETTINGS_KEY);
    if (!isPlainObject(current)) {
      return { available: false, sourceVersion: null, payload: null, diagnostics: { excludedPaths: [] } };
    }
    if (current.version !== SUPPORTED_PLUGIN_DATA_VERSION) {
      throw new Error(`Unsupported dream-card-agent data version ${String(current.version)}`);
    }
    const redacted = redactClone(
      { settings: current },
      {
        includeSensitive,
        sensitiveKeyPatterns: SENSITIVE_KEY_PATTERNS,
        excludedPaths: DEVICE_ONLY_PATHS,
      },
    );
    const payload = {
      dataVersion: 1,
      pluginDataVersion: current.version,
      settings: redacted.value.settings,
    };
    validatePayload(payload);
    return {
      available: true,
      sourceVersion: String(current.version),
      payload,
      diagnostics: { excludedPaths: redacted.redactions.map(item => item.path) },
    };
  },

  async preview(host, payload) {
    validatePayload(payload);
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
    const restored = mergeRedacted(current, payload.settings, {
      preserveLocalKeyPatterns: SENSITIVE_KEY_PATTERNS,
    });
    return { status: canonicalJson(current) === canonicalJson(restored) ? 'noop' : 'would-change' };
  },

  async restore(host, payload) {
    validatePayload(payload);
    const current = host.extensionSettings.get(DREAM_SETTINGS_KEY);
    if (!isPlainObject(current)) {
      if (typeof host.hasTavernScript !== 'function' || !host.hasTavernScript(DREAM_SCRIPT_ID)) {
        return { status: 'missing-target' };
      }
      const initialized = mergeRedacted(undefined, payload.settings, {
        preserveLocalKeyPatterns: SENSITIVE_KEY_PATTERNS,
      });
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
    const restored = mergeRedacted(current, payload.settings, {
      preserveLocalKeyPatterns: SENSITIVE_KEY_PATTERNS,
    });
    if (canonicalJson(current) === canonicalJson(restored)) return { status: 'noop' };
    host.extensionSettings.set(DREAM_SETTINGS_KEY, restored);
    await host.saveSettings();
    return { status: 'applied' };
  },
};
