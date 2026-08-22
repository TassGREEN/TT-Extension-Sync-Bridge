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
  tavernHelperProvider = () => globalThis.TavernHelper,
  indexedDB = globalThis.indexedDB,
  IDBKeyRange = globalThis.IDBKeyRange,
}) {
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
        return { available: false };
      }
      helper.replaceScriptTrees(clone(trees), { type: 'global' });
      return { available: true };
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
      saveSettingsDebounced();
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
