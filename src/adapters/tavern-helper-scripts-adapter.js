import { canonicalJson } from '../core/canonical-json.js';
import { mergeRedacted, redactClone } from '../core/redaction.js';

export const TAVERN_HELPER_SETTINGS_KEY = 'tavern_helper';
const PLUGIN_ID = 'third-party/JS-Slash-Runner';
const SUPPORTED_VERSION = /^4\./;

export const TARGET_TAVERN_SCRIPTS = Object.freeze([
  Object.freeze({
    key: 'database',
    id: '8e1213cb-732a-444b-8a80-631e1cf614b5',
    name: '蚀心入魔·数据库',
    aliases: Object.freeze(['蚀心入魔·数据库']),
  }),
  Object.freeze({
    key: 'api-manager',
    id: '9dce28ae-a88e-45c6-a211-f5980602de51',
    name: '💡API管理器2.0.3',
    aliases: Object.freeze(['💡API管理器2.0.3']),
  }),
  Object.freeze({
    key: 'dream-card-agent',
    id: '41179c00-7593-4cf5-b32b-4d6bb3a6b0c2',
    name: '梦境创客（TokenRhythm代理修复）',
    aliases: Object.freeze(['梦境创客（TokenRhythm代理修复）', '梦境创客']),
  }),
]);

const TARGET_BY_ID = new Map(TARGET_TAVERN_SCRIPTS.map(item => [item.id, item]));
const TARGET_BY_KEY = new Map(TARGET_TAVERN_SCRIPTS.map(item => [item.key, item]));
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

function readScriptTrees(host, settings) {
  if (typeof host.tavernHelperScripts?.get === 'function') {
    const result = host.tavernHelperScripts.get();
    if (result?.available && Array.isArray(result.trees)) {
      return { available: true, authoritative: true, trees: result.trees };
    }
    return { available: false, authoritative: true, trees: [] };
  }
  return { available: true, authoritative: false, trees: getTrees(settings) ?? [] };
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

function structuralProbe(trees) {
  const entries = Array.isArray(trees) ? trees : [];
  let rootScriptCount = 0;
  let folderCount = 0;
  let folderScriptCount = 0;
  let unsupportedEntryCount = 0;
  for (const entry of entries) {
    if (entry?.type === 'script') {
      rootScriptCount += 1;
    } else if (entry?.type === 'folder' && Array.isArray(entry.scripts)) {
      folderCount += 1;
      folderScriptCount += entry.scripts.filter(record => record?.type === 'script').length;
    } else {
      unsupportedEntryCount += 1;
    }
  }
  return {
    rootEntryCount: entries.length,
    rootScriptCount,
    folderCount,
    folderScriptCount,
    unsupportedEntryCount,
  };
}

function hasLikelyEmbeddedCredential(content) {
  return typeof content === 'string' && EMBEDDED_CREDENTIAL_PATTERNS.some(pattern => pattern.test(content));
}

function targetNames(target, incomingRecord = null) {
  return new Set([
    target.name,
    ...(target.aliases ?? []),
    typeof incomingRecord?.name === 'string' ? incomingRecord.name : null,
  ].filter(Boolean));
}

function targetFromLegacyRecord(record) {
  const byId = TARGET_BY_ID.get(record?.id);
  if (byId) return byId;
  const matches = TARGET_TAVERN_SCRIPTS.filter(target => targetNames(target).has(record?.name));
  return matches.length === 1 ? matches[0] : null;
}

function normalizePayload(payload) {
  if (!isPlainObject(payload) || payload.dataVersion !== 1 || !Array.isArray(payload.records)) {
    throw new TypeError('Tavern Helper scripts payload is invalid');
  }
  if (!supported(payload.pluginVersion)) {
    throw new Error(`Unsupported Tavern Helper snapshot version ${String(payload.pluginVersion)}`);
  }

  const seenKeys = new Set();
  const seenIds = new Set();
  const records = payload.records.map(item => {
    const record = item?.record;
    const target = TARGET_BY_KEY.get(item?.targetKey) ?? targetFromLegacyRecord(record);
    if (!target || record?.type !== 'script' || typeof record.id !== 'string' || !record.id || seenKeys.has(target.key) || seenIds.has(record.id)) {
      throw new TypeError('Tavern Helper scripts payload contains an invalid or duplicate logical target');
    }
    seenKeys.add(target.key);
    seenIds.add(record.id);
    return { ...item, targetKey: target.key, target };
  });

  const missingTargets = TARGET_TAVERN_SCRIPTS.filter(target => !seenKeys.has(target.key));
  if (missingTargets.length > 0 || seenKeys.size !== TARGET_TAVERN_SCRIPTS.length) {
    throw new TypeError(
      `Tavern Helper scripts snapshot is incomplete; recapture on a source device with all guarded scripts present (missing ${missingTargets.length})`,
    );
  }
  return { ...payload, records };
}

function resolveTargetLocation(locations, target, incomingRecord = null) {
  const candidateIds = new Set([target.id, incomingRecord?.id].filter(Boolean));
  const idMatches = locations.filter(location => candidateIds.has(location.record.id));
  if (idMatches.length === 1) return { location: idMatches[0], matchedBy: 'id' };
  if (idMatches.length > 1) return { ambiguous: idMatches, matchedBy: 'id' };

  const names = targetNames(target, incomingRecord);
  const nameMatches = locations.filter(location => names.has(location.record.name));
  if (nameMatches.length === 1) return { location: nameMatches[0], matchedBy: 'name' };
  if (nameMatches.length > 1) return { ambiguous: nameMatches, matchedBy: 'name' };
  return null;
}

function findConflicts(trees, payload) {
  const locations = collectLocations(trees);
  const conflicts = [];
  for (const incoming of payload.records) {
    const resolution = resolveTargetLocation(locations, incoming.target, incoming.record);
    if (resolution?.ambiguous) {
      conflicts.push({
        targetKey: incoming.target.key,
        name: incoming.target.name,
        conflictingIds: resolution.ambiguous.map(item => item.record.id),
        reason: 'ambiguous-logical-target',
      });
    }
  }
  return conflicts;
}

function applyRecords(trees, records) {
  const output = JSON.parse(JSON.stringify(Array.isArray(trees) ? trees : []));
  for (const incoming of records) {
    const locations = collectLocations(output);
    const resolution = resolveTargetLocation(locations, incoming.target, incoming.record);
    const existing = resolution?.location;
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
    restored.id = existing.record.id;
    if (existing.path.kind === 'root') {
      output[existing.path.treeIndex] = restored;
    } else {
      output[existing.path.treeIndex].scripts[existing.path.scriptIndex] = restored;
    }
  }
  return output;
}

function canSafelyCompletePartialSet(trees, payload) {
  const locations = collectLocations(trees);
  const current = payload.records
    .map(incoming => ({ incoming, resolution: resolveTargetLocation(locations, incoming.target, incoming.record) }))
    .filter(item => item.resolution?.location && !item.resolution?.ambiguous);
  if (current.length === 0 || current.length >= payload.records.length) return false;

  return current.every(({ incoming, resolution }) => {
    const existing = resolution.location.record;
    const merged = mergeRedacted(existing, incoming.record, {
      preserveLocalKeyPatterns: SENSITIVE_DATA_KEY_PATTERNS,
    });
    merged.id = existing.id;
    return canonicalJson(existing) === canonicalJson(merged);
  });
}

export const tavernHelperScriptsAdapter = {
  id: 'tavern-helper-global-scripts',
  label: '酒馆助手全局脚本',
  version: 1,

  async diagnose(host) {
    const settings = host.extensionSettings.get(TAVERN_HELPER_SETTINGS_KEY);
    const pluginVersion = host.pluginVersion(PLUGIN_ID);
    const source = readScriptTrees(host, settings);
    const trees = source.available ? source.trees : getTrees(settings);
    const locations = collectLocations(trees);
    const foundTargetIds = [];
    const missingTargetIds = [];
    for (const target of TARGET_TAVERN_SCRIPTS) {
      const resolution = resolveTargetLocation(locations, target);
      if (resolution?.location && !resolution?.ambiguous) {
        foundTargetIds.push(resolution.location.record.id);
      } else {
        missingTargetIds.push(target.id);
      }
    }
    return {
      pluginVersion,
      pluginVersionSupported: supported(pluginVersion),
      authoritativeApiAvailable: source.available && source.authoritative,
      settingsPresent: isPlainObject(settings),
      scriptTreePresent: Array.isArray(trees),
      tree: structuralProbe(trees),
      foundTargetIds,
      missingTargetIds,
    };
  },

  async capture(host, { includeSensitive = false } = {}) {
    const settings = host.extensionSettings.get(TAVERN_HELPER_SETTINGS_KEY);
    const pluginVersion = host.pluginVersion(PLUGIN_ID);
    if (!isPlainObject(settings) && pluginVersion === null) {
      return { available: false, sourceVersion: null, payload: null, diagnostics: { missingScriptIds: [] } };
    }
    if (!supported(pluginVersion)) {
      throw new Error(`Unsupported Tavern Helper version ${String(pluginVersion)}`);
    }
    const source = readScriptTrees(host, settings);
    if (!source.available) {
      return {
        available: true,
        status: 'deferred',
        reason: 'tavern-helper-script-api-not-ready',
        sourceVersion: pluginVersion,
        payload: null,
        diagnostics: { missingScriptIds: [] },
      };
    }

    const locations = collectLocations(source.trees);
    const records = [];
    const missingScriptIds = [];
    for (const target of TARGET_TAVERN_SCRIPTS) {
      const resolution = resolveTargetLocation(locations, target);
      if (resolution?.ambiguous) {
        throw new Error(`Multiple Tavern Helper scripts match guarded target ${target.name}; resolve duplicate names before capture`);
      }
      const found = resolution?.location;
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
      records.push({ targetKey: target.key, record: redacted.value, path: found.path });
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
    normalizePayload(payload);
    return {
      available: true,
      sourceVersion: pluginVersion,
      payload,
      diagnostics: { missingScriptIds },
    };
  },

  async preview(host, rawPayload) {
    const payload = normalizePayload(rawPayload);
    const settings = host.extensionSettings.get(TAVERN_HELPER_SETTINGS_KEY);
    const targetVersion = host.pluginVersion(PLUGIN_ID);
    if (!isPlainObject(settings) && targetVersion === null) return { status: 'missing-target' };
    if (!supported(targetVersion)) {
      return { status: 'incompatible', message: `Target Tavern Helper version ${String(targetVersion)} is not supported` };
    }
    if (!isPlainObject(settings)) return { status: 'empty-target' };
    const source = readScriptTrees(host, settings);
    if (!source.available) return { status: 'deferred', reason: 'tavern-helper-script-api-not-ready' };
    const trees = source.trees;
    const conflicts = findConflicts(trees, payload);
    if (conflicts.length > 0) return { status: 'conflict', conflicts };
    const restored = applyRecords(trees, payload.records);
    if (canonicalJson(trees) === canonicalJson(restored)) return { status: 'noop' };
    return {
      status: 'would-change',
      ...(canSafelyCompletePartialSet(trees, payload) ? { safeToApply: true } : {}),
    };
  },

  async restore(host, rawPayload) {
    const payload = normalizePayload(rawPayload);
    const settings = host.extensionSettings.get(TAVERN_HELPER_SETTINGS_KEY);
    const targetVersion = host.pluginVersion(PLUGIN_ID);
    if (!isPlainObject(settings) && targetVersion === null) return { status: 'missing-target' };
    if (!supported(targetVersion)) {
      return { status: 'incompatible', message: `Target Tavern Helper version ${String(targetVersion)} is not supported` };
    }
    const currentSettings = isPlainObject(settings) ? settings : {};
    const source = readScriptTrees(host, currentSettings);
    if (!source.available) return { status: 'deferred', reason: 'tavern-helper-script-api-not-ready' };
    const trees = source.trees;
    const conflicts = findConflicts(trees, payload);
    if (conflicts.length > 0) return { status: 'conflict', conflicts };
    const restoredTrees = applyRecords(trees, payload.records);
    if (canonicalJson(trees) === canonicalJson(restoredTrees)) return { status: 'noop' };
    if (source.authoritative) {
      const result = host.tavernHelperScripts.replace(restoredTrees);
      if (!result?.available) return { status: 'deferred', reason: 'tavern-helper-script-api-not-ready' };
    } else {
      const nextSettings = JSON.parse(JSON.stringify(currentSettings));
      nextSettings.script ??= {};
      nextSettings.script.scripts = restoredTrees;
      host.extensionSettings.set(TAVERN_HELPER_SETTINGS_KEY, nextSettings);
      await host.saveSettings();
    }
    return { status: 'applied' };
  },
};
