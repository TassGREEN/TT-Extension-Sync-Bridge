import test from 'node:test';
import assert from 'node:assert/strict';

import { createBrowserHost, loadPluginVersions } from '../src/host/browser-host.js';

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
  const values = new Map();
  let saved = 0;
  const host = createBrowserHost({
    extensionSettings,
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key),
    },
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
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
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
