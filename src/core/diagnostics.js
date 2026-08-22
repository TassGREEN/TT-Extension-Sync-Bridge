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

function stringArray(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string').map(redactText) : [];
}

function sanitizeProbe(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const tree = value.tree && typeof value.tree === 'object' && !Array.isArray(value.tree)
    ? {
        rootEntryCount: Number.isInteger(value.tree.rootEntryCount) ? value.tree.rootEntryCount : null,
        rootScriptCount: Number.isInteger(value.tree.rootScriptCount) ? value.tree.rootScriptCount : null,
        folderCount: Number.isInteger(value.tree.folderCount) ? value.tree.folderCount : null,
        folderScriptCount: Number.isInteger(value.tree.folderScriptCount) ? value.tree.folderScriptCount : null,
        unsupportedEntryCount: Number.isInteger(value.tree.unsupportedEntryCount)
          ? value.tree.unsupportedEntryCount
          : null,
      }
    : null;
  return {
    pluginVersion: typeof value.pluginVersion === 'string' ? redactText(value.pluginVersion) : null,
    pluginVersionSupported: value.pluginVersionSupported === true,
    authoritativeApiAvailable: value.authoritativeApiAvailable === true,
    settingsPresent: value.settingsPresent === true,
    scriptTreePresent: value.scriptTreePresent === true,
    tree,
    foundTargetIds: stringArray(value.foundTargetIds),
    missingTargetIds: stringArray(value.missingTargetIds),
  };
}

function sanitizeRuntimeDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { tavernHelperTimeline: [] };
  }
  const timeline = Array.isArray(value.tavernHelperTimeline)
    ? value.tavernHelperTimeline.slice(-64).map(item => ({
        at: typeof item?.at === 'string' ? redactText(item.at) : null,
        source: typeof item?.source === 'string' ? redactText(item.source) : null,
        resultStatus: typeof item?.resultStatus === 'string' ? redactText(item.resultStatus) : null,
        foundTargetIds: stringArray(item?.foundTargetIds),
        missingTargetIds: stringArray(item?.missingTargetIds),
        rootEntryCount: Number.isInteger(item?.rootEntryCount) ? item.rootEntryCount : null,
        error: typeof item?.error === 'string' ? redactText(item.error) : null,
      }))
    : [];
  return { tavernHelperTimeline: timeline };
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
    reason: typeof state.lastResult?.reason === 'string' ? redactText(state.lastResult.reason) : null,
    missingScriptIds: stringArray(state.lastResult?.diagnostics?.missingScriptIds),
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
  adapterProbes = {},
  runtimeDiagnostics = {},
  bridgeVersion = null,
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
      probe: sanitizeProbe(adapterProbes[adapter.id]),
    });
  }
  return {
    schema: 'tt-extension-sync-bridge-diagnostics/v2',
    bridgeVersion: typeof bridgeVersion === 'string' ? redactText(bridgeVersion) : null,
    generatedAt,
    pluginVersions: { ...pluginVersions },
    adapters: adapterDiagnostics,
    runtime: sanitizeRuntimeDiagnostics(runtimeDiagnostics),
    privacy: {
      includesSnapshotPayloads: false,
      includesChatData: false,
      includesCredentialValues: false,
    },
  };
}
