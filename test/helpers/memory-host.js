function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toBytes(value) {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  throw new TypeError('Memory host file values must be strings or byte arrays');
}

export function createMemoryHost({
  extensionSettings = {},
  localStorage = {},
  pluginVersions = {},
  indexedDb = {},
  files = {},
} = {}) {
  const settings = clone(extensionSettings);
  const storage = new Map(Object.entries(localStorage));
  const databases = clone(indexedDb);
  const fileValues = new Map(Object.entries(files).map(([url, value]) => [url, toBytes(value)]));
  const fileUploads = [];
  const fileDeletes = [];
  const broadcasts = [];
  let saveCount = 0;
  let indexedDbWriteCount = 0;

  return {
    extensionSettings: {
      get(key) {
        return clone(settings[key]);
      },
      set(key, value) {
        settings[key] = clone(value);
      },
    },
    localStorage: {
      get(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      set(key, value) {
        storage.set(key, String(value));
      },
      remove(key) {
        storage.delete(key);
      },
    },
    files: {
      async download(url) {
        const value = fileValues.get(url);
        if (!value) throw new Error(`missing user file: ${url}`);
        return Uint8Array.from(value);
      },
      async upload(name, bytes) {
        const url = `/user/files/${name}`;
        fileValues.set(url, toBytes(bytes));
        fileUploads.push({ name, url });
        return url;
      },
      async delete(url) {
        fileValues.delete(url);
        fileDeletes.push(url);
      },
    },
    indexedDb: {
      async getAllByIndex({ database, store, index, value }) {
        const records = databases[database]?.[store];
        if (!Array.isArray(records)) return { available: false, records: [] };
        return { available: true, records: clone(records.filter(record => record?.[index] === value)) };
      },
      async replaceByIndex({ database, store, index, value, records }) {
        const current = databases[database]?.[store];
        if (!Array.isArray(current)) return { available: false };
        databases[database][store] = [
          ...current.filter(record => record?.[index] !== value),
          ...clone(records),
        ];
        indexedDbWriteCount += 1;
        return { available: true };
      },
    },
    broadcast: {
      post(channel, message) {
        broadcasts.push({ channel, message: clone(message) });
        return true;
      },
    },
    pluginVersion(pluginId) {
      return pluginVersions[pluginId] ?? null;
    },
    async saveSettings() {
      saveCount += 1;
    },
    inspect() {
      return {
        extensionSettings: clone(settings),
        localStorage: Object.fromEntries(storage),
        saveCount,
        indexedDb: clone(databases),
        indexedDbWriteCount,
        broadcasts: clone(broadcasts),
        files: Object.fromEntries([...fileValues].map(([url, bytes]) => [url, Array.from(bytes)])),
        fileUploads: clone(fileUploads),
        fileDeletes: clone(fileDeletes),
      };
    },
  };
}
