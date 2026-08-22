import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIDGE_NAMESPACE,
  ExtensionStoreSnapshotStore,
} from '../src/store/extension-store-snapshot-store.js';

test('snapshot store uses one Extension Store JSON file per adapter', async () => {
  const calls = [];
  const values = new Map();
  const api = {
    async tryGetJson(args) {
      calls.push(['get', args]);
      const id = `${args.table}/${args.key}`;
      return values.has(id) ? { found: true, value: values.get(id) } : { found: false };
    },
    async setJson(args) {
      calls.push(['set', args]);
      values.set(`${args.table}/${args.key}`, args.value);
    },
    async listKeys(args) {
      calls.push(['list', args]);
      return [...values.keys()].filter(key => key.startsWith(`${args.table}/`)).map(key => key.split('/')[1]);
    },
  };
  const store = new ExtensionStoreSnapshotStore(api);
  const snapshot = { adapterId: 'st-chatu8', contentHash: 'abc' };

  assert.equal(await store.getSnapshot('st-chatu8'), null);
  await store.putSnapshot(snapshot);
  assert.deepEqual(await store.getSnapshot('st-chatu8'), snapshot);
  assert.deepEqual(await store.listAdapterIds(), ['st-chatu8']);
  assert.deepEqual(calls[0], ['get', {
    namespace: BRIDGE_NAMESPACE,
    table: 'snapshots',
    key: 'st-chatu8',
  }]);
  assert.deepEqual(calls[1], ['set', {
    namespace: BRIDGE_NAMESPACE,
    table: 'snapshots',
    key: 'st-chatu8',
    value: snapshot,
  }]);
});

test('snapshot store refuses an adapter ID that cannot be an Extension Store key', async () => {
  const store = new ExtensionStoreSnapshotStore({});
  await assert.rejects(() => store.getSnapshot('../escape'), /invalid adapter id/i);
  await assert.rejects(() => store.putSnapshot({ adapterId: '.hidden' }), /invalid adapter id/i);
});
