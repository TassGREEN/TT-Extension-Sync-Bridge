import { createSnapshot, verifySnapshot } from './snapshot.js';
import { sha256Json } from './hash.js';
import { stripRedacted } from './redaction.js';

async function payloadForSnapshot(adapter, snapshot) {
  if (snapshot.adapterVersion === adapter.version) return snapshot.payload;
  if (typeof adapter.migratePayload !== 'function') {
    throw new Error(`Adapter ${adapter.id} has no migration from version ${snapshot.adapterVersion}`);
  }
  const migrated = await adapter.migratePayload(snapshot.payload, snapshot.adapterVersion);
  if (migrated === undefined) {
    throw new Error(`Adapter ${adapter.id} migration returned no payload`);
  }
  return migrated;
}

export class BridgeController {
  constructor({ adapters, snapshotStore, localState, host, deviceId, now = () => new Date().toISOString() }) {
    this.adapters = new Map(adapters.map(adapter => [adapter.id, adapter]));
    this.snapshotStore = snapshotStore;
    this.localState = localState;
    this.host = host;
    this.deviceId = deviceId;
    this.now = now;
  }

  getAdapter(adapterId) {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new Error(`Unknown adapter: ${adapterId}`);
    return adapter;
  }

  listAdapters() {
    return [...this.adapters.values()];
  }

  async diagnoseAdapter(adapterId) {
    const adapter = this.getAdapter(adapterId);
    return typeof adapter.diagnose === 'function' ? adapter.diagnose(this.host) : null;
  }

  async capture(adapterId, { includeSensitive = false, sensitiveCodec } = {}) {
    const adapter = this.getAdapter(adapterId);
    const captured = await adapter.capture(this.host, { includeSensitive, sensitiveCodec });
    if (!captured.available) {
      const result = { status: 'missing-target', adapterId, diagnostics: captured.diagnostics };
      this.localState.setAdapterState(adapterId, { lastResult: result, lastCheckedAt: this.now() });
      return result;
    }
    if (captured.status === 'deferred') {
      const result = {
        status: 'deferred',
        adapterId,
        reason: captured.reason,
        diagnostics: captured.diagnostics,
      };
      this.localState.setAdapterState(adapterId, {
        lastResult: result,
        lastCheckedAt: this.now(),
        error: null,
      });
      return result;
    }

    const previous = await this.snapshotStore.getSnapshot(adapterId);
    if (previous !== null) {
      await verifySnapshot(previous, { adapterId, adapterVersion: adapter.version });
      if (previous.sensitiveDataIncluded && !includeSensitive) {
        throw new Error('Refusing to replace an encrypted snapshot without sensitive sync enabled');
      }
    }
    const nextRevision = previous === null ? 1 : previous.sourceRevision + 1;
    const snapshot = await createSnapshot({
      adapterId,
      adapterVersion: adapter.version,
      sourceRevision: nextRevision,
      capturedAt: this.now(),
      deviceId: this.deviceId,
      sensitiveDataIncluded: includeSensitive,
      payload: captured.payload,
    });

    if (previous?.nonSensitiveHash === snapshot.nonSensitiveHash) {
      this.localState.setAdapterState(adapterId, {
        lastCapturedHash: previous.nonSensitiveHash,
        lastCapturedContentHash: previous.contentHash,
        lastCheckedAt: this.now(),
        lastResult: { status: 'unchanged' },
      });
      return { status: 'unchanged', adapterId, snapshot: previous, diagnostics: captured.diagnostics };
    }

    await this.snapshotStore.putSnapshot(snapshot);
    this.localState.setAdapterState(adapterId, {
      lastCapturedHash: snapshot.nonSensitiveHash,
      lastCapturedContentHash: snapshot.contentHash,
      lastCapturedAt: snapshot.capturedAt,
      lastResult: { status: 'captured' },
      error: null,
      conflict: null,
    });
    return { status: 'captured', adapterId, snapshot, diagnostics: captured.diagnostics };
  }

  async previewRestore(adapterId, { sensitiveCodec } = {}) {
    const adapter = this.getAdapter(adapterId);
    const snapshot = await this.snapshotStore.getSnapshot(adapterId);
    if (snapshot === null) return { status: 'no-snapshot', adapterId };
    await verifySnapshot(snapshot, { adapterId, adapterVersion: adapter.version });
    const adapterPayload = await payloadForSnapshot(adapter, snapshot);

    const adapterPreview = await adapter.preview(this.host, adapterPayload, { sensitiveCodec });
    if (adapterPreview.status === 'conflict') {
      return { ...adapterPreview, adapterId, snapshot, adapterPayload, hardConflict: true };
    }
    if (['missing-target', 'incompatible', 'deferred', 'locked'].includes(adapterPreview.status)) {
      return { ...adapterPreview, adapterId, snapshot, adapterPayload };
    }
    if (adapterPreview.status === 'empty-target') {
      return { status: 'would-change', adapterId, snapshot, adapterPayload, emptyTarget: true };
    }
    if (adapterPreview.status === 'would-change' && adapterPreview.safeToApply === true) {
      return { status: 'would-change', adapterId, snapshot, adapterPayload, safeToApply: true };
    }

    const current = await adapter.capture(this.host, { includeSensitive: false });
    if (!current.available) return { status: 'missing-target', adapterId, snapshot };
    const currentHash = await sha256Json(stripRedacted(current.payload));
    if (currentHash === snapshot.nonSensitiveHash || adapterPreview.status === 'noop') {
      return { status: 'noop', adapterId, snapshot, adapterPayload, currentHash };
    }

    const state = this.localState.getAdapterState(adapterId);
    const hasSafeBaseline = (
      state.lastAppliedHash === currentHash
      || state.lastCapturedHash === currentHash
    );
    if (!hasSafeBaseline) {
      return {
        status: 'conflict',
        adapterId,
        snapshot,
        adapterPayload,
        currentHash,
        hardConflict: false,
        reason: state.lastAppliedHash || state.lastCapturedHash ? 'local-data-changed' : 'untracked-local-data',
      };
    }
    return { status: 'would-change', adapterId, snapshot, adapterPayload, currentHash };
  }

  async restore(adapterId, { confirmConflict = false, sensitiveCodec } = {}) {
    const preview = await this.previewRestore(adapterId, { sensitiveCodec });
    if (preview.status === 'noop') {
      this.localState.setAdapterState(adapterId, {
        lastAppliedHash: preview.snapshot.nonSensitiveHash,
        lastAppliedContentHash: preview.snapshot.contentHash,
        lastAppliedAt: this.now(),
        lastResult: { status: 'noop' },
        conflict: null,
        error: null,
      });
      return preview;
    }
    if (preview.status === 'conflict' && (preview.hardConflict || !confirmConflict)) {
      this.localState.setAdapterState(adapterId, {
        lastResult: { status: 'conflict' },
        conflict: { reason: preview.reason ?? 'adapter-conflict', conflicts: preview.conflicts ?? [] },
      });
      return preview;
    }
    if (['no-snapshot', 'missing-target', 'incompatible', 'deferred', 'locked'].includes(preview.status)) {
      this.localState.setAdapterState(adapterId, { lastResult: { status: preview.status } });
      return preview;
    }

    const adapter = this.getAdapter(adapterId);
    const result = await adapter.restore(this.host, preview.adapterPayload, { sensitiveCodec });
    if (result.status === 'applied' || result.status === 'noop') {
      this.localState.setAdapterState(adapterId, {
        lastAppliedHash: preview.snapshot.nonSensitiveHash,
        lastAppliedContentHash: preview.snapshot.contentHash,
        lastAppliedAt: this.now(),
        lastResult: { status: result.status },
        conflict: null,
        error: null,
      });
    } else {
      this.localState.setAdapterState(adapterId, { lastResult: { status: result.status } });
    }
    return { ...result, adapterId, snapshot: preview.snapshot };
  }

  async captureAll(adapterIds, options = {}) {
    const results = [];
    for (const adapterId of adapterIds) {
      try {
        results.push(await this.capture(adapterId, options));
      } catch (error) {
        this.localState.setAdapterState(adapterId, {
          lastResult: { status: 'failed' },
          error: { message: error instanceof Error ? error.message : String(error) },
        });
        results.push({ status: 'failed', adapterId, error });
      }
    }
    return results;
  }

  async restoreAll(adapterIds, { automatic = false, sensitiveCodec } = {}) {
    const results = [];
    for (const adapterId of adapterIds) {
      try {
        results.push(await this.restore(adapterId, { confirmConflict: false, automatic, sensitiveCodec }));
      } catch (error) {
        this.localState.setAdapterState(adapterId, {
          lastResult: { status: 'failed' },
          error: { message: error instanceof Error ? error.message : String(error) },
        });
        results.push({ status: 'failed', adapterId, error });
      }
    }
    return results;
  }
}
