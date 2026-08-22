import test from 'node:test';
import assert from 'node:assert/strict';

import { apiManagerAdapter } from '../src/adapters/api-manager-adapter.js';
import {
  databaseAdapter,
  DATABASE_SETTINGS_KEY,
  DATABASE_SETTINGS_ROOT,
} from '../src/adapters/database-adapter.js';
import { dreamCardAgentAdapter, DREAM_SETTINGS_KEY } from '../src/adapters/dream-card-agent-adapter.js';
import { stChatu8Adapter, ST_CHATU8_SETTINGS_KEY } from '../src/adapters/st-chatu8-adapter.js';
import {
  TARGET_TAVERN_SCRIPTS,
  tavernHelperScriptsAdapter,
  TAVERN_HELPER_SETTINGS_KEY,
} from '../src/adapters/tavern-helper-scripts-adapter.js';
import { BridgeController } from '../src/core/bridge-controller.js';
import { createMemoryHost } from './helpers/memory-host.js';

const adapters = [
  tavernHelperScriptsAdapter,
  databaseAdapter,
  apiManagerAdapter,
  dreamCardAgentAdapter,
  stChatu8Adapter,
];

class MemorySnapshotStore {
  constructor() { this.values = new Map(); }
  async getSnapshot(id) { return this.values.get(id) ?? null; }
  async putSnapshot(snapshot) { this.values.set(snapshot.adapterId, structuredClone(snapshot)); }
}

class MemoryLocalState {
  constructor() { this.values = new Map(); }
  getAdapterState(id) { return structuredClone(this.values.get(id) ?? {}); }
  setAdapterState(id, patch) {
    this.values.set(id, { ...this.getAdapterState(id), ...structuredClone(patch) });
  }
}

function scriptRecord(target) {
  return {
    type: 'script',
    enabled: true,
    id: target.id,
    name: target.name,
    content: `console.log(${JSON.stringify(target.id)})`,
    info: '',
    button: { enabled: true, buttons: [] },
    data: {},
    export_with: { data: true, button: true },
  };
}

function sourceHost() {
  return createMemoryHost({
    extensionSettings: {
      [TAVERN_HELPER_SETTINGS_KEY]: {
        script: { scripts: TARGET_TAVERN_SCRIPTS.map(scriptRecord) },
      },
      [DATABASE_SETTINGS_ROOT]: {
        [DATABASE_SETTINGS_KEY]: {
          shujuku_v104_globalMeta_v1: '{"revision":1}',
          shujuku_v104_profile_v1____default____settings: '{"enabled":true}',
          shujuku_v104_profile_v1____default____template: '{"template":"mine"}',
          shujuku_v104_templatePresets_v1: '[{"name":"mine"}]',
          shujuku_v104_windowStates: '{"left":123}',
        },
      },
      [DREAM_SETTINGS_KEY]: {
        version: 4,
        activeAgentConfigurationId: 'agent-1',
        providers: [{ id: 'provider-1', model: 'model-a', apiKey: 'source-secret' }],
        agentConfigurations: [{ id: 'agent-1', providerId: 'provider-1' }],
        globalSkills: { polish: { prompt: 'polish' } },
        floatingButtonOffset: { x: 1, y: 2 },
        syncRevision: 9,
      },
      [ST_CHATU8_SETTINGS_KEY]: {
        mode: 'novelai',
        theme_id: 'theme-a',
        ai_token: 'source-token',
        personaProfiles: { p1: { id: 'p1', prompt: 'persona' } },
        workerid: 'source-worker',
      },
    },
    localStorage: {
      api_configs_manager: JSON.stringify([
        { id: 'api-1', name: 'Primary', model: 'model-a', api_key: 'source-key' },
      ]),
      api_configs_categories: JSON.stringify([{ id: 'cat-1', name: 'Main' }]),
      api_configs_collapsed_categories: JSON.stringify(['cat-1']),
      api_configs_category_switch_indexes: JSON.stringify({ 'cat-1': 0 }),
      st_api_manager_sync_metadata_v1: JSON.stringify({ revision: 10 }),
      st_api_manager_debug_modal: JSON.stringify({ open: true }),
    },
    pluginVersions: {
      'third-party/JS-Slash-Runner': '4.8.19',
      'third-party/st-chatu8': '2.8.1',
    },
    indexedDb: {
      chatu8_gallery: {
        tags: [
          { name: 'portable-tag', translation: 'portable', hot: 5, fileName: 'manual' },
          { name: 'installed-source', translation: 'excluded', hot: 0, fileName: 'tags.json' },
        ],
      },
    },
  });
}

function cleanTargetHost() {
  const host = createMemoryHost({
    pluginVersions: {
      'third-party/JS-Slash-Runner': '4.8.19',
      'third-party/st-chatu8': '2.8.1',
    },
    indexedDb: {
      chatu8_gallery: {
        tags: [{ name: 'installed-target', translation: 'keep', hot: 0, fileName: 'tags.json' }],
      },
    },
  });
  host.hasTavernScript = id => {
    const trees = host.inspect().extensionSettings[TAVERN_HELPER_SETTINGS_KEY]?.script?.scripts ?? [];
    return trees.some(tree => tree.id === id || tree.scripts?.some(script => script.id === id));
  };
  return host;
}

function controller(host, snapshotStore, deviceId) {
  return new BridgeController({
    adapters,
    snapshotStore,
    localState: new MemoryLocalState(),
    host,
    deviceId,
    now: () => '2026-08-22T12:00:00.000Z',
  });
}

test('all adapters complete an A to B roundtrip without syncing credentials or duplicating scripts', async () => {
  const snapshotStore = new MemorySnapshotStore();
  const sourceController = controller(sourceHost(), snapshotStore, 'device-a');

  const captured = await sourceController.captureAll(adapters.map(adapter => adapter.id));
  assert.deepEqual(captured.map(result => result.status), adapters.map(() => 'captured'));
  const sourceHashes = Object.fromEntries(
    [...snapshotStore.values].map(([id, snapshot]) => [id, snapshot.nonSensitiveHash]),
  );

  const target = cleanTargetHost();
  const targetController = controller(target, snapshotStore, 'device-b');
  const restored = await targetController.restoreAll(adapters.map(adapter => adapter.id), { automatic: true });
  assert.deepEqual(restored.map(result => result.status), adapters.map(() => 'applied'));

  const targetState = target.inspect();
  const scripts = targetState.extensionSettings[TAVERN_HELPER_SETTINGS_KEY].script.scripts;
  assert.deepEqual(scripts.map(script => script.id).sort(), TARGET_TAVERN_SCRIPTS.map(item => item.id).sort());
  assert.equal(new Set(scripts.map(script => script.id)).size, 3);
  assert.equal(Object.hasOwn(JSON.parse(targetState.localStorage.api_configs_manager)[0], 'api_key'), false);
  assert.equal(Object.hasOwn(targetState.extensionSettings[DREAM_SETTINGS_KEY].providers[0], 'apiKey'), false);
  assert.equal(Object.hasOwn(targetState.extensionSettings[ST_CHATU8_SETTINGS_KEY], 'ai_token'), false);
  assert.deepEqual(targetState.indexedDb.chatu8_gallery.tags, [
    { name: 'installed-target', translation: 'keep', hot: 0, fileName: 'tags.json' },
    { name: 'portable-tag', translation: 'portable', hot: 5, fileName: 'manual' },
  ]);

  const apiConfigs = JSON.parse(target.localStorage.get('api_configs_manager'));
  apiConfigs[0].api_key = 'device-b-secret';
  target.localStorage.set('api_configs_manager', JSON.stringify(apiConfigs));
  const dream = target.extensionSettings.get(DREAM_SETTINGS_KEY);
  dream.providers[0].apiKey = 'device-b-secret';
  target.extensionSettings.set(DREAM_SETTINGS_KEY, dream);
  const chatu8 = target.extensionSettings.get(ST_CHATU8_SETTINGS_KEY);
  chatu8.ai_token = 'device-b-secret';
  target.extensionSettings.set(ST_CHATU8_SETTINGS_KEY, chatu8);

  const repeated = await targetController.restoreAll(adapters.map(adapter => adapter.id));
  assert.deepEqual(repeated.map(result => result.status), adapters.map(() => 'noop'));
  assert.equal(target.inspect().extensionSettings[TAVERN_HELPER_SETTINGS_KEY].script.scripts.length, 3);

  const recaptured = await targetController.captureAll(adapters.map(adapter => adapter.id));
  assert.deepEqual(recaptured.map(result => result.status), adapters.map(() => 'unchanged'));
  assert.deepEqual(
    Object.fromEntries([...snapshotStore.values].map(([id, snapshot]) => [id, snapshot.nonSensitiveHash])),
    sourceHashes,
  );
});
