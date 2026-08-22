import test from 'node:test';
import assert from 'node:assert/strict';

import {
  databaseAdapter,
  DATABASE_SETTINGS_KEY,
  DATABASE_SETTINGS_ROOT,
} from '../src/adapters/database-adapter.js';
import {
  TARGET_TAVERN_SCRIPTS,
  TAVERN_HELPER_SETTINGS_KEY,
  tavernHelperScriptsAdapter,
} from '../src/adapters/tavern-helper-scripts-adapter.js';
import { BridgeController } from '../src/core/bridge-controller.js';
import {
  DREAM_SCRIPT_ID,
  DREAM_SETTINGS_KEY,
  dreamCardAgentAdapter,
} from '../src/adapters/dream-card-agent-adapter.js';
import { createSnapshot } from '../src/core/snapshot.js';
import { redactedValue } from '../src/core/redaction.js';
import { createPassphraseSensitiveCodec } from '../src/core/sensitive-envelope.js';
import { createMemoryHost } from './helpers/memory-host.js';

class MemorySnapshotStore {
  constructor() {
    this.values = new Map();
    this.putCount = 0;
  }
  async getSnapshot(id) {
    return this.values.get(id) ?? null;
  }
  async putSnapshot(snapshot) {
    this.values.set(snapshot.adapterId, JSON.parse(JSON.stringify(snapshot)));
    this.putCount += 1;
  }
}

class MemoryLocalState {
  constructor() {
    this.values = new Map();
  }
  getAdapterState(id) {
    return this.values.get(id) ?? {};
  }
  setAdapterState(id, patch) {
    this.values.set(id, { ...this.getAdapterState(id), ...patch });
  }
}

function databaseSettings(enabled) {
  return {
    shujuku_v104_globalMeta_v1: '{"revision":1}',
    shujuku_v104_profile_v1____default____settings: JSON.stringify({ enabled }),
    shujuku_v104_profile_v1____default____template: '{"template":"user"}',
    shujuku_v104_templatePresets_v1: '[]',
    shujuku_v104_windowStates: '{"left":1}',
  };
}

function nestedDatabaseSettings(settings) {
  return { [DATABASE_SETTINGS_ROOT]: { [DATABASE_SETTINGS_KEY]: settings } };
}

function setDatabaseSettings(host, settings) {
  const root = host.extensionSettings.get(DATABASE_SETTINGS_ROOT) ?? {};
  root[DATABASE_SETTINGS_KEY] = settings;
  host.extensionSettings.set(DATABASE_SETTINGS_ROOT, root);
}

function controllerFor(host, snapshotStore = new MemorySnapshotStore(), localState = new MemoryLocalState()) {
  let tick = 0;
  return {
    controller: new BridgeController({
      adapters: [databaseAdapter],
      snapshotStore,
      localState,
      host,
      deviceId: 'device-a',
      now: () => `2026-08-22T12:00:0${tick++}.000Z`,
    }),
    snapshotStore,
    localState,
  };
}

test('capture increments revision only when adapter content changes', async () => {
  const host = createMemoryHost({ extensionSettings: nestedDatabaseSettings(databaseSettings(true)) });
  const { controller, snapshotStore } = controllerFor(host);

  const first = await controller.capture(databaseAdapter.id);
  const unchanged = await controller.capture(databaseAdapter.id);
  setDatabaseSettings(host, databaseSettings(false));
  const changed = await controller.capture(databaseAdapter.id);

  assert.equal(first.status, 'captured');
  assert.equal(first.snapshot.sourceRevision, 1);
  assert.equal(unchanged.status, 'unchanged');
  assert.equal(unchanged.snapshot.sourceRevision, 1);
  assert.equal(changed.snapshot.sourceRevision, 2);
  assert.equal(snapshotStore.putCount, 2);
});

test('restore blocks untracked local differences until explicitly confirmed', async () => {
  const source = createMemoryHost({ extensionSettings: nestedDatabaseSettings(databaseSettings(true)) });
  const sharedStore = new MemorySnapshotStore();
  await controllerFor(source, sharedStore).controller.capture(databaseAdapter.id);
  const target = createMemoryHost({ extensionSettings: nestedDatabaseSettings(databaseSettings(false)) });
  const { controller } = controllerFor(target, sharedStore, new MemoryLocalState());

  const preview = await controller.previewRestore(databaseAdapter.id);
  const blocked = await controller.restore(databaseAdapter.id);
  const applied = await controller.restore(databaseAdapter.id, { confirmConflict: true });
  const repeated = await controller.restore(databaseAdapter.id);

  assert.equal(preview.status, 'conflict');
  assert.equal(preview.reason, 'untracked-local-data');
  assert.equal(blocked.status, 'conflict');
  assert.equal(target.inspect().saveCount, 1);
  assert.equal(applied.status, 'applied');
  assert.equal(repeated.status, 'noop');
});

test('restore rejects a tampered synchronized snapshot before adapter writes', async () => {
  const source = createMemoryHost({ extensionSettings: nestedDatabaseSettings(databaseSettings(true)) });
  const sharedStore = new MemorySnapshotStore();
  await controllerFor(source, sharedStore).controller.capture(databaseAdapter.id);
  sharedStore.values.get(databaseAdapter.id).payload.settings.shujuku_v104_globalMeta_v1 = '{"tampered":true}';
  const target = createMemoryHost({ extensionSettings: nestedDatabaseSettings(databaseSettings(false)) });
  const { controller } = controllerFor(target, sharedStore);

  await assert.rejects(() => controller.restore(databaseAdapter.id, { confirmConflict: true }), /content hash mismatch/i);
  assert.equal(target.inspect().saveCount, 0);
});

test('clean-device restore initializes scripts first and then their settings without confirmation', async () => {
  const targetScripts = TARGET_TAVERN_SCRIPTS.map((script, index) => ({
    type: 'script',
    enabled: true,
    id: script.id,
    name: script.name,
    content: `console.log("target-${index}")`,
    info: '',
    button: { enabled: true, buttons: [] },
    data: {},
    export_with: { data: true, button: true },
  }));
  const source = createMemoryHost({
    extensionSettings: {
      [TAVERN_HELPER_SETTINGS_KEY]: { script: { scripts: targetScripts } },
      ...nestedDatabaseSettings(databaseSettings(true)),
    },
    pluginVersions: { 'third-party/JS-Slash-Runner': '4.8.12' },
  });
  const sharedStore = new MemorySnapshotStore();
  const sourceController = new BridgeController({
    adapters: [tavernHelperScriptsAdapter, databaseAdapter],
    snapshotStore: sharedStore,
    localState: new MemoryLocalState(),
    host: source,
    deviceId: 'source-device',
    now: () => '2026-08-22T12:00:00.000Z',
  });
  await sourceController.capture(tavernHelperScriptsAdapter.id);
  await sourceController.capture(databaseAdapter.id);

  const target = createMemoryHost({ pluginVersions: { 'third-party/JS-Slash-Runner': '4.8.12' } });
  target.hasTavernScript = scriptId => {
    const trees = target.inspect().extensionSettings[TAVERN_HELPER_SETTINGS_KEY]?.script?.scripts ?? [];
    return trees.some(tree => tree.id === scriptId || tree.scripts?.some(script => script.id === scriptId));
  };
  const targetController = new BridgeController({
    adapters: [tavernHelperScriptsAdapter, databaseAdapter],
    snapshotStore: sharedStore,
    localState: new MemoryLocalState(),
    host: target,
    deviceId: 'target-device',
    now: () => '2026-08-22T12:01:00.000Z',
  });

  const results = await targetController.restoreAll([
    tavernHelperScriptsAdapter.id,
    databaseAdapter.id,
  ], { automatic: true });

  assert.deepEqual(results.map(result => result.status), ['applied', 'applied']);
  assert.equal(target.hasTavernScript(TARGET_TAVERN_SCRIPTS[0].id), true);
  assert.equal(
    target.inspect().extensionSettings[DATABASE_SETTINGS_ROOT][DATABASE_SETTINGS_KEY].shujuku_v104_profile_v1____default____settings,
    '{"enabled":true}',
  );
});

test('restore migrates an older adapter payload only after its original hash is verified', async () => {
  const writes = [];
  const adapter = {
    id: 'migrating-adapter',
    label: 'Migrating adapter',
    version: 2,
    migratePayload(payload, fromVersion) {
      assert.equal(fromVersion, 1);
      return { dataVersion: 2, value: payload.legacyValue };
    },
    async capture() {
      return { available: true, payload: { dataVersion: 2, value: 'old' } };
    },
    async preview(_host, payload) {
      assert.deepEqual(payload, { dataVersion: 2, value: 'new' });
      return { status: 'would-change' };
    },
    async restore(_host, payload) {
      writes.push(payload);
      return { status: 'applied' };
    },
  };
  const snapshotStore = new MemorySnapshotStore();
  snapshotStore.values.set(adapter.id, await createSnapshot({
    adapterId: adapter.id,
    adapterVersion: 1,
    sourceRevision: 1,
    capturedAt: '2026-08-22T12:00:00.000Z',
    deviceId: 'old-device',
    payload: { legacyValue: 'new' },
  }));
  const controller = new BridgeController({
    adapters: [adapter],
    snapshotStore,
    localState: new MemoryLocalState(),
    host: {},
    deviceId: 'new-device',
  });

  const preview = await controller.previewRestore(adapter.id);
  const restored = await controller.restore(adapter.id, { confirmConflict: true });

  assert.equal(preview.status, 'conflict');
  assert.equal(restored.status, 'applied');
  assert.deepEqual(writes, [{ dataVersion: 2, value: 'new' }]);
});

test('restore refuses an older adapter snapshot when no explicit migration exists', async () => {
  const adapter = {
    id: 'unmigrated-adapter',
    label: 'Unmigrated adapter',
    version: 2,
    async capture() {
      return { available: true, payload: {} };
    },
    async preview() {
      throw new Error('must not preview');
    },
    async restore() {
      throw new Error('must not restore');
    },
  };
  const snapshotStore = new MemorySnapshotStore();
  snapshotStore.values.set(adapter.id, await createSnapshot({
    adapterId: adapter.id,
    adapterVersion: 1,
    sourceRevision: 1,
    capturedAt: '2026-08-22T12:00:00.000Z',
    deviceId: 'old-device',
    payload: {},
  }));
  const controller = new BridgeController({
    adapters: [adapter],
    snapshotStore,
    localState: new MemoryLocalState(),
    host: {},
    deviceId: 'new-device',
  });

  await assert.rejects(() => controller.previewRestore(adapter.id), /no migration/i);
});

test('capture does not publish a new revision when only local credential topology differs', async () => {
  let includeCredentialField = false;
  const adapter = {
    id: 'credential-topology-adapter',
    label: 'Credential topology adapter',
    version: 1,
    async capture() {
      return {
        available: true,
        payload: {
          providers: [{
            id: 'one',
            model: 'same-model',
            ...(includeCredentialField ? { apiKey: redactedValue() } : {}),
          }],
        },
      };
    },
  };
  const snapshotStore = new MemorySnapshotStore();
  const controller = new BridgeController({
    adapters: [adapter],
    snapshotStore,
    localState: new MemoryLocalState(),
    host: {},
    deviceId: 'device-a',
  });

  const first = await controller.capture(adapter.id);
  includeCredentialField = true;
  const second = await controller.capture(adapter.id);

  assert.equal(first.status, 'captured');
  assert.equal(second.status, 'unchanged');
  assert.equal(second.snapshot.sourceRevision, 1);
  assert.equal(snapshotStore.putCount, 1);
});

test('automatic restore defers until an adapter dependency exists, then safely initializes empty storage', async () => {
  let ready = false;
  let writes = 0;
  const adapter = {
    id: 'deferred-adapter',
    label: 'Deferred adapter',
    version: 1,
    async capture() {
      return { available: true, payload: { records: ready ? [] : [] } };
    },
    async preview() {
      return ready
        ? { status: 'would-change', safeToApply: true }
        : { status: 'deferred', reason: 'database-missing' };
    },
    async restore() {
      writes += 1;
      return { status: 'applied' };
    },
  };
  const snapshotStore = new MemorySnapshotStore();
  snapshotStore.values.set(adapter.id, await createSnapshot({
    adapterId: adapter.id,
    adapterVersion: 1,
    sourceRevision: 1,
    capturedAt: '2026-08-22T12:00:00.000Z',
    deviceId: 'device-a',
    payload: { records: [{ name: 'source' }] },
  }));
  const controller = new BridgeController({
    adapters: [adapter],
    snapshotStore,
    localState: new MemoryLocalState(),
    host: {},
    deviceId: 'device-b',
  });

  assert.equal((await controller.restore(adapter.id)).status, 'deferred');
  assert.equal(writes, 0);
  ready = true;
  assert.equal((await controller.restore(adapter.id)).status, 'applied');
  assert.equal(writes, 1);
});

test('controller stores encrypted Dream providers, locks without a passphrase, and restores with one', async () => {
  const sourceSecret = 'dream-provider-encrypted-payload';
  const sourceUrl = 'https://private-provider.example/v1';
  const passphrase = 'same passphrase on both devices';
  const codec = createPassphraseSensitiveCodec(passphrase);
  const source = createMemoryHost({
    extensionSettings: {
      [DREAM_SETTINGS_KEY]: {
        version: 4,
        providers: [{
          id: 'provider-1',
          name: 'Provider',
          baseURL: sourceUrl,
          models: [],
          secrets: { version: 1, ciphertext: sourceSecret },
        }],
      },
    },
  });
  const store = new MemorySnapshotStore();
  const sourceController = new BridgeController({
    adapters: [dreamCardAgentAdapter],
    snapshotStore: store,
    localState: new MemoryLocalState(),
    host: source,
    deviceId: 'source-device',
  });

  const captured = await sourceController.capture(dreamCardAgentAdapter.id, {
    includeSensitive: true,
    sensitiveCodec: codec,
  });
  const repeated = await sourceController.capture(dreamCardAgentAdapter.id, {
    includeSensitive: true,
    sensitiveCodec: codec,
  });
  assert.equal(captured.snapshot.sensitiveDataIncluded, true);
  assert.equal(repeated.status, 'unchanged');
  assert.equal(JSON.stringify(captured.snapshot).includes(sourceSecret), false);
  assert.equal(JSON.stringify(captured.snapshot).includes(sourceUrl), false);
  await assert.rejects(
    () => sourceController.capture(dreamCardAgentAdapter.id),
    /refusing to replace an encrypted snapshot/i,
  );
  assert.equal(store.putCount, 1);

  const target = createMemoryHost();
  target.hasTavernScript = id => id === DREAM_SCRIPT_ID;
  const targetController = new BridgeController({
    adapters: [dreamCardAgentAdapter],
    snapshotStore: store,
    localState: new MemoryLocalState(),
    host: target,
    deviceId: 'target-device',
  });

  assert.equal((await targetController.previewRestore(dreamCardAgentAdapter.id)).status, 'locked');
  assert.equal((await targetController.restore(dreamCardAgentAdapter.id)).status, 'locked');
  assert.equal(target.inspect().saveCount, 0);
  await assert.rejects(
    () => targetController.restore(dreamCardAgentAdapter.id, {
      sensitiveCodec: createPassphraseSensitiveCodec('incorrect passphrase'),
    }),
    /unable to decrypt sensitive data/i,
  );
  assert.equal(target.inspect().saveCount, 0);

  const restored = await targetController.restore(dreamCardAgentAdapter.id, { sensitiveCodec: codec });
  assert.equal(restored.status, 'applied');
  assert.equal(target.inspect().extensionSettings[DREAM_SETTINGS_KEY].providers[0].baseURL, sourceUrl);
  assert.equal(target.inspect().extensionSettings[DREAM_SETTINGS_KEY].providers[0].secrets.ciphertext, sourceSecret);
});

test('mobile capture defers partially initialized Tavern Helper scripts without replacing the complete snapshot', async () => {
  const makeScript = (target, content) => ({
    type: 'script',
    enabled: true,
    id: target.id,
    name: target.name,
    content,
    info: '',
    button: { enabled: true, buttons: [] },
    data: {},
    export_with: { data: true, button: true },
  });
  const source = createMemoryHost({
    extensionSettings: {
      [TAVERN_HELPER_SETTINGS_KEY]: {
        script: { scripts: TARGET_TAVERN_SCRIPTS.map((target, index) => makeScript(target, `source-${index}`)) },
      },
    },
    pluginVersions: { 'third-party/JS-Slash-Runner': '4.8.12' },
  });
  const store = new MemorySnapshotStore();
  const sourceController = new BridgeController({
    adapters: [tavernHelperScriptsAdapter],
    snapshotStore: store,
    localState: new MemoryLocalState(),
    host: source,
    deviceId: 'desktop',
  });
  const original = await sourceController.capture(tavernHelperScriptsAdapter.id);

  const mobile = createMemoryHost({
    extensionSettings: {
      [TAVERN_HELPER_SETTINGS_KEY]: {
        script: { scripts: [makeScript(TARGET_TAVERN_SCRIPTS[0], 'mobile-partial')] },
      },
    },
    pluginVersions: { 'third-party/JS-Slash-Runner': '4.8.12' },
  });
  const mobileState = new MemoryLocalState();
  const mobileController = new BridgeController({
    adapters: [tavernHelperScriptsAdapter],
    snapshotStore: store,
    localState: mobileState,
    host: mobile,
    deviceId: 'mobile',
  });

  const [result] = await mobileController.captureAll([tavernHelperScriptsAdapter.id]);
  const preserved = await store.getSnapshot(tavernHelperScriptsAdapter.id);

  assert.equal(result.status, 'deferred');
  assert.equal(result.reason, 'target-scripts-not-fully-initialized');
  assert.equal(preserved.contentHash, original.snapshot.contentHash);
  assert.equal(preserved.sourceRevision, original.snapshot.sourceRevision);
  assert.equal(mobileState.getAdapterState(tavernHelperScriptsAdapter.id).lastResult.status, 'deferred');
});

test('automatic restore safely completes an identical partial Tavern Helper script set on mobile', async () => {
  const makeScript = (target, content) => ({
    type: 'script',
    enabled: true,
    id: target.id,
    name: target.name,
    content,
    info: '',
    button: { enabled: true, buttons: [] },
    data: {},
    export_with: { data: true, button: true },
  });
  const completeScripts = TARGET_TAVERN_SCRIPTS.map((target, index) => makeScript(target, `shared-${index}`));
  const source = createMemoryHost({
    extensionSettings: {
      [TAVERN_HELPER_SETTINGS_KEY]: { script: { scripts: completeScripts } },
    },
    pluginVersions: { 'third-party/JS-Slash-Runner': '4.8.12' },
  });
  const store = new MemorySnapshotStore();
  await new BridgeController({
    adapters: [tavernHelperScriptsAdapter],
    snapshotStore: store,
    localState: new MemoryLocalState(),
    host: source,
    deviceId: 'desktop',
  }).capture(tavernHelperScriptsAdapter.id);

  const mobile = createMemoryHost({
    extensionSettings: {
      [TAVERN_HELPER_SETTINGS_KEY]: { script: { scripts: [completeScripts[0]] } },
    },
    pluginVersions: { 'third-party/JS-Slash-Runner': '4.8.12' },
  });
  const mobileController = new BridgeController({
    adapters: [tavernHelperScriptsAdapter],
    snapshotStore: store,
    localState: new MemoryLocalState(),
    host: mobile,
    deviceId: 'mobile',
  });

  const [restored] = await mobileController.restoreAll([tavernHelperScriptsAdapter.id], { automatic: true });
  const [recaptured] = await mobileController.captureAll([tavernHelperScriptsAdapter.id]);

  assert.equal(restored.status, 'applied');
  assert.equal(recaptured.status, 'unchanged');
  assert.deepEqual(
    mobile.inspect().extensionSettings[TAVERN_HELPER_SETTINGS_KEY].script.scripts.map(item => item.id),
    TARGET_TAVERN_SCRIPTS.map(item => item.id),
  );
});
