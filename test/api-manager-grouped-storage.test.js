import test from 'node:test';
import assert from 'node:assert/strict';

import { API_MANAGER_SCRIPT_ID, apiManagerAdapter } from '../src/adapters/api-manager-adapter.js';
import { createPassphraseSensitiveCodec } from '../src/core/sensitive-envelope.js';
import { createMemoryHost } from './helpers/memory-host.js';

function groupedStore(model = 'model-a', key = 'source-secret') {
  return {
    version: 2,
    format: 'grouped-api-configs',
    groups: [{
      groupName: 'Primary',
      groupKey: 'primary|https://source.private/v1',
      source: 'custom',
      customUrl: 'https://source.private/v1',
      apiKeys: [{ id: 'key-1', key }],
      enableKeyRotation: true,
      models: [{
        name: `[Primary] ${model}`,
        customModel: model,
        currentKeyIndex: 0,
        categoryId: 'cat-1',
        categoryIds: ['cat-1'],
        isActive: true,
        lastHealthStatus: 'healthy',
        isPlaceholder: false,
      }],
    }],
  };
}

function hostWithStore(store) {
  const host = createMemoryHost({
    localStorage: {
      api_configs_manager: JSON.stringify(store),
      api_configs_categories: JSON.stringify([{ id: 'cat-1', name: '常用', color: '#ffffff', order: 0 }]),
      api_configs_category_switch_indexes: JSON.stringify({ 'cat-1': 0 }),
      stb_api_management_settings: JSON.stringify({ enabled: true, lockTavernConfig: true }),
    },
  });
  host.hasTavernScript = id => id === API_MANAGER_SCRIPT_ID;
  return host;
}

test('API manager captures official 2.1.1 grouped-api-configs storage', async () => {
  const codec = createPassphraseSensitiveCodec('grouped api manager passphrase');
  const host = hostWithStore(groupedStore());

  const captured = await apiManagerAdapter.capture(host, { includeSensitive: true, sensitiveCodec: codec });
  const decrypted = await codec.decrypt(captured.payload.encryptedConfigs, 'api-manager-2/configs/v1');
  const probe = apiManagerAdapter.diagnose(host);

  assert.equal(captured.sourceVersion, '2.1.1-storage');
  assert.equal(captured.diagnostics.configStorageShape, 'grouped-api-configs');
  assert.equal(probe.configStorageShape, 'grouped-api-configs');
  assert.equal(probe.configStorageReadable, true);
  assert.equal(probe.configCount, 1);
  assert.deepEqual(probe.configStorageCandidatePath, ['groups']);
  assert.equal(decrypted.configs.length, 1);
  assert.equal(decrypted.configs[0].name, '[Primary] model-a');
  assert.equal(decrypted.configs[0].customModel, 'model-a');
  assert.equal(decrypted.configs[0].apiKeys[0].key, 'source-secret');
});

test('API manager restore preserves grouped storage dialect on a grouped target', async () => {
  const codec = createPassphraseSensitiveCodec('grouped restore passphrase');
  const source = hostWithStore(groupedStore('model-a', 'source-secret'));
  const captured = await apiManagerAdapter.capture(source, { includeSensitive: true, sensitiveCodec: codec });
  const target = hostWithStore(groupedStore('old-model', 'old-secret'));

  assert.equal((await apiManagerAdapter.restore(target, captured.payload, { sensitiveCodec: codec })).status, 'applied');
  const stored = JSON.parse(target.inspect().localStorage.api_configs_manager);

  assert.equal(stored.format, 'grouped-api-configs');
  assert.equal(stored.version, 2);
  assert.equal(stored.groups.length, 1);
  assert.equal(stored.groups[0].models[0].customModel, 'model-a');
  assert.equal(stored.groups[0].apiKeys[0].key, 'source-secret');
  assert.equal((await apiManagerAdapter.restore(target, captured.payload, { sensitiveCodec: codec })).status, 'noop');
});

test('API manager restore uses legacy-compatible raw array on a clean target', async () => {
  const codec = createPassphraseSensitiveCodec('clean restore passphrase');
  const source = hostWithStore(groupedStore());
  const captured = await apiManagerAdapter.capture(source, { includeSensitive: true, sensitiveCodec: codec });
  const target = createMemoryHost();
  target.hasTavernScript = id => id === API_MANAGER_SCRIPT_ID;

  assert.equal((await apiManagerAdapter.restore(target, captured.payload, { sensitiveCodec: codec })).status, 'applied');
  const stored = JSON.parse(target.inspect().localStorage.api_configs_manager);

  assert.equal(Array.isArray(stored), true);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].customModel, 'model-a');
  assert.equal(stored[0].apiKeys[0].key, 'source-secret');
});
