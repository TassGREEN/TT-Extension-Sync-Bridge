import { canonicalJson } from '../core/canonical-json.js';
import { mergeRedacted, redactClone } from '../core/redaction.js';

export const DATABASE_SETTINGS_ROOT = '__userscripts';
export const DATABASE_SETTINGS_KEY = 'shujuku_v104__userscript_settings_v1';
export const DATABASE_SCRIPT_ID = '8e1213cb-732a-444b-8a80-631e1cf614b5';

const WINDOW_STATE_PATH = '$.settings.shujuku_v104_windowStates';
const REQUIRED_DATA_KEYS = [
  'shujuku_v104_globalMeta_v1',
  'shujuku_v104_profile_v1____default____settings',
  'shujuku_v104_profile_v1____default____template',
  'shujuku_v104_templatePresets_v1',
];

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readCurrentSettings(host) {
  const userscripts = host.extensionSettings.get(DATABASE_SETTINGS_ROOT);
  return isPlainObject(userscripts) ? userscripts[DATABASE_SETTINGS_KEY] : undefined;
}

function writeCurrentSettings(host, settings) {
  const currentRoot = host.extensionSettings.get(DATABASE_SETTINGS_ROOT);
  const nextRoot = isPlainObject(currentRoot) ? currentRoot : {};
  nextRoot[DATABASE_SETTINGS_KEY] = settings;
  host.extensionSettings.set(DATABASE_SETTINGS_ROOT, nextRoot);
}

function validatePayload(payload) {
  if (!isPlainObject(payload) || !isPlainObject(payload.settings)) {
    throw new TypeError('Database adapter payload must contain settings object');
  }
  if (payload.dataVersion !== undefined && payload.dataVersion !== 1) {
    throw new Error(`Unsupported database adapter data version: ${String(payload.dataVersion)}`);
  }
  for (const key of REQUIRED_DATA_KEYS) {
    const value = payload.settings[key];
    if (value !== undefined && typeof value !== 'string') {
      throw new TypeError(`Database setting ${key} must be a JSON string`);
    }
  }
}

export const databaseAdapter = {
  id: 'database-shujuku-v104',
  label: '蚀心入魔·数据库',
  version: 1,

  async capture(host, { includeSensitive = false } = {}) {
    const current = readCurrentSettings(host);
    if (!isPlainObject(current)) {
      return {
        available: false,
        sourceVersion: 'shujuku_v104',
        payload: null,
        diagnostics: { excludedPaths: [] },
      };
    }

    const redacted = redactClone(
      { settings: current },
      { includeSensitive, excludedPaths: [WINDOW_STATE_PATH] },
    );
    const payload = {
      dataVersion: 1,
      sourceSchema: 'shujuku_v104',
      settings: redacted.value.settings,
    };
    validatePayload(payload);
    return {
      available: true,
      sourceVersion: 'shujuku_v104',
      payload,
      diagnostics: { excludedPaths: redacted.redactions.map(item => item.path) },
    };
  },

  async preview(host, payload) {
    validatePayload(payload);
    const current = readCurrentSettings(host);
    if (!isPlainObject(current)) {
      return typeof host.hasTavernScript === 'function' && host.hasTavernScript(DATABASE_SCRIPT_ID)
        ? { status: 'empty-target' }
        : { status: 'missing-target' };
    }
    const restored = mergeRedacted(current, payload.settings);
    return {
      status: canonicalJson(current) === canonicalJson(restored) ? 'noop' : 'would-change',
    };
  },

  async restore(host, payload) {
    const current = readCurrentSettings(host);
    validatePayload(payload);
    if (!isPlainObject(current)) {
      if (typeof host.hasTavernScript !== 'function' || !host.hasTavernScript(DATABASE_SCRIPT_ID)) {
        return { status: 'missing-target' };
      }
      const initialized = mergeRedacted(undefined, payload.settings);
      writeCurrentSettings(host, initialized);
      await host.saveSettings();
      return { status: 'applied' };
    }
    const restored = mergeRedacted(current, payload.settings);
    if (canonicalJson(current) === canonicalJson(restored)) return { status: 'noop' };
    writeCurrentSettings(host, restored);
    await host.saveSettings();
    return { status: 'applied' };
  },
};
