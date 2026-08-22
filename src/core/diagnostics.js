function redactText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{12,}/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/https?:\/\/[^\s"']+/gi, '[REDACTED_URL]');
}

function sanitizeError(error) {
  if (!error || typeof error !== 'object') return null;
  return { message: redactText(String(error.message ?? 'Unknown error')) };
}

function localSummary(state) {
  return {
    lastCapturedHash: state.lastCapturedHash ?? null,
    lastAppliedHash: state.lastAppliedHash ?? null,
    lastCapturedContentHash: state.lastCapturedContentHash ?? null,
    lastAppliedContentHash: state.lastAppliedContentHash ?? null,
    lastCapturedAt: state.lastCapturedAt ?? null,
    lastAppliedAt: state.lastAppliedAt ?? null,
    lastCheckedAt: state.lastCheckedAt ?? null,
    lastResult: state.lastResult?.status ?? null,
    conflict: state.conflict
      ? { reason: state.conflict.reason ?? 'unknown', count: state.conflict.conflicts?.length ?? 0 }
      : null,
    error: sanitizeError(state.error),
  };
}

export async function buildDiagnostics({
  adapters,
  snapshotStore,
  localState,
  pluginVersions = {},
  generatedAt = new Date().toISOString(),
}) {
  const adapterDiagnostics = [];
  for (const adapter of adapters) {
    let snapshot = null;
    let snapshotError = null;
    try {
      snapshot = await snapshotStore.getSnapshot(adapter.id);
    } catch (error) {
      snapshotError = sanitizeError(error instanceof Error ? error : { message: String(error) });
    }
    adapterDiagnostics.push({
      id: adapter.id,
      label: adapter.label,
      adapterVersion: adapter.version,
      snapshot: snapshot ? {
        schemaVersion: snapshot.schemaVersion,
        adapterVersion: snapshot.adapterVersion,
        sourceRevision: snapshot.sourceRevision,
        capturedAt: snapshot.capturedAt,
        sourceDeviceId: snapshot.deviceId,
        contentHash: snapshot.contentHash,
        nonSensitiveHash: snapshot.nonSensitiveHash,
        sensitiveDataIncluded: snapshot.sensitiveDataIncluded === true,
      } : null,
      snapshotError,
      local: localSummary(localState.getAdapterState(adapter.id)),
    });
  }
  return {
    schema: 'tt-extension-sync-bridge-diagnostics/v1',
    generatedAt,
    pluginVersions: { ...pluginVersions },
    adapters: adapterDiagnostics,
    privacy: {
      includesSnapshotPayloads: false,
      includesChatData: false,
      includesCredentialValues: false,
    },
  };
}
