import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TAVERN_HELPER_SETTINGS_KEY,
  tavernHelperScriptsAdapter,
} from '../src/adapters/tavern-helper-scripts-adapter.js';
import { BridgeController } from '../src/core/bridge-controller.js';
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
    this.values.set(snapshot.adapterId, structuredClone(snapshot));
    this.putCount += 1;
  }
}

class MemoryLocalState {
  constructor() {
    this.values = new Map();
  }
  getAdapterState(id) {
    return structuredClone(this.values.get(id) ?? {});
  }
  setAdapterState(id, patch) {
    this.values.set(id, { ...this.getAdapterState(id), ...structuredClone(patch) });
  }
}

function script(id, name, content) {
  return {
    type: 'script',
    enabled: true,
    id,
    name,
    content,
    info: '',
    button: { enabled: true, buttons: [] },
    data: {},
    export_with: { data: true, button: true },
  };
}

function controllerWithScripts(scripts, snapshotStore, localState = new MemoryLocalState()) {
  const host = createMemoryHost({
    extensionSettings: {
      [TAVERN_HELPER_SETTINGS_KEY]: { script: { scripts } },
    },
    pluginVersions: { 'third-party/JS-Slash-Runner': '4.9.3' },
  });
  const controller = new BridgeController({
    adapters: [tavernHelperScriptsAdapter],
    snapshotStore,
    localState,
    host,
    deviceId: 'source-device',
    now: () => '2026-08-24T00:00:00.000Z',
  });
  return { controller, host, localState };
}

test('controller refuses to replace a complete encrypted Tavern Helper snapshot with a smaller script set', async () => {
  const codec = createPassphraseSensitiveCodec('tavern helper regression passphrase');
  const store = new MemorySnapshotStore();
  const completeScripts = [
    script('one', 'One', 'one-body'),
    script('two', 'Two', 'two-body'),
    script('three', 'Three', 'three-body'),
  ];
  const { controller, host, localState } = controllerWithScripts(completeScripts, store);

  const first = await controller.capture(tavernHelperScriptsAdapter.id, { sensitiveCodec: codec });
  const original = await store.getSnapshot(tavernHelperScriptsAdapter.id);
  const settings = host.extensionSettings.get(TAVERN_HELPER_SETTINGS_KEY);
  settings.script.scripts = completeScripts.slice(0, 2);
  host.extensionSettings.set(TAVERN_HELPER_SETTINGS_KEY, settings);

  const second = await controller.capture(tavernHelperScriptsAdapter.id, { sensitiveCodec: codec });
  const preserved = await store.getSnapshot(tavernHelperScriptsAdapter.id);

  assert.equal(first.status, 'captured');
  assert.equal(second.status, 'deferred');
  assert.equal(second.reason, 'global-script-set-shrank');
  assert.equal(store.putCount, 1);
  assert.equal(preserved.sourceRevision, original.sourceRevision);
  assert.equal(preserved.contentHash, original.contentHash);
  assert.equal(localState.getAdapterState(tavernHelperScriptsAdapter.id).lastResult.status, 'deferred');
});
