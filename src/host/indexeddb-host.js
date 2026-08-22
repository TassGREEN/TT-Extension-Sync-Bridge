function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

async function databaseExists(indexedDB, database) {
  if (typeof indexedDB?.databases !== 'function') return false;
  const databases = await indexedDB.databases();
  return databases.some(item => item?.name === database);
}

async function openExisting(indexedDB, database) {
  if (!await databaseExists(indexedDB, database)) return null;
  const request = indexedDB.open(database);
  return new Promise((resolve, reject) => {
    request.onupgradeneeded = () => {
      request.transaction?.abort();
      reject(new Error(`IndexedDB ${database} unexpectedly required an upgrade`));
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`Unable to open IndexedDB ${database}`));
  });
}

function unavailable(reason) {
  return { available: false, reason };
}

export function createIndexedDbHost({
  indexedDB = globalThis.indexedDB,
  IDBKeyRange = globalThis.IDBKeyRange,
} = {}) {
  return {
    async getAllByIndex({ database, version, store, index, value }) {
      if (!indexedDB || !IDBKeyRange) return unavailable('indexeddb-api-unavailable');
      const db = await openExisting(indexedDB, database);
      if (!db) return unavailable('database-missing');
      try {
        if (db.version !== version) return unavailable(`database-version-${db.version}`);
        if (!db.objectStoreNames.contains(store)) return unavailable('store-missing');
        const transaction = db.transaction(store, 'readonly');
        const objectStore = transaction.objectStore(store);
        if (!objectStore.indexNames.contains(index)) return unavailable('index-missing');
        const records = await requestResult(objectStore.index(index).getAll(IDBKeyRange.only(value)));
        return { available: true, records: clone(records) };
      } finally {
        db.close();
      }
    },

    async replaceByIndex({ database, version, store, index, value, records }) {
      if (!indexedDB || !IDBKeyRange) return unavailable('indexeddb-api-unavailable');
      const db = await openExisting(indexedDB, database);
      if (!db) return unavailable('database-missing');
      try {
        if (db.version !== version) return unavailable(`database-version-${db.version}`);
        if (!db.objectStoreNames.contains(store)) return unavailable('store-missing');
        const transaction = db.transaction(store, 'readwrite');
        const objectStore = transaction.objectStore(store);
        if (!objectStore.indexNames.contains(index)) {
          transaction.abort();
          return unavailable('index-missing');
        }
        const cursorRequest = objectStore.index(index).openCursor(IDBKeyRange.only(value));
        return await new Promise((resolve, reject) => {
          cursorRequest.onerror = () => {
            transaction.abort();
            reject(cursorRequest.error ?? new Error('Unable to enumerate IndexedDB records'));
          };
          cursorRequest.onsuccess = event => {
            const cursor = event.target.result;
            if (cursor) {
              cursor.delete();
              cursor.continue();
              return;
            }
            for (const record of records) objectStore.add(clone(record));
          };
          transaction.oncomplete = () => resolve({ available: true });
          transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
          transaction.onerror = () => {};
        });
      } finally {
        db.close();
      }
    },
  };
}
