import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDiagnostics } from '../src/core/diagnostics.js';

test('diagnostics preserve privacy-safe API Manager storage probe fields', async () => {
  const diagnostics = await buildDiagnostics({
    adapters: [{ id: 'api-manager-2', label: 'API Manager', version: 2 }],
    snapshotStore: { async getSnapshot() { return null; } },
    localState: { getAdapterState() { return {}; } },
    adapterProbes: {
      'api-manager-2': {
        sourceVersion: '2.0.3',
        configStorageShape: 'generic-wrapper-configs',
        configStorageReadable: true,
        configCount: 2,
        embeddedCategories: false,
        configStorageCandidatePath: ['state', 'savedItems'],
        configStorageObjectFields: [
          { name: 'state', type: 'object' },
          { name: 'https://private.example/secret', type: 'array' },
        ],
        secret: 'must-never-export',
      },
    },
    bridgeVersion: '0.2.11',
  });

  const probe = diagnostics.adapters[0].probe;
  const serialized = JSON.stringify(diagnostics);

  assert.equal(probe.sourceVersion, '2.0.3');
  assert.equal(probe.configStorageShape, 'generic-wrapper-configs');
  assert.equal(probe.configStorageReadable, true);
  assert.equal(probe.configCount, 2);
  assert.deepEqual(probe.configStorageCandidatePath, ['state', 'savedItems']);
  assert.deepEqual(probe.configStorageObjectFields, [
    { name: 'state', type: 'object' },
    { name: '[REDACTED_URL]', type: 'array' },
  ]);
  assert.equal(serialized.includes('private.example'), false);
  assert.equal(serialized.includes('must-never-export'), false);
});
