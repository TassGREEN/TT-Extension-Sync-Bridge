import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BridgeLocalStateStore,
  BridgePreferencesStore,
  DEFAULT_ADAPTER_IDS,
} from '../src/store/local-state-store.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    inspect: () => Object.fromEntries(values),
  };
}

test('preferences default safely and persist adapter switches locally', () => {
  const storage = memoryStorage();
  const preferences = new BridgePreferencesStore(storage);

  assert.equal(preferences.get().masterEnabled, true);
  assert.equal(preferences.get().autoCapture, false);
  assert.equal(preferences.get().sensitiveDataSync, false);
  assert.deepEqual(Object.keys(preferences.get().adapters).sort(), [...DEFAULT_ADAPTER_IDS].sort());

  preferences.update({ autoCapture: true, adapters: { 'st-chatu8': false } });
  const reloaded = new BridgePreferencesStore(storage).get();

  assert.equal(reloaded.autoCapture, true);
  assert.equal(reloaded.adapters['st-chatu8'], false);
  assert.equal(reloaded.adapters['dream-card-agent'], true);
});

test('preferences fail closed if plaintext sensitive sync is requested', () => {
  const preferences = new BridgePreferencesStore(memoryStorage());

  assert.throws(() => preferences.update({ sensitiveDataSync: true }), /encrypted sensitive sync is not implemented/i);
  assert.equal(preferences.get().sensitiveDataSync, false);
});

test('local adapter state and device ID survive reload without entering Extension Store', () => {
  const storage = memoryStorage();
  const first = new BridgeLocalStateStore(storage, { randomUuid: () => 'device-123' });

  first.setAdapterState('st-chatu8', { lastAppliedHash: 'abc', lastResult: { status: 'applied' } });
  const second = new BridgeLocalStateStore(storage, { randomUuid: () => 'must-not-be-used' });

  assert.equal(second.deviceId, 'device-123');
  assert.deepEqual(second.getAdapterState('st-chatu8'), {
    lastAppliedHash: 'abc',
    lastResult: { status: 'applied' },
  });
});

test('corrupt local state is ignored instead of breaking startup', () => {
  const storage = memoryStorage({
    'tt_extension_sync_bridge.preferences.v1': '{broken',
    'tt_extension_sync_bridge.local_state.v1': '{broken',
  });

  assert.equal(new BridgePreferencesStore(storage).get().masterEnabled, true);
  assert.deepEqual(
    new BridgeLocalStateStore(storage, { randomUuid: () => 'replacement' }).getAdapterState('st-chatu8'),
    {},
  );
});
