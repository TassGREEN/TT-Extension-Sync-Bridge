import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TARGET_TAVERN_SCRIPTS,
  TAVERN_HELPER_SETTINGS_KEY,
  tavernHelperScriptsAdapter,
} from '../src/adapters/tavern-helper-scripts-adapter.js';
import { createMemoryHost } from './helpers/memory-host.js';

const [DATABASE_SCRIPT, API_SCRIPT, DREAM_SCRIPT] = TARGET_TAVERN_SCRIPTS;

function script(id, name, content, extra = {}) {
  return {
    type: 'script',
    enabled: true,
    name,
    id,
    content,
    info: '',
    button: { enabled: true, buttons: [] },
    data: {},
    export_with: { data: true, button: true },
    ...extra,
  };
}

function folder(id, name, scripts) {
  return { type: 'folder', enabled: true, name, id, icon: 'fa-folder', color: '#fff', scripts };
}

function hostWithScripts(scripts, version = '4.8.12') {
  return createMemoryHost({
    extensionSettings: {
      [TAVERN_HELPER_SETTINGS_KEY]: {
        script: { enabled: { global: true, presets: [], characters: [] }, scripts },
      },
    },
    pluginVersions: { 'third-party/JS-Slash-Runner': version },
  });
}

test('script adapter captures only the three guarded logical targets with complete records', async () => {
  const database = script(DATABASE_SCRIPT.id, '用户重命名的数据库', 'console.log("db")');
  const api = script(API_SCRIPT.id, API_SCRIPT.name, 'console.log("api")', { data: { apiKey: 'secret', theme: 'dark' } });
  const dream = script(DREAM_SCRIPT.id, DREAM_SCRIPT.name, 'console.log("dream")');
  const unrelated = script('other-id', 'Other', 'console.log("other")');
  const host = hostWithScripts([database, folder('folder-1', 'Folder', [api, unrelated]), dream]);

  const result = await tavernHelperScriptsAdapter.capture(host);

  assert.equal(result.available, true);
  assert.deepEqual(result.payload.records.map(item => item.targetKey), [
    DATABASE_SCRIPT.key,
    API_SCRIPT.key,
    DREAM_SCRIPT.key,
  ]);
  assert.deepEqual(result.payload.records.map(item => item.record.id), [
    DATABASE_SCRIPT.id,
    API_SCRIPT.id,
    DREAM_SCRIPT.id,
  ]);
  assert.equal(result.payload.records[0].record.name, '用户重命名的数据库');
  assert.equal(result.payload.records[1].path.kind, 'folder');
  assert.equal(result.payload.records[1].path.folderId, 'folder-1');
  assert.equal(result.payload.records[1].record.data.theme, 'dark');
  assert.equal(JSON.stringify(result.payload).includes('secret'), false);
});

test('script adapter recognizes imported scripts after Tavern Helper regenerates UUIDs', async () => {
  const host = hostWithScripts([
    script('local-db-uuid', DATABASE_SCRIPT.name, 'db'),
    script('local-api-uuid', API_SCRIPT.name, 'api'),
    script('local-dream-uuid', '梦境创客', 'dream'),
  ], '4.9.3');

  const captured = await tavernHelperScriptsAdapter.capture(host);
  const probe = await tavernHelperScriptsAdapter.diagnose(host);

  assert.deepEqual(captured.payload.records.map(item => item.targetKey), [
    DATABASE_SCRIPT.key,
    API_SCRIPT.key,
    DREAM_SCRIPT.key,
  ]);
  assert.deepEqual(captured.payload.records.map(item => item.record.id), [
    'local-db-uuid',
    'local-api-uuid',
    'local-dream-uuid',
  ]);
  assert.deepEqual(probe.foundTargetIds, ['local-db-uuid', 'local-api-uuid', 'local-dream-uuid']);
  assert.deepEqual(probe.missingTargetIds, []);
});

test('script restore replaces matching IDs in place and is idempotent', async () => {
  const source = hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'source-db'),
    folder('folder-1', 'Folder', [script(API_SCRIPT.id, API_SCRIPT.name, 'source-api')]),
    script(DREAM_SCRIPT.id, DREAM_SCRIPT.name, 'source-dream'),
  ]);
  const captured = await tavernHelperScriptsAdapter.capture(source);
  const target = hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'old-db'),
    folder('target-folder', 'Target Folder', [script(API_SCRIPT.id, API_SCRIPT.name, 'old-api')]),
    script(DREAM_SCRIPT.id, DREAM_SCRIPT.name, 'old-dream'),
  ]);

  const first = await tavernHelperScriptsAdapter.restore(target, captured.payload);
  const second = await tavernHelperScriptsAdapter.restore(target, captured.payload);
  const trees = target.inspect().extensionSettings[TAVERN_HELPER_SETTINGS_KEY].script.scripts;

  assert.equal(first.status, 'applied');
  assert.equal(second.status, 'noop');
  assert.equal(trees[0].content, 'source-db');
  assert.equal(trees[1].id, 'target-folder');
  assert.equal(trees[1].scripts[0].content, 'source-api');
  assert.equal(trees[2].content, 'source-dream');
  assert.equal(target.inspect().saveCount, 1);
});

test('script restore writes through Tavern Helper authoritative store so its watcher cannot erase restored scripts', async () => {
  const source = hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'source-db'),
    script(API_SCRIPT.id, API_SCRIPT.name, 'source-api'),
    script(DREAM_SCRIPT.id, DREAM_SCRIPT.name, 'source-dream'),
  ], '4.8.19');
  const captured = await tavernHelperScriptsAdapter.capture(source);
  const target = hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'mobile-db'),
  ], '4.8.19');
  let authoritativeTrees = target.inspect().extensionSettings[TAVERN_HELPER_SETTINGS_KEY].script.scripts;
  let replaceCount = 0;
  target.tavernHelperScripts = {
    get() {
      return { available: true, trees: structuredClone(authoritativeTrees) };
    },
    replace(trees) {
      replaceCount += 1;
      authoritativeTrees = structuredClone(trees);
      const settings = target.extensionSettings.get(TAVERN_HELPER_SETTINGS_KEY);
      settings.script.scripts = structuredClone(trees);
      target.extensionSettings.set(TAVERN_HELPER_SETTINGS_KEY, settings);
      return { available: true };
    },
  };

  const result = await tavernHelperScriptsAdapter.restore(target, captured.payload);
  const watcherWrite = target.extensionSettings.get(TAVERN_HELPER_SETTINGS_KEY);
  watcherWrite.script.scripts = structuredClone(authoritativeTrees);
  target.extensionSettings.set(TAVERN_HELPER_SETTINGS_KEY, watcherWrite);

  assert.equal(result.status, 'applied');
  assert.equal(replaceCount, 1);
  assert.deepEqual(
    target.inspect().extensionSettings[TAVERN_HELPER_SETTINGS_KEY].script.scripts.map(item => item.id),
    [DATABASE_SCRIPT.id, API_SCRIPT.id, DREAM_SCRIPT.id],
  );
});

test('script restore matches logical targets by name across regenerated IDs and preserves local IDs', async () => {
  const source = hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'source-db'),
    script(API_SCRIPT.id, API_SCRIPT.name, 'source-api'),
    script(DREAM_SCRIPT.id, DREAM_SCRIPT.name, 'source-dream'),
  ]);
  const captured = await tavernHelperScriptsAdapter.capture(source);
  const target = hostWithScripts([
    script('target-db-id', DATABASE_SCRIPT.name, 'target-db'),
    script('target-api-id', API_SCRIPT.name, 'target-api'),
    script('target-dream-id', '梦境创客', 'target-dream'),
  ]);

  const preview = await tavernHelperScriptsAdapter.preview(target, captured.payload);
  const restored = await tavernHelperScriptsAdapter.restore(target, captured.payload);
  const trees = target.inspect().extensionSettings[TAVERN_HELPER_SETTINGS_KEY].script.scripts;

  assert.equal(preview.status, 'would-change');
  assert.equal(restored.status, 'applied');
  assert.deepEqual(trees.map(item => item.id), ['target-db-id', 'target-api-id', 'target-dream-id']);
  assert.deepEqual(trees.map(item => item.content), ['source-db', 'source-api', 'source-dream']);
});

test('script restore defers without raw settings writes while Tavern Helper public API is not ready', async () => {
  const source = hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'source-db'),
    script(API_SCRIPT.id, API_SCRIPT.name, 'source-api'),
    script(DREAM_SCRIPT.id, DREAM_SCRIPT.name, 'source-dream'),
  ], '4.8.19');
  const captured = await tavernHelperScriptsAdapter.capture(source);
  const target = hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'mobile-db'),
  ], '4.8.19');
  target.tavernHelperScripts = {
    get: () => ({ available: false, trees: [] }),
    replace: () => { throw new Error('must not write before API initialization'); },
  };
  const before = target.inspect();

  const result = await tavernHelperScriptsAdapter.restore(target, captured.payload);

  assert.deepEqual(result, {
    status: 'deferred',
    reason: 'tavern-helper-script-api-not-ready',
  });
  assert.deepEqual(target.inspect().extensionSettings, before.extensionSettings);
  assert.equal(target.inspect().saveCount, 0);
});

test('script restore reports ambiguous duplicate logical targets without writing', async () => {
  const source = hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'source-db'),
    script(API_SCRIPT.id, API_SCRIPT.name, 'source-api'),
    script(DREAM_SCRIPT.id, DREAM_SCRIPT.name, 'source-dream'),
  ]);
  const captured = await tavernHelperScriptsAdapter.capture(source);
  const target = hostWithScripts([
    script('duplicate-1', API_SCRIPT.name, 'one'),
    script('duplicate-2', API_SCRIPT.name, 'two'),
  ]);

  const preview = await tavernHelperScriptsAdapter.preview(target, captured.payload);
  const restored = await tavernHelperScriptsAdapter.restore(target, captured.payload);

  assert.equal(preview.status, 'conflict');
  assert.equal(restored.status, 'conflict');
  assert.equal(restored.conflicts[0].reason, 'ambiguous-logical-target');
  assert.equal(target.inspect().saveCount, 0);
});

test('script capture rejects likely embedded credentials without reporting the value', async () => {
  const host = hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'console.log("db")'),
    script(API_SCRIPT.id, API_SCRIPT.name, 'const apiKey = "sk-abcdefghijklmnopqrstuvwxyz";'),
    script(DREAM_SCRIPT.id, DREAM_SCRIPT.name, 'console.log("dream")'),
  ]);

  await assert.rejects(() => tavernHelperScriptsAdapter.capture(host), /embedded credential.*API管理器/i);
});

test('script capture defers an incomplete target set instead of publishing a partial payload', async () => {
  const host = hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'console.log("db")'),
  ]);

  const result = await tavernHelperScriptsAdapter.capture(host);

  assert.equal(result.status, 'deferred');
  assert.equal(result.reason, 'target-scripts-not-fully-initialized');
  assert.equal(result.payload, null);
  assert.deepEqual(result.diagnostics.missingScriptIds, [API_SCRIPT.id, DREAM_SCRIPT.id]);
});

test('script adapter exposes a content-free structural probe for mobile diagnostics', async () => {
  const host = hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'must-not-appear-in-diagnostics'),
    { type: 'mobile-unknown-node', id: 'shape-only' },
  ]);

  const probe = await tavernHelperScriptsAdapter.diagnose(host);
  const serialized = JSON.stringify(probe);

  assert.equal(probe.pluginVersion, '4.8.12');
  assert.equal(probe.settingsPresent, true);
  assert.equal(probe.scriptTreePresent, true);
  assert.deepEqual(probe.tree, {
    rootEntryCount: 2,
    rootScriptCount: 1,
    folderCount: 0,
    folderScriptCount: 0,
    unsupportedEntryCount: 1,
  });
  assert.deepEqual(probe.foundTargetIds, [DATABASE_SCRIPT.id]);
  assert.deepEqual(probe.missingTargetIds, [API_SCRIPT.id, DREAM_SCRIPT.id]);
  assert.equal(serialized.includes('must-not-appear-in-diagnostics'), false);
});
