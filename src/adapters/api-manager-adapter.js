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

const API_MANAGER_SCRIPT_NAMES = new Set([
  '💡API管理器2.0.3',
  'API管理器2.0.3',
  '💡API管理器2.1.1',
  'API管理器2.1.1',
]);
const CONFIGS_KEY = 'api_configs_manager';
const CATEGORIES_KEY = 'api_configs_categories';
const DEVICE_ONLY_KEYS = new Set(['api_configs_collapsed_categories']);
const SENSITIVE_CONTEXT = 'api-manager-2/configs/v1';
const GROUPED_FORMAT = 'grouped-api-configs';
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

function looksLikeApiConfig(value) {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.name === 'string'
    && typeof value.source === 'string'
    && (
      typeof value.customUrl === 'string'
      || typeof value.customModel === 'string'
      || Array.isArray(value.apiKeys)
      || typeof value.apiKey === 'string'
    )
  );
}

function valueKind(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (isPlainObject(value)) return 'object';
  return typeof value;
}

function topLevelObjectFields(value) {
  if (!isPlainObject(value)) return [];
  return Object.entries(value).slice(0, 20).map(([name, item]) => ({
    name: String(name).slice(0, 80),
    type: valueKind(item),
  }));
}

function normalizeEndpoint(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/u, '').toLowerCase() : '';
}

function deriveGroupKey(groupName, customUrl) {
  return `${String(groupName ?? '').trim().toLowerCase()}|${normalizeEndpoint(customUrl)}`;
}

function flattenGroupedConfigs(value) {
  if (!isPlainObject(value) || value.format !== GROUPED_FORMAT || !Array.isArray(value.groups)) return null;

  return value.groups.flatMap(group => {
    if (!isPlainObject(group) || !group.groupName || !group.source) return [];
    const models = Array.isArray(group.models) && group.models.length > 0 ? group.models : [{}];
    return models.map(modelValue => {
      const model = isPlainObject(modelValue) ? modelValue : {};
      return {
        name: model.name || `[${group.groupName}] ${model.customModel || '未选择模型'}`,
        source: group.source,
        customUrl: typeof group.customUrl === 'string' ? group.customUrl : '',
        apiKeys: Array.isArray(group.apiKeys) ? group.apiKeys.map(item => ({ ...item })) : [],
        currentKeyIndex: model.currentKeyIndex ?? 0,
        enableKeyRotation: group.enableKeyRotation ?? false,
        customModel: typeof model.customModel === 'string' ? model.customModel : '',
        groupName: group.groupName,
        groupKey: group.groupKey || deriveGroupKey(group.groupName, group.customUrl || ''),
        categoryId: model.categoryId,
        categoryIds: Array.isArray(model.categoryIds)
          ? [...model.categoryIds]
          : (model.categoryId ? [model.categoryId] : []),
        isActive: model.isActive ?? false,
        lastVerifiedAt: model.lastVerifiedAt,
        lastVerifiedKeyIndex: model.lastVerifiedKeyIndex,
        lastHealthStatus: model.lastHealthStatus,
        lastHealthError: model.lastHealthError,
        isPlaceholder: model.isPlaceholder ?? false,
      };
    });
  });
}

function groupFlatConfigs(configs) {
  const groups = new Map();
  for (const config of configs) {
    if (!isPlainObject(config)) continue;
    const groupKey = config.groupKey || deriveGroupKey(config.groupName, config.customUrl);
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        groupName: config.groupName,
        groupKey,
        source: config.source,
        customUrl: config.customUrl,
        apiKeys: Array.isArray(config.apiKeys) ? config.apiKeys.map(item => ({ ...item })) : [],
        enableKeyRotation: config.enableKeyRotation,
        models: [],
      };
      groups.set(groupKey, group);
    }
    group.models.push({
      name: config.name,
      customModel: config.customModel,
      currentKeyIndex: config.currentKeyIndex,
      categoryId: config.categoryId,
      categoryIds: Array.isArray(config.categoryIds) ? [...config.categoryIds] : undefined,
      isActive: config.isActive,
      lastVerifiedAt: config.lastVerifiedAt,
      lastVerifiedKeyIndex: config.lastVerifiedKeyIndex,
      lastHealthStatus: config.lastHealthStatus,
      lastHealthError: config.lastHealthError,
      isPlaceholder: config.isPlaceholder,
    });
  }
  return { version: 2, format: GROUPED_FORMAT, groups: [...groups.values()] };
}

function findConfigArrayCandidates(value, maxDepth = 2, path = [], depth = 0, candidates = []) {
  if (!isPlainObject(value) || depth > maxDepth) return candidates;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (Array.isArray(child) && child.length > 0 && child.every(item => looksLikeApiConfig(item))) {
      candidates.push({ configs: child, path: nextPath });
      continue;
    }
    if (isPlainObject(child) && depth < maxDepth) {
      findConfigArrayCandidates(child, maxDepth, nextPath, depth + 1, candidates);
    }
  }
  return candidates;
}

function normalized(configs, shape, {
  embeddedCategories,
  candidatePath = null,
} = {}) {
  return { configs, embeddedCategories, shape, candidatePath };
}

function normalizeConfigStorageValue(value, nestedDepth = 0) {
  if (Array.isArray(value)) {
    return normalized(value, nestedDepth > 0 ? 'nested-json-array' : 'array');
  }

  if (typeof value === 'string' && nestedDepth < 2) {
    try {
      return normalizeConfigStorageValue(JSON.parse(value), nestedDepth + 1);
    } catch {
      return normalized(null, 'json-string');
    }
  }

  if (isPlainObject(value)) {
    const grouped = flattenGroupedConfigs(value);
    if (grouped !== null) {
      return normalized(grouped, GROUPED_FORMAT, { candidatePath: ['groups'] });
    }

    if (Array.isArray(value.configs)) {
      return normalized(value.configs, 'wrapper-configs', {
        embeddedCategories: Array.isArray(value.categories) ? value.categories : undefined,
        candidatePath: ['configs'],
      });
    }

    if (looksLikeApiConfig(value)) return normalized([value], 'single-config-object');

    const keys = Object.keys(value);
    if (
      keys.length > 0
      && keys.every(key => /^\d+$/u.test(key))
      && keys.every(key => looksLikeApiConfig(value[key]))
    ) {
      return normalized(
        [...keys].sort((left, right) => Number(left) - Number(right)).map(key => value[key]),
        'numeric-config-map',
      );
    }

    if (keys.length > 0 && keys.every(key => looksLikeApiConfig(value[key]))) {
      return normalized(keys.map(key => value[key]), 'named-config-map');
    }

    const candidates = findConfigArrayCandidates(value);
    if (candidates.length === 1) {
      return normalized(candidates[0].configs, 'generic-wrapper-configs', {
        candidatePath: candidates[0].path,
      });
    }

    if (value.$ttSyncBridge === 'redacted-v1') return normalized(null, 'bridge-redacted-marker');
    return normalized(null, candidates.length > 1 ? 'ambiguous-object' : 'object');
  }

  if (value === null) return normalized(null, 'null');
  return normalized(null, typeof value);
}

function parseConfigStorage(raw) {
  const parsed = parseManagedJson(CONFIGS_KEY, raw);
  const result = normalizeConfigStorageValue(parsed);
  if (!Array.isArray(result.configs)) {
    throw new TypeError(`${CONFIGS_KEY} has unsupported storage shape: ${result.shape}`);
  }
  return result;
}

function inspectConfigStorage(host) {
  const raw = host.localStorage.get(CONFIGS_KEY);
  if (raw === null) {
    return {
      shape: 'missing',
      readable: true,
      configCount: 0,
      embeddedCategories: false,
      candidatePath: null,
      objectFields: [],
    };
  }
  try {
    const parsed = parseManagedJson(CONFIGS_KEY, raw);
    const result = normalizeConfigStorageValue(parsed);
    return {
      shape: result.shape,
      readable: Array.isArray(result.configs),
      configCount: Array.isArray(result.configs) ? result.configs.length : null,
      embeddedCategories: Array.isArray(result.embeddedCategories),
      candidatePath: Array.isArray(result.candidatePath) ? result.candidatePath : null,
      objectFields: topLevelObjectFields(parsed),
    };
  } catch {
    return {
      shape: 'invalid-json',
      readable: false,
      configCount: null,
      embeddedCategories: false,
      candidatePath: null,
      objectFields: [],
    };
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
  let configStorageShape = 'missing';
  let embeddedCategories;

  for (const key of API_MANAGER_KEYS) {
    const raw = host.localStorage.get(key);
    if (raw === null) {
      entries[key] = undefined;
      continue;
    }
    if (key === CONFIGS_KEY) {
      const result = parseConfigStorage(raw);
      entries[key] = result.configs;
      configStorageShape = result.shape;
      embeddedCategories = result.embeddedCategories;
      continue;
    }
    entries[key] = parseManagedJson(key, raw);
  }

  if (entries[CATEGORIES_KEY] === undefined && Array.isArray(embeddedCategories)) {
    entries[CATEGORIES_KEY] = embeddedCategories;
  }

  return { entries, configStorageShape };
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

function configStorageNeedsCanonicalization(shape) {
  return !['array', GROUPED_FORMAT, 'missing'].includes(shape);
}

function configStorageValue(configs, currentShape) {
  return currentShape === GROUPED_FORMAT ? groupFlatConfigs(configs) : configs;
}

function sourceVersionForShape(shape) {
  return shape === GROUPED_FORMAT ? '2.1.1-storage' : '2.0.3-compatible-storage';
}

export const apiManagerAdapter = {
  id: 'api-manager-2',
  label: '💡API管理器',
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

  diagnose(host) {
    const storage = inspectConfigStorage(host);
    return {
      sourceVersion: sourceVersionForShape(storage.shape),
      configStorageShape: storage.shape,
      configStorageReadable: storage.readable,
      configCount: storage.configCount,
      embeddedCategories: storage.embeddedCategories,
      configStorageCandidatePath: storage.candidatePath,
      configStorageObjectFields: storage.objectFields,
    };
  },

  async capture(host, { includeSensitive = false, sensitiveCodec } = {}) {
    if (!targetAvailable(host)) {
      return {
        available: false,
        sourceVersion: 'unknown',
        payload: null,
        diagnostics: { excludedPaths: [] },
      };
    }
    if (includeSensitive && !sensitiveCodec?.encrypt) {
      throw new Error('An encryption passphrase is required for API Manager sensitive sync');
    }

    const entries = {};
    const excludedPaths = [];
    let configs;
    let embeddedCategories;
    let configStorageShape = 'missing';

    for (const key of API_MANAGER_KEYS) {
      const path = `$.entries.${key}`;
      const raw = host.localStorage.get(key);
      if (DEVICE_ONLY_KEYS.has(key) || raw === null) {
        entries[key] = redactedValue();
        excludedPaths.push(path);
        continue;
      }
      if (key === CONFIGS_KEY) {
        const result = parseConfigStorage(raw);
        configs = result.configs;
        embeddedCategories = result.embeddedCategories;
        configStorageShape = result.shape;
        entries[key] = redactedValue();
        excludedPaths.push(path);
        continue;
      }
      const parsed = parseManagedJson(key, raw);
      const redacted = redactClone(parsed, { sensitiveKeyPatterns: SENSITIVE_KEY_PATTERNS });
      entries[key] = redacted.value;
      excludedPaths.push(...redacted.redactions.map(item => `${path}${item.path.slice(1)}`));
    }

    if (isRedacted(entries[CATEGORIES_KEY]) && Array.isArray(embeddedCategories)) {
      entries[CATEGORIES_KEY] = clone(embeddedCategories);
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
      sourceVersion: sourceVersionForShape(configStorageShape),
      payload,
      diagnostics: { excludedPaths, configStorageShape },
    };
  },

  async preview(host, payload, { sensitiveCodec } = {}) {
    validatePayload(payload);
    const incomingEntries = await unlockedEntries(payload, sensitiveCodec);
    if (incomingEntries === null) return { status: 'locked', reason: 'passphrase-required' };
    if (!targetAvailable(host)) return { status: 'missing-target' };
    if (!hasAnyStoredValue(host)) return { status: 'empty-target' };
    const current = parseCurrentEntries(host);
    const restored = buildRestoredEntries(current.entries, incomingEntries);
    const equal = entriesEqual(current.entries, restored);
    return {
      status: equal && !configStorageNeedsCanonicalization(current.configStorageShape) ? 'noop' : 'would-change',
    };
  },

  async restore(host, payload, { sensitiveCodec } = {}) {
    validatePayload(payload);
    const incomingEntries = await unlockedEntries(payload, sensitiveCodec);
    if (incomingEntries === null) return { status: 'locked', reason: 'passphrase-required' };
    if (!targetAvailable(host)) return { status: 'missing-target' };

    const current = parseCurrentEntries(host);
    const restored = buildRestoredEntries(current.entries, incomingEntries);
    const needsCanonicalization = configStorageNeedsCanonicalization(current.configStorageShape);
    if (entriesEqual(current.entries, restored) && !needsCanonicalization) return { status: 'noop' };

    for (const key of API_MANAGER_KEYS) {
      if (restored[key] === undefined) continue;
      const sameValue = current.entries[key] !== undefined
        && canonicalJson(current.entries[key]) === canonicalJson(restored[key]);
      if (sameValue && !(key === CONFIGS_KEY && needsCanonicalization)) continue;

      const storageValue = key === CONFIGS_KEY
        ? configStorageValue(restored[key], current.configStorageShape)
        : restored[key];
      host.localStorage.set(key, JSON.stringify(storageValue));
    }
    return { status: 'applied' };
  },
};
