import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TARGET_TAVERN_SCRIPTS,
  TAVERN_HELPER_SETTINGS_KEY,
  tavernHelperScriptsAdapter,
} from '../src/adapters/tavern-helper-scripts-adapter.js';
import { createPassphraseSensitiveCodec } from '../src/core/sensitive-envelope.js';
import { createMemoryHost } from './helpers/memory-host.js';

const [DATABASE_SCRIPT, API_SCRIPT, DREAM_SCRIPT] = TARGET_TAVERN_SCRIPTS;
const codec = () => createPassphraseSensitiveCodec('tavern helper portable passphrase');

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

function folder(id, name, scripts, extra = {}) {
  return { type: 'folder', enabled: true, name, id, icon: 'fa-folder', color: '#fff', scripts, ...extra };
}

function hostWithScripts(scripts, version = '4.9.3') {
  return createMemoryHost({
    extensionSettings: {
      [TAVERN_HELPER_SETTINGS_KEY]: {
        script: { enabled: { global: true, presets: [], characters: [] }, scripts },
      },
    },
    pluginVersions: { 'third-party/JS-Slash-Runner': version },
  });
}

async function encryptedCapture(host) {
  const sensitiveCodec = codec();
  const captured = await tavernHelperScriptsAdapter.capture(host, {
    includeSensitive: true,
    sensitiveCodec,
  });
  return { captured, sensitiveCodec };
}

test('full Tavern Helper capture requires encryption instead of exposing arbitrary script source', async () => {
  const host = hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'console.log("db")'),
    script('custom-id', 'My custom script', 'const hidden = "plain-custom-body";'),
  ]);

  const result = await tavernHelperScriptsAdapter.capture(host);

  assert.equal(result.status, 'deferred');
  assert.equal(result.reason, 'full-script-sync-requires-encryption');
  assert.equal(result.payload, null);
});

test('encrypted capture includes every global script while public payload contains no script bodies', async () => {
  const host = hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'db-body'),
    folder('folder-1', 'Utilities', [
      script(API_SCRIPT.id, API_SCRIPT.name, 'const key = "sk-abcdefghijklmnopqrstuvwxyz";'),
      script('other-id', 'Other helper', 'other-body'),
    ]),
    script(DREAM_SCRIPT.id, DREAM_SCRIPT.name, 'dream-body'),
  ]);
  const { captured } = await encryptedCapture(host);
  const serialized = JSON.stringify(captured.payload);

  assert.equal(captured.payload.dataVersion, 2);
  assert.equal(captured.payload.encryptedTrees.$ttSyncBridge, 'encrypted-v1');
  assert.equal(captured.diagnostics.globalScriptCount, 4);
  assert.equal(serialized.includes('db-body'), false);
  assert.equal(serialized.includes('sk-abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(serialized.includes('other-body'), false);
  assert.equal(serialized.includes('dream-body'), false);
  assert.deepEqual(
    captured.payload.trees.flatMap(entry => entry.type === 'folder' ? entry.scripts.map(item => item.name) : [entry.name]),
    [DATABASE_SCRIPT.name, API_SCRIPT.name, 'Other helper', DREAM_SCRIPT.name],
  );
});

test('full restore matches the same UUID across different folders and preserves target-only scripts', async () => {
  const source = hostWithScripts([
    folder('source-folder', 'Source Folder', [
      script(API_SCRIPT.id, API_SCRIPT.name, 'source-api'),
      script('source-new-id', 'Source only', 'source-new'),
    ]),
  ]);
  const { captured, sensitiveCodec } = await encryptedCapture(source);
  const target = hostWithScripts([
    folder('target-folder', 'Target Folder', [
      script(API_SCRIPT.id, API_SCRIPT.name, 'old-api'),
      script('target-only-id', 'Target only', 'keep-me'),
    ]),
  ]);

  const first = await tavernHelperScriptsAdapter.restore(target, captured.payload, { sensitiveCodec });
  const second = await tavernHelperScriptsAdapter.restore(target, captured.payload, { sensitiveCodec });
  const trees = target.inspect().extensionSettings[TAVERN_HELPER_SETTINGS_KEY].script.scripts;
  const targetFolder = trees.find(entry => entry.id === 'target-folder');
  const sourceFolder = trees.find(entry => entry.name === 'Source Folder');

  assert.equal(first.status, 'applied');
  assert.equal(second.status, 'noop');
  assert.equal(targetFolder.scripts.find(item => item.id === API_SCRIPT.id).content, 'source-api');
  assert.equal(targetFolder.scripts.find(item => item.id === 'target-only-id').content, 'keep-me');
  assert.equal(sourceFolder.scripts.length, 1);
  assert.equal(sourceFolder.scripts[0].id, 'source-new-id');
  assert.equal(trees.flatMap(entry => entry.type === 'folder' ? entry.scripts : [entry]).filter(item => item.id === API_SCRIPT.id).length, 1);
});

test('guarded scripts match aliases after UUID regeneration without creating a duplicate', async () => {
  const source = hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'source-db'),
    script(API_SCRIPT.id, API_SCRIPT.name, 'source-api'),
    script(DREAM_SCRIPT.id, DREAM_SCRIPT.name, 'source-dream'),
  ]);
  const { captured, sensitiveCodec } = await encryptedCapture(source);
  const target = hostWithScripts([
    script('target-db-id', DATABASE_SCRIPT.name, 'target-db'),
    script('target-api-id', API_SCRIPT.name, 'target-api'),
    script('target-dream-id', '梦境创客', 'target-dream'),
  ]);

  const result = await tavernHelperScriptsAdapter.restore(target, captured.payload, { sensitiveCodec });
  const scripts = target.inspect().extensionSettings[TAVERN_HELPER_SETTINGS_KEY].script.scripts;

  assert.equal(result.status, 'applied');
  assert.deepEqual(scripts.map(item => item.id), ['target-db-id', 'target-api-id', 'target-dream-id']);
  assert.deepEqual(scripts.map(item => item.content), ['source-db', 'source-api', 'source-dream']);
});

test('preview marks an identical partial target as safe when restore only adds missing scripts', async () => {
  const complete = [
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'shared-db'),
    script(API_SCRIPT.id, API_SCRIPT.name, 'shared-api'),
    script(DREAM_SCRIPT.id, DREAM_SCRIPT.name, 'shared-dream'),
  ];
  const { captured, sensitiveCodec } = await encryptedCapture(hostWithScripts(complete));
  const target = hostWithScripts([complete[0]]);

  const preview = await tavernHelperScriptsAdapter.preview(target, captured.payload, { sensitiveCodec });

  assert.equal(preview.status, 'would-change');
  assert.equal(preview.safeToApply, true);
});

test('full restore writes through Tavern Helper authoritative API', async () => {
  const { captured, sensitiveCodec } = await encryptedCapture(hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'source-db'),
    script(API_SCRIPT.id, API_SCRIPT.name, 'source-api'),
  ], '4.8.19'));
  const target = hostWithScripts([script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'source-db')], '4.8.19');
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
      return { available: true, trees: structuredClone(trees) };
    },
  };

  const result = await tavernHelperScriptsAdapter.restore(target, captured.payload, { sensitiveCodec });

  assert.equal(result.status, 'applied');
  assert.equal(replaceCount, 1);
  assert.deepEqual(authoritativeTrees.map(item => item.id), [DATABASE_SCRIPT.id, API_SCRIPT.id]);
});

test('restore defers without raw settings writes while Tavern Helper public API is not ready', async () => {
  const { captured, sensitiveCodec } = await encryptedCapture(hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'source-db'),
    script(API_SCRIPT.id, API_SCRIPT.name, 'source-api'),
  ]));
  const target = hostWithScripts([script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'source-db')]);
  target.tavernHelperScripts = {
    get: () => ({ available: false, trees: [] }),
    replace: () => { throw new Error('must not write before API initialization'); },
  };
  const before = target.inspect();

  const result = await tavernHelperScriptsAdapter.restore(target, captured.payload, { sensitiveCodec });

  assert.deepEqual(result, { status: 'deferred', reason: 'tavern-helper-script-api-not-ready' });
  assert.deepEqual(target.inspect().extensionSettings, before.extensionSettings);
  assert.equal(target.inspect().saveCount, 0);
});

test('guarded duplicate names produce a hard logical-target conflict', async () => {
  const { captured, sensitiveCodec } = await encryptedCapture(hostWithScripts([
    script(API_SCRIPT.id, API_SCRIPT.name, 'source-api'),
  ]));
  const target = hostWithScripts([
    script('duplicate-1', API_SCRIPT.name, 'one'),
    script('duplicate-2', API_SCRIPT.name, 'two'),
  ]);

  const preview = await tavernHelperScriptsAdapter.preview(target, captured.payload, { sensitiveCodec });
  const restored = await tavernHelperScriptsAdapter.restore(target, captured.payload, { sensitiveCodec });

  assert.equal(preview.status, 'conflict');
  assert.equal(restored.status, 'conflict');
  assert.equal(restored.conflicts[0].reason, 'ambiguous-logical-target');
  assert.equal(target.inspect().saveCount, 0);
});

test('diagnostics expose only structural Tavern Helper coverage', async () => {
  const host = hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'must-not-appear-in-diagnostics'),
    { type: 'mobile-unknown-node', id: 'shape-only' },
  ]);

  const probe = await tavernHelperScriptsAdapter.diagnose(host);
  const serialized = JSON.stringify(probe);

  assert.equal(probe.pluginVersion, '4.9.3');
  assert.equal(probe.globalScriptCount, 1);
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
