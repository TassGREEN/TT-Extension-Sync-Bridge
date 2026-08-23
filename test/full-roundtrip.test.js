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
import { createPassphraseSensitiveCodec } from '../src/core/sensitive-envelope.js';
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
        novelaiApi: 'source-novelai-key',
        novelaisite: 'https://novelai.source.private',
        personaProfiles: { p1: { id: 'p1', prompt: 'persona' } },
        workerid: 'source-worker',
      },
    },
    localStorage: {
      api_configs_manager: JSON.stringify([{
        name: '[Primary] model-a',
        source: 'custom',
        customUrl: 'https://api.source.private/v1',
        apiKeys: [{ id: 'key-1', key: 'source-key' }],
        currentKeyIndex: 0,
        enableKeyRotation: false,
        customModel: 'model-a',
        groupName: 'Primary',
        groupKey: 'primary-group',
        categoryIds: ['cat-1'],
        isActive: true,
      }]),
      api_configs_categories: JSON.stringify([{ id: 'cat-1', name: 'Main', color: '#ffffff', order: 0 }]),
      api_configs_collapsed_categories: JSON.stringify(['cat-1']),
      api_configs_category_switch_indexes: JSON.stringify({ 'cat-1': 0 }),
      stb_api_management_settings: JSON.stringify({ enabled: true, lockTavernConfig: true }),
    },
    pluginVersions: {
      'third-party/JS-Slash-Runner': '4.9.3',
      'third-party/st-chatu8': '2.8.4',
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
      'third-party/JS-Slash-Runner': '4.9.3',
      'third-party/st-chatu8': '2.8.4',
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
    now: () => '2026-08-23T01:00:00.000Z',
  });
}

test('all adapters complete an encrypted A to B roundtrip without plaintext secrets or duplicate scripts', async () => {
  const codec = createPassphraseSensitiveCodec('full roundtrip bridge passphrase');
  const snapshotStore = new MemorySnapshotStore();
  const sourceController = controller(sourceHost(), snapshotStore, 'device-a');

  const captured = await sourceController.captureAll(adapters.map(adapter => adapter.id), { sensitiveCodec: codec });
  assert.deepEqual(captured.map(result => result.status), adapters.map(() => 'captured'));
  for (const id of ['api-manager-2', 'dream-card-agent', 'st-chatu8']) {
    assert.equal(snapshotStore.values.get(id).sensitiveDataIncluded, true);
  }
  const serializedSnapshots = JSON.stringify([...snapshotStore.values.values()]);
  assert.equal(serializedSnapshots.includes('source-key'), false);
  assert.equal(serializedSnapshots.includes('source-secret'), false);
  assert.equal(serializedSnapshots.includes('source-token'), false);
  assert.equal(serializedSnapshots.includes('api.source.private'), false);
  assert.equal(serializedSnapshots.includes('novelai.source.private'), false);

  const sourceHashes = Object.fromEntries(
    [...snapshotStore.values].map(([id, snapshot]) => [id, snapshot.nonSensitiveHash]),
  );

  const target = cleanTargetHost();
  const targetController = controller(target, snapshotStore, 'device-b');
  const restored = await targetController.restoreAll(adapters.map(adapter => adapter.id), {
    automatic: true,
    sensitiveCodec: codec,
  });
  assert.deepEqual(restored.map(result => result.status), adapters.map(() => 'applied'));

  const targetState = target.inspect();
  const scripts = targetState.extensionSettings[TAVERN_HELPER_SETTINGS_KEY].script.scripts;
  assert.deepEqual(scripts.map(script => script.id).sort(), TARGET_TAVERN_SCRIPTS.map(item => item.id).sort());
  assert.equal(new Set(scripts.map(script => script.id)).size, 3);
  assert.equal(JSON.parse(targetState.localStorage.api_configs_manager)[0].apiKeys[0].key, 'source-key');
  assert.equal(JSON.parse(targetState.localStorage.api_configs_manager)[0].customUrl, 'https://api.source.private/v1');
  assert.equal(targetState.extensionSettings[DREAM_SETTINGS_KEY].providers[0].apiKey, 'source-secret');
  assert.equal(targetState.extensionSettings[ST_CHATU8_SETTINGS_KEY].ai_token, 'source-token');
  assert.equal(targetState.extensionSettings[ST_CHATU8_SETTINGS_KEY].novelaiApi, 'source-novelai-key');
  assert.equal(Object.hasOwn(targetState.extensionSettings[ST_CHATU8_SETTINGS_KEY], 'workerid'), false);
  assert.deepEqual(targetState.indexedDb.chatu8_gallery.tags, [
    { name: 'installed-target', translation: 'keep', hot: 0, fileName: 'tags.json' },
    { name: 'portable-tag', translation: 'portable', hot: 5, fileName: 'manual' },
  ]);

  const repeated = await targetController.restoreAll(adapters.map(adapter => adapter.id), { sensitiveCodec: codec });
  assert.deepEqual(repeated.map(result => result.status), adapters.map(() => 'noop'));
  assert.equal(target.inspect().extensionSettings[TAVERN_HELPER_SETTINGS_KEY].script.scripts.length, 3);

  const recaptured = await targetController.captureAll(adapters.map(adapter => adapter.id), { sensitiveCodec: codec });
  assert.deepEqual(recaptured.map(result => result.status), adapters.map(() => 'unchanged'));
  assert.deepEqual(
    Object.fromEntries([...snapshotStore.values].map(([id, snapshot]) => [id, snapshot.nonSensitiveHash])),
    sourceHashes,
  );
});
