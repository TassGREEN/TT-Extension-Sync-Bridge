import { canonicalJson } from '../core/canonical-json.js';
import { mergeRedacted, redactClone } from '../core/redaction.js';

export const TAVERN_HELPER_SETTINGS_KEY = 'tavern_helper';
const PLUGIN_ID = 'third-party/JS-Slash-Runner';
const SUPPORTED_VERSION = /^4\./;

export const TARGET_TAVERN_SCRIPTS = Object.freeze([
  Object.freeze({ id: '8e1213cb-732a-444b-8a80-631e1cf614b5', name: '蚀心入魔·数据库' }),
  Object.freeze({ id: '9dce28ae-a88e-45c6-a211-f5980602de51', name: '💡API管理器2.0.3' }),
  Object.freeze({ id: '41179c00-7593-4cf5-b32b-4d6bb3a6b0c2', name: '梦境创客（TokenRhythm代理修复）' }),
]);

const TARGET_BY_ID = new Map(TARGET_TAVERN_SCRIPTS.map(item => [item.id, item]));
const SENSITIVE_DATA_KEY_PATTERNS = [
  /^api[_-]?key$/i,
  /token/i,
  /secret/i,
  /pass(word)?/i,
  /auth/i,
  /credential/i,
  /cookie/i,
];
const EMBEDDED_CREDENTIAL_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~-]{20,}/i,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function supported(version) {
  return typeof version === 'string' && SUPPORTED_VERSION.test(version);
}

function getTrees(settings) {
  return settings?.script?.scripts;
}

function collectLocations(trees) {
  const locations = [];
  if (!Array.isArray(trees)) return locations;
  trees.forEach((tree, treeIndex) => {
    if (tree?.type === 'script') {
      locations.push({ record: tree, path: { kind: 'root', treeIndex } });
      return;
    }
    if (tree?.type === 'folder' && Array.isArray(tree.scripts)) {
      tree.scripts.forEach((record, scriptIndex) => {
        if (record?.type === 'script') {
          locations.push({
            record,
            path: { kind: 'folder', treeIndex, scriptIndex, folderId: tree.id },
          });
        }
      });
    }
  });
  return locations;
}

function hasLikelyEmbeddedCredential(content) {
  return typeof content === 'string' && EMBEDDED_CREDENTIAL_PATTERNS.some(pattern => pattern.test(content));
}

function validatePayload(payload) {
  if (!isPlainObject(payload) || payload.dataVersion !== 1 || !Array.isArray(payload.records)) {
    throw new TypeError('Tavern Helper scripts payload is invalid');
  }
  if (!supported(payload.pluginVersion)) {
    throw new Error(`Unsupported Tavern Helper snapshot version ${String(payload.pluginVersion)}`);
  }
  const seen = new Set();
  for (const item of payload.records) {
    const id = item?.record?.id;
    if (!TARGET_BY_ID.has(id) || item.record.type !== 'script' || seen.has(id)) {
      throw new TypeError('Tavern Helper scripts payload contains an invalid or duplicate script');
    }
    seen.add(id);
  }
}

function findConflicts(trees, payload) {
  const locations = collectLocations(trees);
  const conflicts = [];
  for (const incoming of payload.records) {
    const expected = TARGET_BY_ID.get(incoming.record.id);
    const names = new Set([incoming.record.name, expected.name]);
    const conflict = locations.find(location => (
      location.record.id !== incoming.record.id && names.has(location.record.name)
    ));
    if (conflict) {
      conflicts.push({
        scriptId: incoming.record.id,
        name: incoming.record.name,
        conflictingId: conflict.record.id,
        reason: 'same-name-different-id',
      });
    }
  }
  return conflicts;
}

function applyRecords(trees, records) {
  const output = JSON.parse(JSON.stringify(Array.isArray(trees) ? trees : []));
  for (const incoming of records) {
    const locations = collectLocations(output);
    const existing = locations.find(location => location.record.id === incoming.record.id);
    if (!existing) {
      const restored = mergeRedacted(undefined, incoming.record, {
        preserveLocalKeyPatterns: SENSITIVE_DATA_KEY_PATTERNS,
      });
      output.push(restored);
      continue;
    }
    const restored = mergeRedacted(existing.record, incoming.record, {
      preserveLocalKeyPatterns: SENSITIVE_DATA_KEY_PATTERNS,
    });
    if (existing.path.kind === 'root') {
      output[existing.path.treeIndex] = restored;
    } else {
      output[existing.path.treeIndex].scripts[existing.path.scriptIndex] = restored;
    }
  }
  return output;
}

function canSafelyCompletePartialSet(trees, payload) {
  const incomingById = new Map(payload.records.map(item => [item.record.id, item.record]));
  const currentTargets = collectLocations(trees).filter(location => incomingById.has(location.record.id));
  const currentIds = new Set(currentTargets.map(location => location.record.id));
  if (currentTargets.length === 0 || currentTargets.length !== currentIds.size || currentTargets.length >= payload.records.length) {
    return false;
  }
  return currentTargets.every(location => {
    const merged = mergeRedacted(location.record, incomingById.get(location.record.id), {
      preserveLocalKeyPatterns: SENSITIVE_DATA_KEY_PATTERNS,
    });
    return canonicalJson(location.record) === canonicalJson(merged);
  });
}

export const tavernHelperScriptsAdapter = {
  id: 'tavern-helper-global-scripts',
  label: '酒馆助手全局脚本',
  version: 1,

  async capture(host, { includeSensitive = false } = {}) {
    const settings = host.extensionSettings.get(TAVERN_HELPER_SETTINGS_KEY);
    const pluginVersion = host.pluginVersion(PLUGIN_ID);
    if (!isPlainObject(settings) && pluginVersion === null) {
      return { available: false, sourceVersion: null, payload: null, diagnostics: { missingScriptIds: [] } };
    }
    if (!supported(pluginVersion)) {
      throw new Error(`Unsupported Tavern Helper version ${String(pluginVersion)}`);
    }
    const locations = collectLocations(getTrees(settings));
    const records = [];
    const missingScriptIds = [];
    for (const target of TARGET_TAVERN_SCRIPTS) {
      const found = locations.find(location => location.record.id === target.id);
      if (!found) {
        missingScriptIds.push(target.id);
        continue;
      }
      if (hasLikelyEmbeddedCredential(found.record.content)) {
        throw new Error(`Embedded credential detected in ${target.name}; capture refused`);
      }
      const redacted = redactClone(found.record, {
        includeSensitive,
        sensitiveKeyPatterns: SENSITIVE_DATA_KEY_PATTERNS,
      });
      records.push({ record: redacted.value, path: found.path });
    }
    if (missingScriptIds.length > 0) {
      return {
        available: true,
        status: 'deferred',
        reason: 'target-scripts-not-fully-initialized',
        sourceVersion: pluginVersion,
        payload: null,
        diagnostics: { missingScriptIds },
      };
    }
    const payload = { dataVersion: 1, pluginVersion, records };
    validatePayload(payload);
    return {
      available: true,
      sourceVersion: pluginVersion,
      payload,
      diagnostics: { missingScriptIds },
    };
  },

  async preview(host, payload) {
    validatePayload(payload);
    const settings = host.extensionSettings.get(TAVERN_HELPER_SETTINGS_KEY);
    const targetVersion = host.pluginVersion(PLUGIN_ID);
    if (!isPlainObject(settings) && targetVersion === null) return { status: 'missing-target' };
    if (!supported(targetVersion)) {
      return { status: 'incompatible', message: `Target Tavern Helper version ${String(targetVersion)} is not supported` };
    }
    if (!isPlainObject(settings)) return { status: 'empty-target' };
    const trees = getTrees(settings) ?? [];
    const conflicts = findConflicts(trees, payload);
    if (conflicts.length > 0) return { status: 'conflict', conflicts };
    const restored = applyRecords(trees, payload.records);
    if (canonicalJson(trees) === canonicalJson(restored)) return { status: 'noop' };
    return {
      status: 'would-change',
      ...(canSafelyCompletePartialSet(trees, payload) ? { safeToApply: true } : {}),
    };
  },

  async restore(host, payload) {
    validatePayload(payload);
    const settings = host.extensionSettings.get(TAVERN_HELPER_SETTINGS_KEY);
    const targetVersion = host.pluginVersion(PLUGIN_ID);
    if (!isPlainObject(settings) && targetVersion === null) return { status: 'missing-target' };
    if (!supported(targetVersion)) {
      return { status: 'incompatible', message: `Target Tavern Helper version ${String(targetVersion)} is not supported` };
    }
    const currentSettings = isPlainObject(settings) ? settings : {};
    const trees = getTrees(currentSettings) ?? [];
    const conflicts = findConflicts(trees, payload);
    if (conflicts.length > 0) return { status: 'conflict', conflicts };
    const restoredTrees = applyRecords(trees, payload.records);
    if (canonicalJson(trees) === canonicalJson(restoredTrees)) return { status: 'noop' };
    const nextSettings = JSON.parse(JSON.stringify(currentSettings));
    nextSettings.script ??= {};
    nextSettings.script.scripts = restoredTrees;
    host.extensionSettings.set(TAVERN_HELPER_SETTINGS_KEY, nextSettings);
    await host.saveSettings();
    return { status: 'applied' };
  },
};
