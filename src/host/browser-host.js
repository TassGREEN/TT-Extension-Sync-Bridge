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
