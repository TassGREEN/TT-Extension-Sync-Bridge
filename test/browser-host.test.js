import test from 'node:test';
import assert from 'node:assert/strict';

import { createBrowserHost, loadPluginVersions } from '../src/host/browser-host.js';

function memoryLocalStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
}

test('browser host exposes settings, persistence, versions, and nested Tavern Helper scripts', async () => {
  const extensionSettings = {
    tavern_helper: {
      script: {
        scripts: [
          {
            type: 'folder',
            id: 'folder',
            scripts: [{ type: 'script', id: 'script-in-folder', name: 'Nested' }],
          },
        ],
      },
    },
  };
  let saved = 0;
  const host = createBrowserHost({
    extensionSettings,
    localStorage: memoryLocalStorage(),
    pluginVersions: { 'third-party/JS-Slash-Runner': '4.8.12' },
    saveSettingsDebounced: () => { saved += 1; },
  });

  assert.equal(host.pluginVersion('third-party/JS-Slash-Runner'), '4.8.12');
  assert.equal(host.hasTavernScript('script-in-folder'), true);
  assert.equal(host.hasTavernScript('missing'), false);
  host.extensionSettings.set('example', { enabled: true });
  assert.deepEqual(host.extensionSettings.get('example'), { enabled: true });
  host.localStorage.set('key', 'value');
  assert.equal(host.localStorage.get('key'), 'value');
  await host.saveSettings();
  assert.equal(saved, 1);
});

test('browser host delegates Tavern Helper script reads and writes to its authoritative public API', async () => {
  const extensionSettings = {
    tavern_helper: { script: { scripts: [{ type: 'script', id: 'stale-script' }] } },
  };
  let authoritativeTrees = [{ type: 'script', id: 'authoritative-script' }];
  const calls = [];
  let immediateSaves = 0;
  const host = createBrowserHost({
    extensionSettings,
    localStorage: memoryLocalStorage(),
    pluginVersions: { 'third-party/JS-Slash-Runner': '4.8.19' },
    saveSettingsDebounced: () => {},
    saveSettingsImmediate: async () => { immediateSaves += 1; },
    tavernHelperProvider: () => ({
      getScriptTrees(option) {
        calls.push(['get', option]);
        return authoritativeTrees;
      },
      replaceScriptTrees(trees, option) {
        calls.push(['replace', option]);
        authoritativeTrees = trees;
      },
    }),
  });

  assert.deepEqual(host.tavernHelperScripts.get(), {
    available: true,
    trees: [{ type: 'script', id: 'authoritative-script' }],
  });
  const replaced = host.tavernHelperScripts.replace([{ type: 'script', id: 'restored-script' }]);
  assert.deepEqual(replaced, {
    available: true,
    trees: [{ type: 'script', id: 'restored-script' }],
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(immediateSaves, 1);
  assert.equal(host.hasTavernScript('restored-script'), true);
  assert.equal(host.hasTavernScript('stale-script'), false);
  assert.deepEqual(calls, [
    ['get', { type: 'global' }],
    ['replace', { type: 'global' }],
    ['get', { type: 'global' }],
    ['get', { type: 'global' }],
    ['get', { type: 'global' }],
  ]);
});

test('browser host user-file operations are restricted to safe Tavern file paths', async () => {
  const calls = [];
  const host = createBrowserHost({
    extensionSettings: {},
    localStorage: memoryLocalStorage(),
    pluginVersions: {},
    saveSettingsDebounced: () => {},
    runtimeGlobal: {
      SillyTavern: {
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-Test': 'bridge' }),
      },
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === '/user/files/existing.bin') {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => Uint8Array.from([4, 5, 6]).buffer,
        };
      }
      if (url === '/api/files/upload') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ path: '/user/files/portable.bin' }),
        };
      }
      if (url === '/api/files/delete') return { ok: true, status: 200 };
      throw new Error(`unexpected fetch: ${url}`);
    },
  });

  await assert.rejects(() => host.files.download('/api/files/private'), /only \/user\/files\//i);
  await assert.rejects(() => host.files.download('/user/files/../escape.bin'), /safe basename/i);
  await assert.rejects(() => host.files.download('/user/files/%2e%2e%2fescape.bin'), /safe basename/i);
  await assert.rejects(() => host.files.upload('../escape.bin', Uint8Array.from([1])), /safe basename/i);
  await assert.rejects(() => host.files.upload('%2e%2e%2fescape.bin', Uint8Array.from([1])), /safe basename/i);
  assert.deepEqual(Array.from(await host.files.download('/user/files/existing.bin')), [4, 5, 6]);
  assert.equal(await host.files.upload('portable.bin', Uint8Array.from([1, 2, 3])), '/user/files/portable.bin');
  await host.files.delete('/user/files/portable.bin');

  const upload = calls.find(call => call.url === '/api/files/upload');
  assert.deepEqual(JSON.parse(upload.options.body), { data: 'AQID', name: 'portable.bin' });
  assert.equal(upload.options.headers['X-Test'], 'bridge');
  const deletion = calls.find(call => call.url === '/api/files/delete');
  assert.deepEqual(JSON.parse(deletion.options.body), { path: '/user/files/portable.bin' });
});

test('browser host rejects an unsafe path returned by the upload endpoint', async () => {
  const host = createBrowserHost({
    extensionSettings: {},
    localStorage: memoryLocalStorage(),
    pluginVersions: {},
    saveSettingsDebounced: () => {},
    fetchImpl: async url => {
      if (url === '/api/files/upload') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ path: '/user/files/../escaped.bin' }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  });

  await assert.rejects(
    () => host.files.upload('portable.bin', Uint8Array.from([1])),
    /upload response is invalid/i,
  );
});

test('plugin version loader reads only manifest versions and tolerates missing plugins', async () => {
  const calls = [];
  const versions = await loadPluginVersions({
    pluginFolders: ['JS-Slash-Runner', 'missing'],
    fetchImpl: async url => {
      calls.push(url);
      if (url.includes('missing')) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ version: '4.8.12', display_name: 'ignored' }) };
    },
  });

  assert.deepEqual(versions, { 'third-party/JS-Slash-Runner': '4.8.12' });
  assert.equal(calls.length, 2);
});
