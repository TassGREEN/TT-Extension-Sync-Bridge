export const PREFERENCES_KEY = 'tt_extension_sync_bridge.preferences.v1';
export const LOCAL_STATE_KEY = 'tt_extension_sync_bridge.local_state.v1';

export const DEFAULT_ADAPTER_IDS = Object.freeze([
  'tavern-helper-global-scripts',
  'database-shujuku-v104',
  'api-manager-2',
  'dream-card-agent',
  'st-chatu8',
]);

const DEFAULT_PREFERENCES = Object.freeze({
  masterEnabled: true,
  autoCapture: false,
  sensitiveDataSync: false,
  adapters: Object.freeze(Object.fromEntries(DEFAULT_ADAPTER_IDS.map(id => [id, true]))),
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeParse(raw, fallback) {
  if (typeof raw !== 'string') return clone(fallback);
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : clone(fallback);
  } catch {
    return clone(fallback);
  }
}

function normalizePreferences(value) {
  const defaults = clone(DEFAULT_PREFERENCES);
  return {
    masterEnabled: typeof value.masterEnabled === 'boolean' ? value.masterEnabled : defaults.masterEnabled,
    autoCapture: typeof value.autoCapture === 'boolean' ? value.autoCapture : defaults.autoCapture,
    sensitiveDataSync: false,
    adapters: Object.fromEntries(DEFAULT_ADAPTER_IDS.map(id => [
      id,
      typeof value.adapters?.[id] === 'boolean' ? value.adapters[id] : true,
    ])),
  };
}

export class BridgePreferencesStore {
  constructor(storage) {
    this.storage = storage;
    this.value = normalizePreferences(safeParse(storage.getItem(PREFERENCES_KEY), DEFAULT_PREFERENCES));
  }

  get() {
    return clone(this.value);
  }

  update(patch) {
    if (patch?.sensitiveDataSync === true) {
      throw new Error('Encrypted sensitive sync is not implemented; plaintext sensitive sync remains disabled');
    }
    const next = {
      ...this.value,
      ...(typeof patch?.masterEnabled === 'boolean' ? { masterEnabled: patch.masterEnabled } : {}),
      ...(typeof patch?.autoCapture === 'boolean' ? { autoCapture: patch.autoCapture } : {}),
      sensitiveDataSync: false,
      adapters: { ...this.value.adapters },
    };
    if (patch?.adapters && typeof patch.adapters === 'object') {
      for (const id of DEFAULT_ADAPTER_IDS) {
        if (typeof patch.adapters[id] === 'boolean') next.adapters[id] = patch.adapters[id];
      }
    }
    this.value = normalizePreferences(next);
    this.storage.setItem(PREFERENCES_KEY, JSON.stringify(this.value));
    return this.get();
  }
}

export class BridgeLocalStateStore {
  constructor(storage, { randomUuid = () => globalThis.crypto.randomUUID() } = {}) {
    this.storage = storage;
    const parsed = safeParse(storage.getItem(LOCAL_STATE_KEY), {});
    this.value = {
      deviceId: typeof parsed.deviceId === 'string' && parsed.deviceId ? parsed.deviceId : randomUuid(),
      adapters: parsed.adapters && typeof parsed.adapters === 'object' && !Array.isArray(parsed.adapters)
        ? parsed.adapters
        : {},
    };
    this.persist();
  }

  get deviceId() {
    return this.value.deviceId;
  }

  getAdapterState(adapterId) {
    const value = this.value.adapters[adapterId];
    return value && typeof value === 'object' && !Array.isArray(value) ? clone(value) : {};
  }

  setAdapterState(adapterId, patch) {
    this.value.adapters[adapterId] = { ...this.getAdapterState(adapterId), ...clone(patch) };
    this.persist();
    return this.getAdapterState(adapterId);
  }

  listAdapterStates() {
    return clone(this.value.adapters);
  }

  persist() {
    this.storage.setItem(LOCAL_STATE_KEY, JSON.stringify(this.value));
  }
}
