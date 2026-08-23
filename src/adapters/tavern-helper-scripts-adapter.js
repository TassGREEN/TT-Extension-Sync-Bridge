import { canonicalJson } from '../core/canonical-json.js';
import { mergeRedacted, redactClone, redactedValue } from '../core/redaction.js';
import { isEncryptedEnvelope } from '../core/sensitive-envelope.js';

export const TAVERN_HELPER_SETTINGS_KEY = 'tavern_helper';
const PLUGIN_ID = 'third-party/JS-Slash-Runner';
const SUPPORTED_VERSION = /^4\./;
const SENSITIVE_CONTEXT = 'tavern-helper/global-scripts/v1';

export const TARGET_TAVERN_SCRIPTS = Object.freeze([
  Object.freeze({ key: 'database', id: '8e1213cb-732a-444b-8a80-631e1cf614b5', name: '蚀心入魔·数据库', aliases: Object.freeze(['蚀心入魔·数据库']) }),
  Object.freeze({ key: 'api-manager', id: '9dce28ae-a88e-45c6-a211-f5980602de51', name: '💡API管理器2.0.3', aliases: Object.freeze(['💡API管理器2.0.3']) }),
  Object.freeze({ key: 'dream-card-agent', id: '41179c00-7593-4cf5-b32b-4d6bb3a6b0c2', name: '梦境创客（TokenRhythm代理修复）', aliases: Object.freeze(['梦境创客（TokenRhythm代理修复）', '梦境创客']) }),
]);
const TARGET_BY_ID = new Map(TARGET_TAVERN_SCRIPTS.map(item => [item.id, item]));
const TARGET_BY_KEY = new Map(TARGET_TAVERN_SCRIPTS.map(item => [item.key, item]));
const SENSITIVE_DATA_KEY_PATTERNS = [/^api[_-]?key$/i, /token/i, /secret/i, /pass(word)?/i, /auth/i, /credential/i, /cookie/i];
const EMBEDDED_CREDENTIAL_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~-]{20,}/i,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function isPlainObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function supported(version) { return typeof version === 'string' && SUPPORTED_VERSION.test(version); }
function getTrees(settings) { return settings?.script?.scripts; }

function readScriptTrees(host, settings) {
  if (typeof host.tavernHelperScripts?.get === 'function') {
    const result = host.tavernHelperScripts.get();
    if (result?.available && Array.isArray(result.trees)) return { available: true, authoritative: true, trees: result.trees };
    return { available: false, authoritative: true, trees: [] };
  }
  return { available: true, authoritative: false, trees: getTrees(settings) ?? [] };
}

function collectLocations(trees) {
  const locations = [];
  if (!Array.isArray(trees)) return locations;
  trees.forEach((tree, treeIndex) => {
    if (tree?.type === 'script') locations.push({ record: tree, path: { kind: 'root', treeIndex } });
    else if (tree?.type === 'folder' && Array.isArray(tree.scripts)) {
      tree.scripts.forEach((record, scriptIndex) => {
        if (record?.type === 'script') locations.push({ record, path: { kind: 'folder', treeIndex, scriptIndex, folderId: tree.id } });
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
    if (entry?.type === 'script') rootScriptCount += 1;
    else if (entry?.type === 'folder' && Array.isArray(entry.scripts)) {
      folderCount += 1;
      folderScriptCount += entry.scripts.filter(record => record?.type === 'script').length;
    } else unsupportedEntryCount += 1;
  }
  return { rootEntryCount: entries.length, rootScriptCount, folderCount, folderScriptCount, unsupportedEntryCount };
}

function hasLikelyEmbeddedCredential(content) {
  return typeof content === 'string' && EMBEDDED_CREDENTIAL_PATTERNS.some(pattern => pattern.test(content));
}
function scriptsWithEmbeddedCredentials(trees) {
  return collectLocations(trees).filter(location => hasLikelyEmbeddedCredential(location.record.content));
}
function scriptCount(trees) { return collectLocations(trees).length; }

function validateTreeEntry(entry, where) {
  if (!isPlainObject(entry) || typeof entry.id !== 'string' || entry.id === '' || typeof entry.name !== 'string') {
    throw new TypeError(`Tavern Helper ${where} entry is invalid`);
  }
  if (entry.type === 'script') return;
  if (entry.type !== 'folder' || !Array.isArray(entry.scripts)) throw new TypeError(`Tavern Helper ${where} contains an unsupported entry`);
  for (const script of entry.scripts) {
    if (!isPlainObject(script) || script.type !== 'script' || typeof script.id !== 'string' || script.id === '' || typeof script.name !== 'string') {
      throw new TypeError(`Tavern Helper folder ${entry.name} contains an invalid script`);
    }
  }
}

function duplicateNames(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) { if (seen.has(value)) duplicates.add(value); else seen.add(value); }
  return [...duplicates];
}
function validateLogicalUniqueness(trees, label) {
  const rootScripts = trees.filter(entry => entry?.type === 'script');
  const folders = trees.filter(entry => entry?.type === 'folder');
  const duplicateRootScripts = duplicateNames(rootScripts.map(entry => entry.name));
  const duplicateFolders = duplicateNames(folders.map(entry => entry.name));
  if (duplicateRootScripts.length) throw new Error(`${label} has duplicate root script names: ${duplicateRootScripts.join(', ')}`);
  if (duplicateFolders.length) throw new Error(`${label} has duplicate folder names: ${duplicateFolders.join(', ')}`);
  for (const folder of folders) {
    const duplicateScripts = duplicateNames(folder.scripts.map(script => script.name));
    if (duplicateScripts.length) throw new Error(`${label} folder ${folder.name} has duplicate script names: ${duplicateScripts.join(', ')}`);
  }
}

function validateFullPayload(payload) {
  if (!isPlainObject(payload) || payload.dataVersion !== 2 || !Array.isArray(payload.trees)) throw new TypeError('Tavern Helper full scripts payload is invalid');
  if (!supported(payload.pluginVersion)) throw new Error(`Unsupported Tavern Helper snapshot version ${String(payload.pluginVersion)}`);
  for (const entry of payload.trees) validateTreeEntry(entry, 'snapshot');
  validateLogicalUniqueness(payload.trees, 'Tavern Helper snapshot');
  if (payload.encryptedTrees !== undefined && !isEncryptedEnvelope(payload.encryptedTrees)) throw new TypeError('Tavern Helper encrypted script tree payload is invalid');
  return payload;
}

function targetNames(target, incomingRecord = null) {
  return new Set([target.name, ...(target.aliases ?? []), typeof incomingRecord?.name === 'string' ? incomingRecord.name : null].filter(Boolean));
}
function targetFromLegacyRecord(record) {
  const byId = TARGET_BY_ID.get(record?.id);
  if (byId) return byId;
  const matches = TARGET_TAVERN_SCRIPTS.filter(target => targetNames(target).has(record?.name));
  return matches.length === 1 ? matches[0] : null;
}
function normalizeLegacyPayload(payload) {
  if (!isPlainObject(payload) || payload.dataVersion !== 1 || !Array.isArray(payload.records)) throw new TypeError('Tavern Helper scripts payload is invalid');
  if (!supported(payload.pluginVersion)) throw new Error(`Unsupported Tavern Helper snapshot version ${String(payload.pluginVersion)}`);
  const seenKeys = new Set();
  const seenIds = new Set();
  const records = payload.records.map(item => {
    const record = item?.record;
    const target = TARGET_BY_KEY.get(item?.targetKey) ?? targetFromLegacyRecord(record);
    if (!target || record?.type !== 'script' || typeof record.id !== 'string' || !record.id || seenKeys.has(target.key) || seenIds.has(record.id)) {
      throw new TypeError('Tavern Helper scripts payload contains an invalid or duplicate logical target');
    }
    seenKeys.add(target.key); seenIds.add(record.id);
    return { ...item, targetKey: target.key, target };
  });
  const missingTargets = TARGET_TAVERN_SCRIPTS.filter(target => !seenKeys.has(target.key));
  if (missingTargets.length > 0 || seenKeys.size !== TARGET_TAVERN_SCRIPTS.length) {
    throw new TypeError(`Tavern Helper scripts snapshot is incomplete; recapture on a source device with all guarded scripts present (missing ${missingTargets.length})`);
  }
  return { ...payload, records };
}
function parsePayload(payload) { return payload?.dataVersion === 2 ? { kind: 'full', payload: validateFullPayload(payload) } : { kind: 'legacy', payload: normalizeLegacyPayload(payload) }; }

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
function legacyConflicts(trees, payload) {
  const locations = collectLocations(trees);
  const conflicts = [];
  for (const incoming of payload.records) {
    const resolution = resolveTargetLocation(locations, incoming.target, incoming.record);
    if (resolution?.ambiguous) conflicts.push({ targetKey: incoming.target.key, name: incoming.target.name, conflictingIds: resolution.ambiguous.map(item => item.record.id), reason: 'ambiguous-logical-target' });
  }
  return conflicts;
}
function applyLegacyRecords(trees, records) {
  const output = clone(Array.isArray(trees) ? trees : []);
  for (const incoming of records) {
    const locations = collectLocations(output);
    const resolution = resolveTargetLocation(locations, incoming.target, incoming.record);
    const existing = resolution?.location;
    if (!existing) {
      output.push(mergeRedacted(undefined, incoming.record, { preserveLocalKeyPatterns: SENSITIVE_DATA_KEY_PATTERNS }));
      continue;
    }
    const restored = mergeRedacted(existing.record, incoming.record, { preserveLocalKeyPatterns: SENSITIVE_DATA_KEY_PATTERNS });
    restored.id = existing.record.id;
    if (existing.path.kind === 'root') output[existing.path.treeIndex] = restored;
    else output[existing.path.treeIndex].scripts[existing.path.scriptIndex] = restored;
  }
  return output;
}

function redactedTreeForEncrypted(trees) {
  const redacted = redactClone(trees, { sensitiveKeyPatterns: SENSITIVE_DATA_KEY_PATTERNS }).value;
  for (const location of collectLocations(redacted)) location.record.content = redactedValue();
  return redacted;
}
async function unlockedFullTrees(payload, sensitiveCodec) {
  if (payload.encryptedTrees === undefined) return payload.trees;
  if (!sensitiveCodec?.decrypt) return null;
  const sensitive = await sensitiveCodec.decrypt(payload.encryptedTrees, SENSITIVE_CONTEXT);
  if (!isPlainObject(sensitive) || !Array.isArray(sensitive.trees)) throw new TypeError('Tavern Helper decrypted script tree payload is invalid');
  for (const entry of sensitive.trees) validateTreeEntry(entry, 'decrypted snapshot');
  validateLogicalUniqueness(sensitive.trees, 'Tavern Helper decrypted snapshot');
  return sensitive.trees;
}

function sameNameMatches(entries, type, name) {
  return entries.map((entry, index) => ({ entry, index })).filter(item => item.entry?.type === type && item.entry.name === name);
}
function fullTreeConflicts(targetTrees, sourceTrees) {
  const conflicts = [];
  for (const source of sourceTrees) {
    if (source.type === 'script') {
      const matches = sameNameMatches(targetTrees, 'script', source.name);
      if (matches.length > 1) conflicts.push({ reason: 'duplicate-root-script', name: source.name, conflictingIds: matches.map(item => item.entry.id) });
      continue;
    }
    const folderMatches = sameNameMatches(targetTrees, 'folder', source.name);
    if (folderMatches.length > 1) {
      conflicts.push({ reason: 'duplicate-folder', name: source.name, conflictingIds: folderMatches.map(item => item.entry.id) });
      continue;
    }
    if (folderMatches.length === 1) {
      const targetFolder = folderMatches[0].entry;
      for (const sourceScript of source.scripts) {
        const scriptMatches = targetFolder.scripts.map((script, index) => ({ script, index })).filter(item => item.script?.type === 'script' && item.script.name === sourceScript.name);
        if (scriptMatches.length > 1) conflicts.push({ reason: 'duplicate-folder-script', folder: source.name, name: sourceScript.name, conflictingIds: scriptMatches.map(item => item.script.id) });
      }
    }
  }
  return conflicts;
}
function mergeScript(existing, incoming) {
  if (!existing) return clone(incoming);
  const restored = mergeRedacted(existing, incoming, { preserveLocalKeyPatterns: SENSITIVE_DATA_KEY_PATTERNS });
  restored.id = existing.id;
  return restored;
}
function mergeFolder(existing, incoming) {
  if (!existing) return clone(incoming);
  const restored = mergeRedacted(existing, incoming, { preserveLocalKeyPatterns: SENSITIVE_DATA_KEY_PATTERNS });
  restored.id = existing.id;
  const scripts = clone(existing.scripts ?? []);
  for (const sourceScript of incoming.scripts) {
    const matches = scripts.map((script, index) => ({ script, index })).filter(item => item.script?.type === 'script' && item.script.name === sourceScript.name);
    if (matches.length === 1) scripts[matches[0].index] = mergeScript(matches[0].script, sourceScript);
    else if (matches.length === 0) scripts.push(clone(sourceScript));
  }
  restored.scripts = scripts;
  return restored;
}
function mergeFullTrees(targetTrees, sourceTrees) {
  const output = clone(Array.isArray(targetTrees) ? targetTrees : []);
  for (const source of sourceTrees) {
    const matches = sameNameMatches(output, source.type, source.name);
    if (matches.length === 1) output[matches[0].index] = source.type === 'script' ? mergeScript(matches[0].entry, source) : mergeFolder(matches[0].entry, source);
    else if (matches.length === 0) output.push(clone(source));
  }
  return output;
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
      if (resolution?.location && !resolution?.ambiguous) foundTargetIds.push(resolution.location.record.id);
      else missingTargetIds.push(target.id);
    }
    return {
      pluginVersion,
      pluginVersionSupported: supported(pluginVersion),
      authoritativeApiAvailable: source.available && source.authoritative,
      settingsPresent: isPlainObject(settings),
      scriptTreePresent: Array.isArray(trees),
      tree: structuralProbe(trees),
      globalScriptCount: scriptCount(trees),
      foundTargetIds,
      missingTargetIds,
    };
  },

  async capture(host, { includeSensitive = false, sensitiveCodec } = {}) {
    const settings = host.extensionSettings.get(TAVERN_HELPER_SETTINGS_KEY);
    const pluginVersion = host.pluginVersion(PLUGIN_ID);
    if (!isPlainObject(settings) && pluginVersion === null) return { available: false, sourceVersion: null, payload: null, diagnostics: { missingScriptIds: [] } };
    if (!supported(pluginVersion)) throw new Error(`Unsupported Tavern Helper version ${String(pluginVersion)}`);
    const source = readScriptTrees(host, settings);
    if (!source.available) return { available: true, status: 'deferred', reason: 'tavern-helper-script-api-not-ready', sourceVersion: pluginVersion, payload: null, diagnostics: { missingScriptIds: [] } };
    for (const entry of source.trees) validateTreeEntry(entry, 'source');
    validateLogicalUniqueness(source.trees, 'Tavern Helper source');
    const embeddedCredentialScripts = scriptsWithEmbeddedCredentials(source.trees);
    if (includeSensitive && !sensitiveCodec?.encrypt) throw new Error('An encryption passphrase is required for Tavern Helper full script sync');
    if (!includeSensitive && embeddedCredentialScripts.length > 0) {
      return { available: true, status: 'deferred', reason: 'sensitive-script-content-requires-encryption', sourceVersion: pluginVersion, payload: null, diagnostics: { embeddedCredentialScriptCount: embeddedCredentialScripts.length } };
    }
    const publicTrees = includeSensitive ? redactedTreeForEncrypted(source.trees) : redactClone(source.trees, { sensitiveKeyPatterns: SENSITIVE_DATA_KEY_PATTERNS }).value;
    const payload = {
      dataVersion: 2,
      pluginVersion,
      trees: publicTrees,
      ...(includeSensitive ? { encryptedTrees: await sensitiveCodec.encrypt({ trees: clone(source.trees) }, SENSITIVE_CONTEXT) } : {}),
    };
    validateFullPayload(payload);
    return { available: true, sourceVersion: pluginVersion, payload, diagnostics: { missingScriptIds: [], globalScriptCount: scriptCount(source.trees), embeddedCredentialScriptCount: embeddedCredentialScripts.length } };
  },

  async preview(host, rawPayload, { sensitiveCodec } = {}) {
    const parsed = parsePayload(rawPayload);
    const settings = host.extensionSettings.get(TAVERN_HELPER_SETTINGS_KEY);
    const targetVersion = host.pluginVersion(PLUGIN_ID);
    if (!isPlainObject(settings) && targetVersion === null) return { status: 'missing-target' };
    if (!supported(targetVersion)) return { status: 'incompatible', message: `Target Tavern Helper version ${String(targetVersion)} is not supported` };
    if (!isPlainObject(settings)) return { status: 'empty-target' };
    const source = readScriptTrees(host, settings);
    if (!source.available) return { status: 'deferred', reason: 'tavern-helper-script-api-not-ready' };
    const trees = source.trees;
    if (parsed.kind === 'legacy') {
      const conflicts = legacyConflicts(trees, parsed.payload);
      if (conflicts.length > 0) return { status: 'conflict', conflicts };
      return { status: canonicalJson(trees) === canonicalJson(applyLegacyRecords(trees, parsed.payload.records)) ? 'noop' : 'would-change' };
    }
    const incomingTrees = await unlockedFullTrees(parsed.payload, sensitiveCodec);
    if (incomingTrees === null) return { status: 'locked', reason: 'passphrase-required' };
    const conflicts = fullTreeConflicts(trees, incomingTrees);
    if (conflicts.length > 0) return { status: 'conflict', conflicts };
    return { status: canonicalJson(trees) === canonicalJson(mergeFullTrees(trees, incomingTrees)) ? 'noop' : 'would-change' };
  },

  async restore(host, rawPayload, { sensitiveCodec } = {}) {
    const parsed = parsePayload(rawPayload);
    const settings = host.extensionSettings.get(TAVERN_HELPER_SETTINGS_KEY);
    const targetVersion = host.pluginVersion(PLUGIN_ID);
    if (!isPlainObject(settings) && targetVersion === null) return { status: 'missing-target' };
    if (!supported(targetVersion)) return { status: 'incompatible', message: `Target Tavern Helper version ${String(targetVersion)} is not supported` };
    const currentSettings = isPlainObject(settings) ? settings : {};
    const source = readScriptTrees(host, currentSettings);
    if (!source.available) return { status: 'deferred', reason: 'tavern-helper-script-api-not-ready' };
    const trees = source.trees;
    let restoredTrees;
    if (parsed.kind === 'legacy') {
      const conflicts = legacyConflicts(trees, parsed.payload);
      if (conflicts.length > 0) return { status: 'conflict', conflicts };
      restoredTrees = applyLegacyRecords(trees, parsed.payload.records);
    } else {
      const incomingTrees = await unlockedFullTrees(parsed.payload, sensitiveCodec);
      if (incomingTrees === null) return { status: 'locked', reason: 'passphrase-required' };
      const conflicts = fullTreeConflicts(trees, incomingTrees);
      if (conflicts.length > 0) return { status: 'conflict', conflicts };
      restoredTrees = mergeFullTrees(trees, incomingTrees);
    }
    if (canonicalJson(trees) === canonicalJson(restoredTrees)) return { status: 'noop' };
    if (source.authoritative) {
      const result = host.tavernHelperScripts.replace(restoredTrees);
      if (!result?.available) return { status: 'deferred', reason: 'tavern-helper-script-api-not-ready' };
    } else {
      const nextSettings = clone(currentSettings);
      nextSettings.script ??= {};
      nextSettings.script.scripts = restoredTrees;
      host.extensionSettings.set(TAVERN_HELPER_SETTINGS_KEY, nextSettings);
      await host.saveSettings();
    }
    return { status: 'applied' };
  },
};
