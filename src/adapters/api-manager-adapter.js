import { canonicalJson } from '../core/canonical-json.js';
import { isRedacted, mergeRedacted, redactClone, redactedValue } from '../core/redaction.js';
import { isEncryptedEnvelope } from '../core/sensitive-envelope.js';

export const API_MANAGER_SCRIPT_ID = '9dce28ae-a88e-45c6-a211-f5980602de51';
export const API_MANAGER_KEYS = Object.freeze([
  'api_configs_manager',
  'api_configs_categories',
  'api_configs_collapsed_categories',
  'api_configs_category_switch_indexes',
  'stb_api_management_settings',
]);

const API_MANAGER_SCRIPT_NAMES = new Set(['💡API管理器2.0.3', 'API管理器2.0.3']);
const CONFIGS_KEY = 'api_configs_manager';
const DEVICE_ONLY_KEYS = new Set(['api_configs_collapsed_categories']);
const SENSITIVE_CONTEXT = 'api-manager-2/configs/v1';
const SENSITIVE_KEY_PATTERNS = [
  /^api[_-]?key$/i,
  /^key$/i,
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

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseManagedJson(key, raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new TypeError(`${key} must contain valid JSON`);
  }
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

function hasApiManagerScript(host) {
  if (typeof host.hasTavernScript === 'function' && host.hasTavernScript(API_MANAGER_SCRIPT_ID)) return true;
  if (typeof host.tavernHelperScripts?.get !== 'function') return false;
  const result = host.tavernHelperScripts.get();
  return Boolean(
    result?.available
    && collectScriptRecords(result.trees).some(script => API_MANAGER_SCRIPT_NAMES.has(script?.name)),
  );
}

function targetAvailable(host) {
  return hasApiManagerScript(host) || API_MANAGER_KEYS.some(key => host.localStorage.get(key) !== null);
}

function hasAnyStoredValue(host) {
  return API_MANAGER_KEYS.some(key => host.localStorage.get(key) !== null);
}

function validatePayload(payload) {
  if (!isPlainObject(payload) || payload.dataVersion !== 2 || !isPlainObject(payload.entries)) {
    throw new TypeError('API manager adapter payload must be a version 2 object');
  }
  for (const key of API_MANAGER_KEYS) {
    if (!Object.hasOwn(payload.entries, key)) {
      throw new TypeError(`API manager payload is missing ${key}`);
    }
  }
  if (payload.encryptedConfigs !== undefined && !isEncryptedEnvelope(payload.encryptedConfigs)) {
    throw new TypeError('API manager encrypted configs payload is invalid');
  }
}

function parseCurrentEntries(host) {
  const entries = {};
  for (const key of API_MANAGER_KEYS) {
    const raw = host.localStorage.get(key);
    entries[key] = raw === null ? undefined : parseManagedJson(key, raw);
  }
  return entries;
}

async function unlockedEntries(payload, sensitiveCodec) {
  if (payload.encryptedConfigs === undefined) return payload.entries;
  if (!sensitiveCodec?.decrypt) return null;
  const sensitive = await sensitiveCodec.decrypt(payload.encryptedConfigs, SENSITIVE_CONTEXT);
  if (!isPlainObject(sensitive) || !Array.isArray(sensitive.configs)) {
    throw new TypeError('API manager decrypted configs payload is invalid');
  }
  return { ...payload.entries, [CONFIGS_KEY]: sensitive.configs };
}

function buildRestoredEntries(currentEntries, incomingEntries) {
  const restored = {};
  for (const key of API_MANAGER_KEYS) {
    const incoming = incomingEntries[key];
    if (isRedacted(incoming)) {
      restored[key] = currentEntries[key];
      continue;
    }
    restored[key] = mergeRedacted(currentEntries[key], incoming, {
      preserveLocalKeyPatterns: SENSITIVE_KEY_PATTERNS,
    });
  }
  return restored;
}

function entriesEqual(left, right) {
  return API_MANAGER_KEYS.every(key => {
    if (left[key] === undefined || right[key] === undefined) return left[key] === right[key];
    return canonicalJson(left[key]) === canonicalJson(right[key]);
  });
}

export const apiManagerAdapter = {
  id: 'api-manager-2',
  label: '💡API管理器2.0.3',
  version: 2,

  migratePayload(payload, fromVersion) {
    if (fromVersion !== 1 || !isPlainObject(payload) || payload.dataVersion !== 1 || !isPlainObject(payload.entries)) {
      throw new Error(`Unsupported API manager adapter migration from version ${String(fromVersion)}`);
    }
    const migrated = {
      dataVersion: 2,
      entries: {
        api_configs_manager: redactedValue(),
        api_configs_categories: clone(payload.entries.api_configs_categories ?? redactedValue()),
        api_configs_collapsed_categories: redactedValue(),
        api_configs_category_switch_indexes: clone(payload.entries.api_configs_category_switch_indexes ?? redactedValue()),
        stb_api_management_settings: redactedValue(),
      },
    };
    validatePayload(migrated);
    return migrated;
  },

  async capture(host, { includeSensitive = false, sensitiveCodec } = {}) {
    if (!targetAvailable(host)) {
      return { available: false, sourceVersion: '2.0.3', payload: null, diagnostics: { excludedPaths: [] } };
    }
    if (includeSensitive && !sensitiveCodec?.encrypt) {
      throw new Error('An encryption passphrase is required for API Manager sensitive sync');
    }

    const entries = {};
    const excludedPaths = [];
    let configs;
    for (const key of API_MANAGER_KEYS) {
      const path = `$.entries.${key}`;
      const raw = host.localStorage.get(key);
      if (DEVICE_ONLY_KEYS.has(key) || raw === null) {
        entries[key] = redactedValue();
        excludedPaths.push(path);
        continue;
      }
      const parsed = parseManagedJson(key, raw);
      if (key === CONFIGS_KEY) {
        if (!Array.isArray(parsed)) throw new TypeError(`${CONFIGS_KEY} must contain a JSON array`);
        configs = parsed;
        entries[key] = redactedValue();
        excludedPaths.push(path);
        continue;
      }
      const redacted = redactClone(parsed, { sensitiveKeyPatterns: SENSITIVE_KEY_PATTERNS });
      entries[key] = redacted.value;
      excludedPaths.push(...redacted.redactions.map(item => `${path}${item.path.slice(1)}`));
    }

    const payload = {
      dataVersion: 2,
      entries,
      ...(includeSensitive && configs !== undefined
        ? { encryptedConfigs: await sensitiveCodec.encrypt({ configs }, SENSITIVE_CONTEXT) }
        : {}),
    };
    validatePayload(payload);
    return {
      available: true,
      sourceVersion: '2.0.3',
      payload,
      diagnostics: { excludedPaths },
    };
  },

  async preview(host, payload, { sensitiveCodec } = {}) {
    validatePayload(payload);
    const incomingEntries = await unlockedEntries(payload, sensitiveCodec);
    if (incomingEntries === null) return { status: 'locked', reason: 'passphrase-required' };
    if (!targetAvailable(host)) return { status: 'missing-target' };
    if (!hasAnyStoredValue(host)) return { status: 'empty-target' };
    const current = parseCurrentEntries(host);
    const restored = buildRestoredEntries(current, incomingEntries);
    return { status: entriesEqual(current, restored) ? 'noop' : 'would-change' };
  },

  async restore(host, payload, { sensitiveCodec } = {}) {
    validatePayload(payload);
    const incomingEntries = await unlockedEntries(payload, sensitiveCodec);
    if (incomingEntries === null) return { status: 'locked', reason: 'passphrase-required' };
    if (!targetAvailable(host)) return { status: 'missing-target' };
    const current = parseCurrentEntries(host);
    const restored = buildRestoredEntries(current, incomingEntries);
    if (entriesEqual(current, restored)) return { status: 'noop' };
    for (const key of API_MANAGER_KEYS) {
      if (restored[key] === undefined) continue;
      if (current[key] !== undefined && canonicalJson(current[key]) === canonicalJson(restored[key])) continue;
      host.localStorage.set(key, JSON.stringify(restored[key]));
    }
    return { status: 'applied' };
  },
};
