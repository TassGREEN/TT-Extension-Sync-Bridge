import { eventSource, event_types, saveSettings, saveSettingsDebounced } from '/script.js';
import { extension_settings } from '/scripts/extensions.js';

import { apiManagerAdapter } from './src/adapters/api-manager-adapter.js';
import { databaseAdapter } from './src/adapters/database-adapter.js';
import { dreamCardAgentAdapter } from './src/adapters/dream-card-agent-adapter.js';
import { stChatu8Adapter } from './src/adapters/st-chatu8-adapter.js';
import { tavernHelperScriptsAdapter } from './src/adapters/tavern-helper-scripts-adapter.js';
import { BridgeController } from './src/core/bridge-controller.js';
import { createPassphraseSensitiveCodec } from './src/core/sensitive-envelope.js';
import { createBrowserHost, loadPluginVersions } from './src/host/browser-host.js';
import { ExtensionStoreSnapshotStore } from './src/store/extension-store-snapshot-store.js';
import {
  BridgeLocalStateStore,
  BridgePassphraseStore,
  BridgePreferencesStore,
} from './src/store/local-state-store.js';
import { mountBridgeSettingsPanel } from './src/ui/settings-panel.js';

const adapters = [
  tavernHelperScriptsAdapter,
  databaseAdapter,
  apiManagerAdapter,
  dreamCardAgentAdapter,
  stChatu8Adapter,
];
const BRIDGE_VERSION = '0.2.5';
const TAVERN_HELPER_RECONCILE_DELAYS = [1500, 4000, 9000];

async function start() {
  const tauriHost = globalThis.__TAURITAVERN__;
  if (!tauriHost) {
    console.warn('[TT Extension Sync Bridge] TauriTavern host is unavailable; bridge disabled.');
    return;
  }
  await (tauriHost.ready ?? globalThis.__TAURITAVERN_MAIN_READY__);
  const extensionStoreApi = tauriHost.api?.extension?.store;
  if (!extensionStoreApi?.setJson || !extensionStoreApi?.tryGetJson) {
    throw new Error('TauriTavern Extension Store API is unavailable');
  }

  const pluginVersions = await loadPluginVersions();
  const host = createBrowserHost({
    extensionSettings: extension_settings,
    localStorage: globalThis.localStorage,
    pluginVersions,
    saveSettingsDebounced,
    saveSettingsImmediate: saveSettings,
  });
  const preferences = new BridgePreferencesStore(globalThis.localStorage);
  const passphrases = new BridgePassphraseStore(globalThis.localStorage);
  const localState = new BridgeLocalStateStore(globalThis.localStorage);
  const snapshotStore = new ExtensionStoreSnapshotStore(extensionStoreApi);
  const controller = new BridgeController({
    adapters,
    snapshotStore,
    localState,
    host,
    deviceId: localState.deviceId,
  });
  const runtime = {
    controller,
    snapshotStore,
    localState,
    preferences,
    passphrases,
    pluginVersions,
    bridgeVersion: BRIDGE_VERSION,
  };
  globalThis.TTExtensionSyncBridge = Object.freeze({
    capture: (adapterId, options) => controller.capture(adapterId, options),
    previewRestore: (adapterId, options) => controller.previewRestore(adapterId, options),
    restore: (adapterId, options) => controller.restore(adapterId, options),
    listAdapters: () => controller.listAdapters().map(adapter => ({ id: adapter.id, label: adapter.label })),
  });

  const enabledAdapterIds = () => {
    const value = preferences.get();
    return adapters.map(adapter => adapter.id).filter(id => value.adapters[id]);
  };

  const savedSensitiveCodec = () => {
    if (!preferences.get().sensitiveDataSync) return null;
    const passphrase = passphrases.get();
    return passphrase ? createPassphraseSensitiveCodec(passphrase) : null;
  };

  const captureAdapters = async (adapterIds, sensitiveCodec) => {
    const results = [];
    for (const adapterId of adapterIds) {
      results.push(...await controller.captureAll([adapterId], {
        includeSensitive: adapterId === dreamCardAgentAdapter.id && sensitiveCodec !== null,
        sensitiveCodec,
      }));
    }
    return results;
  };

  const reconcileTavernHelper = async source => {
    const value = preferences.get();
    if (!value.masterEnabled || !value.adapters[tavernHelperScriptsAdapter.id]) return;
    try {
      const result = await controller.restore(tavernHelperScriptsAdapter.id, {
        confirmConflict: false,
        sensitiveCodec: savedSensitiveCodec(),
      });
      if (result.status === 'applied') {
        console.info(`[TT Extension Sync Bridge] Tavern Helper scripts reconciled after ${source}.`);
      }
      await settingsPanel?.refreshStatus();
    } catch (error) {
      console.warn(
        `[TT Extension Sync Bridge] Tavern Helper reconciliation after ${source} failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const scheduleTavernHelperReconcile = () => {
    for (const delay of TAVERN_HELPER_RECONCILE_DELAYS) {
      setTimeout(() => { void reconcileTavernHelper(`${delay}ms stabilization check`); }, delay);
    }
  };

  if (preferences.get().masterEnabled) {
    const earlyResults = await controller.restoreAll(enabledAdapterIds(), {
      automatic: true,
      sensitiveCodec: savedSensitiveCodec(),
    });
    const failures = earlyResults.filter(result => result.status === 'failed');
    if (failures.length > 0) {
      console.warn(`[TT Extension Sync Bridge] ${failures.length} early restore adapter(s) failed.`);
    }
  }

  let settingsPanel = null;
  const mount = () => {
    settingsPanel = mountBridgeSettingsPanel(runtime);
    if (settingsPanel) return;
    setTimeout(mount, 250);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }

  eventSource.once(event_types.EXTENSION_SETTINGS_LOADED, async () => {
    const value = preferences.get();
    if (!value.masterEnabled) return;
    const sensitiveCodec = savedSensitiveCodec();
    const postLoadResults = await controller.restoreAll(enabledAdapterIds(), {
      automatic: true,
      sensitiveCodec,
    });
    scheduleTavernHelperReconcile();
    if (value.autoCapture) {
      const blocked = new Set(
        postLoadResults
          .filter(result => ['deferred', 'locked', 'conflict', 'incompatible', 'failed'].includes(result.status))
          .map(result => result.adapterId),
      );
      await captureAdapters(enabledAdapterIds().filter(adapterId => !blocked.has(adapterId)), sensitiveCodec);
    }
    await settingsPanel?.refreshStatus();
  });

  if (event_types.APP_READY) {
    eventSource.once(event_types.APP_READY, () => { void reconcileTavernHelper('APP_READY'); });
  }
  eventSource.once('chatLoaded', () => { void reconcileTavernHelper('chatLoaded'); });
}

try {
  await start();
} catch (error) {
  console.error('[TT Extension Sync Bridge] startup failed:', error instanceof Error ? error.message : String(error));
  globalThis.toastr?.error('TT Extension Sync Bridge 启动失败，请导出脱敏诊断或查看前端日志。');
}
