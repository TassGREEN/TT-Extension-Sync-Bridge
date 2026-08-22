import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDiagnostics } from '../src/core/diagnostics.js';

const DATABASE_ID = '8e1213cb-732a-444b-8a80-631e1cf614b5';

test('diagnostics expose only safe Tavern Helper snapshot coverage metadata', async () => {
  const snapshotStore = {
    async getSnapshot() {
      return {
        schemaVersion: 1,
        adapterId: 'tavern-helper-global-scripts',
        adapterVersion: 1,
        sourceRevision: 1,
        capturedAt: '2026-08-22T12:00:00.000Z',
        deviceId: 'source-device',
        contentHash: 'content-hash',
        nonSensitiveHash: 'non-sensitive-hash',
        sensitiveDataIncluded: false,
        payload: {
          dataVersion: 1,
          pluginVersion: '4.9.3',
          records: [{
            record: {
              type: 'script',
              id: DATABASE_ID,
              name: 'database',
              content: 'must-not-leak-script-content',
              data: { apiKey: 'must-not-leak-secret' },
            },
            path: { kind: 'root', treeIndex: 0 },
          }],
        },
      };
    },
  };
  const localState = { getAdapterState: () => ({}) };

  const diagnostics = await buildDiagnostics({
    adapters: [{ id: 'tavern-helper-global-scripts', label: '酒馆助手全局脚本', version: 1 }],
    snapshotStore,
    localState,
    bridgeVersion: '0.2.7',
  });
  const serialized = JSON.stringify(diagnostics);
  const summary = diagnostics.adapters[0].snapshot.payloadSummary;

  assert.deepEqual(summary, {
    recordCount: 1,
    targetScriptIds: [DATABASE_ID],
  });
  assert.equal(serialized.includes('must-not-leak-script-content'), false);
  assert.equal(serialized.includes('must-not-leak-secret'), false);
});
