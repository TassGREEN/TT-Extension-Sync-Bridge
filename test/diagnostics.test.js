import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDiagnostics } from '../src/core/diagnostics.js';

test('exported diagnostics omit payloads and redact credential-like error text', async () => {
  const snapshotStore = {
    async getSnapshot() {
      return {
        schemaVersion: 1,
        adapterId: 'example',
        adapterVersion: 1,
        sourceRevision: 2,
        capturedAt: '2026-08-22T12:00:00.000Z',
        deviceId: 'source-device',
        contentHash: 'abcdef0123456789',
        sensitiveDataIncluded: false,
        payload: { apiKey: 'must-never-export' },
      };
    },
  };
  const localState = {
    getAdapterState() {
      return {
        lastAppliedHash: 'abcdef0123456789',
        lastResult: {
          status: 'deferred',
          reason: 'target-scripts-not-fully-initialized',
          diagnostics: {
            missingScriptIds: ['missing-id'],
            secret: 'must-never-export-from-local-state',
          },
        },
        error: { message: 'request failed with sk-abcdefghijklmnopqrstuvwxyz at https://private.example/v1' },
      };
    },
  };

  const diagnostics = await buildDiagnostics({
    adapters: [{ id: 'example', label: 'Example', version: 1 }],
    snapshotStore,
    localState,
    pluginVersions: { 'third-party/example': '1.2.3' },
    adapterProbes: {
      example: {
        pluginVersion: '4.9.3',
        authoritativeApiAvailable: true,
        settingsPresent: true,
        scriptTreePresent: true,
        tree: {
          rootEntryCount: 1,
          rootScriptCount: 1,
          folderCount: 0,
          folderScriptCount: 0,
          unsupportedEntryCount: 0,
        },
        foundTargetIds: ['found-id'],
        missingTargetIds: ['missing-id'],
        secret: 'must-never-export-from-probe',
      },
    },
    runtimeDiagnostics: {
      tavernHelperTimeline: [{
        at: '2026-08-22T12:00:30.000Z',
        source: 'SETTINGS_UPDATED observed https://private.example/settings',
        resultStatus: 'deferred',
        foundTargetIds: ['found-id'],
        missingTargetIds: ['missing-id'],
        rootEntryCount: 1,
        error: 'Bearer abcdefghijklmnopqrstuvwxyz',
        secret: 'must-never-export-from-runtime',
      }],
    },
    bridgeVersion: '0.2.6',
    generatedAt: '2026-08-22T12:01:00.000Z',
  });
  const serialized = JSON.stringify(diagnostics);

  assert.equal(serialized.includes('must-never-export'), false);
  assert.equal(serialized.includes('sk-abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(serialized.includes('private.example'), false);
  assert.equal(serialized.includes('must-never-export-from-local-state'), false);
  assert.equal(serialized.includes('must-never-export-from-probe'), false);
  assert.equal(serialized.includes('must-never-export-from-runtime'), false);
  assert.equal(serialized.includes('Bearer abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(diagnostics.adapters[0].snapshot.contentHash, 'abcdef0123456789');
  assert.equal(diagnostics.adapters[0].snapshot.sourceDeviceId, 'source-device');
  assert.equal(diagnostics.bridgeVersion, '0.2.6');
  assert.match(diagnostics.adapters[0].local.error.message, /\[REDACTED\]/);
  assert.equal(diagnostics.adapters[0].local.reason, 'target-scripts-not-fully-initialized');
  assert.deepEqual(diagnostics.adapters[0].local.missingScriptIds, ['missing-id']);
  assert.deepEqual(diagnostics.adapters[0].probe.missingTargetIds, ['missing-id']);
  assert.equal(diagnostics.adapters[0].probe.authoritativeApiAvailable, true);
  assert.equal(diagnostics.runtime.tavernHelperTimeline.length, 1);
  assert.equal(diagnostics.runtime.tavernHelperTimeline[0].source.includes('private.example'), false);
  assert.deepEqual(diagnostics.runtime.tavernHelperTimeline[0].missingTargetIds, ['missing-id']);
});
