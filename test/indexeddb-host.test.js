import test from 'node:test';
import assert from 'node:assert/strict';

import { createIndexedDbHost } from '../src/host/indexeddb-host.js';

function fakeIndexedDb(initialRecords) {
  const records = structuredClone(initialRecords);
  let closeCount = 0;

  function requestWith(result) {
    const request = {};
    queueMicrotask(() => {
      request.result = result;
      request.onsuccess?.({ target: request });
    });
    return request;
  }

  const db = {
    version: 6,
    objectStoreNames: { contains: name => name === 'tags' },
    close() { closeCount += 1; },
    transaction(_storeName, mode) {
      const transaction = { error: null };
      const objectStore = {
        indexNames: { contains: name => name === 'fileName' },
        add(record) { records.push(structuredClone(record)); },
        index() {
          return {
            getAll(keyRange) {
              return requestWith(records.filter(record => record.fileName === keyRange.value));
            },
            openCursor(keyRange) {
              const request = {};
              const matches = records.filter(record => record.fileName === keyRange.value);
              let position = 0;
              const emit = () => {
                const record = matches[position];
                if (!record) {
                  request.onsuccess?.({ target: { result: null } });
                  queueMicrotask(() => transaction.oncomplete?.());
                  return;
                }
                const cursor = {
                  delete() {
                    const index = records.indexOf(record);
                    if (index >= 0) records.splice(index, 1);
                  },
                  continue() {
                    position += 1;
                    queueMicrotask(emit);
                  },
                };
                request.onsuccess?.({ target: { result: cursor } });
              };
              queueMicrotask(emit);
              return request;
            },
          };
        },
      };
      transaction.objectStore = () => objectStore;
      if (mode === 'readonly') queueMicrotask(() => transaction.oncomplete?.());
      return transaction;
    },
  };

  return {
    indexedDB: {
      async databases() { return [{ name: 'chatu8_gallery', version: 6 }]; },
      open() { return requestWith(db); },
    },
    IDBKeyRange: { only: value => ({ value }) },
    inspect: () => ({ records: structuredClone(records), closeCount }),
  };
}

test('IndexedDB host reads and atomically replaces only records matching an index value', async () => {
  const fake = fakeIndexedDb([
    { name: 'manual-old', fileName: 'manual' },
    { name: 'installed', fileName: 'tags.json' },
  ]);
  const host = createIndexedDbHost(fake);

  const read = await host.getAllByIndex({
    database: 'chatu8_gallery', version: 6, store: 'tags', index: 'fileName', value: 'manual',
  });
  const replaced = await host.replaceByIndex({
    database: 'chatu8_gallery',
    version: 6,
    store: 'tags',
    index: 'fileName',
    value: 'manual',
    records: [{ name: 'manual-new', fileName: 'manual' }],
  });

  assert.deepEqual(read, { available: true, records: [{ name: 'manual-old', fileName: 'manual' }] });
  assert.deepEqual(replaced, { available: true });
  assert.deepEqual(fake.inspect().records, [
    { name: 'installed', fileName: 'tags.json' },
    { name: 'manual-new', fileName: 'manual' },
  ]);
  assert.equal(fake.inspect().closeCount, 2);
});

test('IndexedDB host does not create a missing database', async () => {
  const host = createIndexedDbHost({
    indexedDB: { async databases() { return []; }, open() { throw new Error('must not open'); } },
    IDBKeyRange: { only: value => value },
  });

  assert.deepEqual(await host.getAllByIndex({
    database: 'missing', version: 1, store: 'tags', index: 'fileName', value: 'manual',
  }), { available: false, reason: 'database-missing' });
});
