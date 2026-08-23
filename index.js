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
const BRIDGE_VERSION = '0.2.11';
const TAVERN_HELPER_RECONCILE_DELAYS = [1500, 4000, 9000];
const TAVERN_HELPER_OBSERVER_INTERVAL_MS = 2000;
const TAVERN_HELPER_OBSERVER_DURATION_MS = 120000;
const TAVERN_HELPER_SETTINGS_UPDATED_SETTLE_MS = 250;
const TAVERN_HELPER_TIMELINE_LIMIT = 64;

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
  const runtimeDiagnostics = { tavernHelperTimeline: [] };
  globalThis.TTExtensionSyncBridgeRuntimeDiagnostics = runtimeDiagnostics;
  const runtime = {
    controller,
    snapshotStore,
    localState,
    preferences,
    passphrases,
    pluginVersions,
    runtimeDiagnostics,
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

  let settingsPanel = null;
  let tavernHelperReconcileChain = Promise.resolve();
  let tavernHelperProbeSignature = null;
  let tavernHelperObserver = null;
  let tavernHelperObserverBusy = false;

  const appendTavernHelperTimeline = entry => {
    runtimeDiagnostics.tavernHelperTimeline.push(entry);
    if (runtimeDiagnostics.tavernHelperTimeline.length > TAVERN_HELPER_TIMELINE_LIMIT) {
      runtimeDiagnostics.tavernHelperTimeline.splice(
        0,
        runtimeDiagnostics.tavernHelperTimeline.length - TAVERN_HELPER_TIMELINE_LIMIT,
      );
    }
  };

  const observeTavernHelper = async (source, { resultStatus = null, onlyOnChange = false } = {}) => {
    try {
      const probe = await controller.diagnoseAdapter(tavernHelperScriptsAdapter.id);
      const foundTargetIds = Array.isArray(probe?.foundTargetIds) ? probe.foundTargetIds : [];
      const missingTargetIds = Array.isArray(probe?.missingTargetIds) ? probe.missingTargetIds : [];
      const rootEntryCount = Number.isInteger(probe?.tree?.rootEntryCount) ? probe.tree.rootEntryCount : null;
      const signature = JSON.stringify({ foundTargetIds, missingTargetIds, rootEntryCount });
      const changed = signature !== tavernHelperProbeSignature;
      tavernHelperProbeSignature = signature;
      if (!onlyOnChange || changed) {
        appendTavernHelperTimeline({
          at: new Date().toISOString(),
          source,
          resultStatus,
          foundTargetIds,
          missingTargetIds,
          rootEntryCount,
          error: null,
        });
      }
      return { changed, missingTargetIds };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendTavernHelperTimeline({
        at: new Date().toISOString(),
        source,
        resultStatus,
        foundTargetIds: [],
        missingTargetIds: [],
        rootEntryCount: null,
        error: message,
      });
      return { changed: true, missingTargetIds: [] };
    }
  };

  const reconcileTavernHelper = async source => {
    const value = preferences.get();
    if (!value.masterEnabled || !value.adapters[tavernHelperScriptsAdapter.id]) return;
    await observeTavernHelper(`${source}:before`, { onlyOnChange: true });
    try {
      const result = await controller.restore(tavernHelperScriptsAdapter.id, {
        confirmConflict: false,
        sensitiveCodec: savedSensitiveCodec(),
      });
      await observeTavernHelper(`${source}:after`, { resultStatus: result.status });
      if (result.status === 'applied') {
        console.info(`[TT Extension Sync Bridge] Tavern Helper scripts reconciled after ${source}.`);
      }
      await settingsPanel?.refreshStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendTavernHelperTimeline({
        at: new Date().toISOString(),
        source: `${source}:restore-error`,
        resultStatus: 'failed',
        foundTargetIds: [],
        missingTargetIds: [],
        rootEntryCount: null,
        error: message,
      });
      console.warn('[TT Extension Sync Bridge] Tavern Helper reconciliation failed:', message);
    }
  };

  const enqueueTavernHelperReconcile = source => {
    tavernHelperReconcileChain = tavernHelperReconcileChain
      .catch(() => undefined)
      .then(() => reconcileTavernHelper(source));
    return tavernHelperReconcileChain;
  };

  const scheduleTavernHelperReconcile = () => {
    for (const delay of TAVERN_HELPER_RECONCILE_DELAYS) {
      setTimeout(() => { void enqueueTavernHelperReconcile(`${delay}ms stabilization check`); }, delay);
    }
  };

  const startTavernHelperObserver = () => {
    if (tavernHelperObserver !== null) return;
    const stopAt = Date.now() + TAVERN_HELPER_OBSERVER_DURATION_MS;
    tavernHelperObserver = setInterval(async () => {
      if (Date.now() >= stopAt) {
        clearInterval(tavernHelperObserver);
        tavernHelperObserver = null;
        return;
      }
      if (tavernHelperObserverBusy) return;
      tavernHelperObserverBusy = true;
      try {
        const observation = await observeTavernHelper('startup-observer', { onlyOnChange: true });
        if (observation.changed && observation.missingTargetIds.length > 0) {
          void enqueueTavernHelperReconcile('startup observer detected target loss');
        }
      } finally {
        tavernHelperObserverBusy = false;
      }
    }, TAVERN_HELPER_OBSERVER_INTERVAL_MS);
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
    await observeTavernHelper('EXTENSION_SETTINGS_LOADED:restoreAll-complete');
    scheduleTavernHelperReconcile();
    startTavernHelperObserver();
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
    eventSource.once(event_types.APP_READY, () => { void enqueueTavernHelperReconcile('APP_READY'); });
  }
  eventSource.once('chatLoaded', () => { void enqueueTavernHelperReconcile('chatLoaded'); });
  if (event_types.SETTINGS_UPDATED) {
    eventSource.on(event_types.SETTINGS_UPDATED, () => {
      void observeTavernHelper('SETTINGS_UPDATED observed', { onlyOnChange: true });
      setTimeout(() => {
        void enqueueTavernHelperReconcile('SETTINGS_UPDATED');
      }, TAVERN_HELPER_SETTINGS_UPDATED_SETTLE_MS);
    });
  }
}

try {
  await start();
} catch (error) {
  console.error('[TT Extension Sync Bridge] startup failed:', error instanceof Error ? error.message : String(error));
  globalThis.toastr?.error('TT Extension Sync Bridge 启动失败，请导出脱敏诊断或查看前端日志。');
}
