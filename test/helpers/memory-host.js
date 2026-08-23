function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function createMemoryHost({
  extensionSettings = {},
  localStorage = {},
  pluginVersions = {},
  indexedDb = {},
} = {}) {
  const settings = clone(extensionSettings);
  const storage = new Map(Object.entries(localStorage));
  const databases = clone(indexedDb);
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
      };
    },
  };
}
