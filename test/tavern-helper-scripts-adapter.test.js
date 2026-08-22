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

test('script adapter captures only the three stable IDs with complete records', async () => {
  const database = script(DATABASE_SCRIPT.id, '用户重命名的数据库', 'console.log("db")');
  const api = script(API_SCRIPT.id, API_SCRIPT.name, 'console.log("api")', { data: { apiKey: 'secret', theme: 'dark' } });
  const dream = script(DREAM_SCRIPT.id, DREAM_SCRIPT.name, 'console.log("dream")');
  const unrelated = script('other-id', 'Other', 'console.log("other")');
  const host = hostWithScripts([database, folder('folder-1', 'Folder', [api, unrelated]), dream]);

  const result = await tavernHelperScriptsAdapter.capture(host);

  assert.equal(result.available, true);
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

test('script restore reports same-name different-ID conflicts without writing', async () => {
  const source = hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'source-db'),
    script(API_SCRIPT.id, API_SCRIPT.name, 'source-api'),
    script(DREAM_SCRIPT.id, DREAM_SCRIPT.name, 'source-dream'),
  ]);
  const captured = await tavernHelperScriptsAdapter.capture(source);
  const target = hostWithScripts([script('different-id', DATABASE_SCRIPT.name, 'target-db')]);

  const preview = await tavernHelperScriptsAdapter.preview(target, captured.payload);
  const restored = await tavernHelperScriptsAdapter.restore(target, captured.payload);

  assert.equal(preview.status, 'conflict');
  assert.equal(restored.status, 'conflict');
  assert.equal(restored.conflicts[0].reason, 'same-name-different-id');
  assert.equal(target.inspect().saveCount, 0);
  assert.equal(
    target.inspect().extensionSettings[TAVERN_HELPER_SETTINGS_KEY].script.scripts[0].id,
    'different-id',
  );
});

test('script capture rejects likely embedded credentials without reporting the value', async () => {
  const host = hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'console.log("db")'),
    script(API_SCRIPT.id, API_SCRIPT.name, 'const apiKey = "sk-abcdefghijklmnopqrstuvwxyz";'),
    script(DREAM_SCRIPT.id, DREAM_SCRIPT.name, 'console.log("dream")'),
  ]);

  await assert.rejects(() => tavernHelperScriptsAdapter.capture(host), /embedded credential.*API管理器/i);
});

test('script capture refuses an incomplete target set instead of replacing a complete snapshot', async () => {
  const host = hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'console.log("db")'),
  ]);

  await assert.rejects(
    () => tavernHelperScriptsAdapter.capture(host),
    /target scripts are not fully initialized/i,
  );
});
