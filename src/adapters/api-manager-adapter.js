import { canonicalJson } from '../core/canonical-json.js';
import { isRedacted, mergeRedacted, redactClone, redactedValue } from '../core/redaction.js';

export const API_MANAGER_SCRIPT_ID = '9dce28ae-a88e-45c6-a211-f5980602de51';
export const API_MANAGER_KEYS = Object.freeze([
  'api_configs_manager',
  'api_configs_categories',
  'api_configs_collapsed_categories',
  'api_configs_category_switch_indexes',
  'st_api_manager_sync_metadata_v1',
  'st_api_manager_debug_modal',
]);

const DEVICE_ONLY_KEYS = new Set([
  'api_configs_collapsed_categories',
  'st_api_manager_sync_metadata_v1',
  'st_api_manager_debug_modal',
]);

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

function parseManagedJson(key, raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new TypeError(`${key} must contain valid JSON`);
  }
}

function targetAvailable(host) {
  if (typeof host.hasTavernScript === 'function' && host.hasTavernScript(API_MANAGER_SCRIPT_ID)) return true;
  return API_MANAGER_KEYS.some(key => host.localStorage.get(key) !== null);
}

function hasAnyStoredValue(host) {
  return API_MANAGER_KEYS.some(key => host.localStorage.get(key) !== null);
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('API manager adapter payload must be an object');
  }
  if (payload.dataVersion !== 1) {
    throw new Error(`Unsupported API manager data version: ${String(payload.dataVersion)}`);
  }
  if (!payload.entries || typeof payload.entries !== 'object' || Array.isArray(payload.entries)) {
    throw new TypeError('API manager payload entries must be an object');
  }
  for (const key of API_MANAGER_KEYS) {
    if (!Object.hasOwn(payload.entries, key)) {
      throw new TypeError(`API manager payload is missing ${key}`);
    }
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
  version: 1,

  async capture(host, { includeSensitive = false } = {}) {
    if (!targetAvailable(host)) {
      return { available: false, sourceVersion: '2.0.3', payload: null, diagnostics: { excludedPaths: [] } };
    }

    const entries = {};
    const excludedPaths = [];
    for (const key of API_MANAGER_KEYS) {
      const path = `$.entries.${key}`;
      const raw = host.localStorage.get(key);
      if (DEVICE_ONLY_KEYS.has(key) || raw === null) {
        entries[key] = redactedValue();
        excludedPaths.push(path);
        continue;
      }
      const parsed = parseManagedJson(key, raw);
      const redacted = redactClone(parsed, { includeSensitive, sensitiveKeyPatterns: SENSITIVE_KEY_PATTERNS });
      entries[key] = redacted.value;
      excludedPaths.push(...redacted.redactions.map(item => `${path}${item.path.slice(1)}`));
    }

    const payload = { dataVersion: 1, entries };
    validatePayload(payload);
    return {
      available: true,
      sourceVersion: '2.0.3',
      payload,
      diagnostics: { excludedPaths },
    };
  },

  async preview(host, payload) {
    validatePayload(payload);
    if (!targetAvailable(host)) return { status: 'missing-target' };
    if (!hasAnyStoredValue(host)) return { status: 'empty-target' };
    const current = parseCurrentEntries(host);
    const restored = buildRestoredEntries(current, payload.entries);
    return { status: entriesEqual(current, restored) ? 'noop' : 'would-change' };
  },

  async restore(host, payload) {
    validatePayload(payload);
    if (!targetAvailable(host)) return { status: 'missing-target' };
    const current = parseCurrentEntries(host);
    const restored = buildRestoredEntries(current, payload.entries);
    if (entriesEqual(current, restored)) return { status: 'noop' };
    for (const key of API_MANAGER_KEYS) {
      if (restored[key] === undefined) continue;
      if (current[key] !== undefined && canonicalJson(current[key]) === canonicalJson(restored[key])) continue;
      host.localStorage.set(key, JSON.stringify(restored[key]));
    }
    return { status: 'applied' };
  },
};
