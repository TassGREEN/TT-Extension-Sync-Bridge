function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function flattenScripts(trees) {
  if (!Array.isArray(trees)) return [];
  return trees.flatMap(tree => {
    if (tree?.type === 'script') return [tree];
    if (tree?.type === 'folder' && Array.isArray(tree.scripts)) return tree.scripts;
    return [];
  });
}

function requireUserFileName(name) {
  if (typeof name !== 'string' || name.trim() === '' || /[?#\u0000-\u001f\u007f]/u.test(name)) {
    throw new TypeError('Bridge file uploads require a safe basename');
  }
  let decoded;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    throw new TypeError('Bridge file uploads require a safe basename');
  }
  if (
    name === '.'
    || name === '..'
    || decoded === '.'
    || decoded === '..'
    || /[\\/]/u.test(name)
    || /[\\/\u0000-\u001f\u007f]/u.test(decoded)
  ) {
    throw new TypeError('Bridge file uploads require a safe basename');
  }
  return name;
}

function requireUserFileUrl(url) {
  const prefix = '/user/files/';
  if (typeof url !== 'string' || !url.startsWith(prefix)) {
    throw new TypeError('Only /user/files/ paths may be accessed by the bridge file host');
  }
  const name = url.slice(prefix.length);
  requireUserFileName(name);
  return `${prefix}${name}`;
}

function bytesToBase64(bytes) {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function createBrowserHost({
  extensionSettings,
  localStorage,
  pluginVersions,
  saveSettingsDebounced,
  saveSettingsImmediate = null,
  tavernHelperProvider = () => globalThis.TavernHelper,
  indexedDB = globalThis.indexedDB,
  IDBKeyRange = globalThis.IDBKeyRange,
  BroadcastChannelImpl = globalThis.BroadcastChannel,
  documentImpl = globalThis.document,
  CustomEventImpl = globalThis.CustomEvent,
  runtimeGlobal = globalThis,
  fetchImpl = globalThis.fetch,
}) {
  const persistSettingsSoon = () => {
    if (typeof saveSettingsImmediate === 'function') {
      queueMicrotask(() => {
        Promise.resolve(saveSettingsImmediate()).catch(error => {
          console.warn('[TT Extension Sync Bridge] immediate settings persistence failed:', error);
          saveSettingsDebounced();
        });
      });
      return;
    }
    saveSettingsDebounced();
  };

  const requestHeaders = () => {
    const getRequestHeaders = runtimeGlobal?.SillyTavern?.getRequestHeaders;
    if (typeof getRequestHeaders === 'function') return getRequestHeaders();
    return { 'Content-Type': 'application/json' };
  };

  const tavernHelperScripts = {
    get() {
      const helper = tavernHelperProvider?.();
      if (typeof helper?.getScriptTrees !== 'function' || typeof helper?.replaceScriptTrees !== 'function') {
        return { available: false, trees: [] };
      }
      const trees = helper.getScriptTrees({ type: 'global' });
      return Array.isArray(trees)
        ? { available: true, trees: clone(trees) }
        : { available: false, trees: [] };
    },
    replace(trees) {
      const helper = tavernHelperProvider?.();
      if (typeof helper?.getScriptTrees !== 'function' || typeof helper?.replaceScriptTrees !== 'function') {
        return { available: false, trees: [] };
      }
      helper.replaceScriptTrees(clone(trees), { type: 'global' });
      const verified = helper.getScriptTrees({ type: 'global' });
      if (!Array.isArray(verified)) return { available: false, trees: [] };
      persistSettingsSoon();
      return { available: true, trees: clone(verified) };
    },
  };

  return {
    extensionSettings: {
      get(key) {
        return clone(extensionSettings[key]);
      },
      set(key, value) {
        extensionSettings[key] = clone(value);
      },
    },
    localStorage: {
      get(key) {
        return localStorage.getItem(key);
      },
      set(key, value) {
        localStorage.setItem(key, String(value));
      },
    },
    files: {
      async download(url) {
        const response = await fetchImpl(requireUserFileUrl(url), { cache: 'no-cache' });
        if (!response.ok) throw new Error(`Bridge user file read failed: ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      },
      async upload(name, bytes) {
        const response = await fetchImpl('/api/files/upload', {
          body: JSON.stringify({ data: bytesToBase64(bytes), name: requireUserFileName(name) }),
          headers: requestHeaders(),
          method: 'POST',
        });
        if (!response.ok) throw new Error(`Bridge user file upload failed: ${response.status}`);
        const result = await response.json();
        try {
          return requireUserFileUrl(result?.path);
        } catch {
          throw new Error('Bridge user file upload response is invalid');
        }
      },
      async delete(url) {
        const response = await fetchImpl('/api/files/delete', {
          body: JSON.stringify({ path: requireUserFileUrl(url) }),
          headers: requestHeaders(),
          method: 'POST',
        });
        if (!response.ok && response.status !== 404) {
          throw new Error(`Bridge user file delete failed: ${response.status}`);
        }
      },
    },
    indexedDb: createIndexedDbHost({ indexedDB, IDBKeyRange }),
    broadcast: {
      post(channel, message) {
        if (typeof BroadcastChannelImpl !== 'function') return false;
        const broadcaster = new BroadcastChannelImpl(channel);
        try {
          broadcaster.postMessage(clone(message));
          return true;
        } finally {
          broadcaster.close?.();
        }
      },
    },
    stChatu8: {
      async refresh() {
        if (documentImpl?.dispatchEvent && typeof CustomEventImpl === 'function') {
          documentImpl.dispatchEvent(new CustomEventImpl('st-chatu8-config-updated', {
            detail: { changed: { $ttSyncBridge: true } },
          }));
        }
        const reload = runtimeGlobal?.loadSilterTavernChatu8Settings;
        if (typeof reload === 'function') await reload();
      },
    },
    pluginVersion(pluginId) {
      return pluginVersions[pluginId] ?? null;
    },
    tavernHelperScripts,
    hasTavernScript(scriptId) {
      const authoritative = tavernHelperScripts.get();
      const trees = authoritative.available
        ? authoritative.trees
        : extensionSettings.tavern_helper?.script?.scripts;
      return flattenScripts(trees).some(script => script?.id === scriptId);
    },
    async saveSettings() {
      if (typeof saveSettingsImmediate === 'function') {
        await saveSettingsImmediate();
      } else {
        saveSettingsDebounced();
      }
    },
  };
}

export async function loadPluginVersions({
  pluginFolders = ['JS-Slash-Runner', 'st-chatu8'],
  fetchImpl = globalThis.fetch,
} = {}) {
  const versions = {};
  await Promise.all(pluginFolders.map(async folder => {
    try {
      const response = await fetchImpl(`/scripts/extensions/third-party/${encodeURIComponent(folder)}/manifest.json`, {
        cache: 'no-store',
      });
      if (!response.ok) return;
      const manifest = await response.json();
      if (manifest && typeof manifest.version === 'string' && manifest.version.trim()) {
        versions[`third-party/${folder}`] = manifest.version;
      }
    } catch {
      // A missing optional target is a normal state. Its snapshot remains in Extension Store.
    }
  }));
  return versions;
}
import { createIndexedDbHost } from './indexeddb-host.js';
