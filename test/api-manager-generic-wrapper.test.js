import test from 'node:test';
import assert from 'node:assert/strict';

import { API_MANAGER_SCRIPT_ID, apiManagerAdapter } from '../src/adapters/api-manager-adapter.js';
import { createPassphraseSensitiveCodec } from '../src/core/sensitive-envelope.js';
import { createMemoryHost } from './helpers/memory-host.js';

function config(name = 'Primary', model = 'model-a') {
  return {
    name: `[${name}] ${model}`,
    source: 'custom',
    customUrl: 'https://private.example/v1',
    apiKeys: [{ id: `${name}-key`, key: 'private-secret' }],
    currentKeyIndex: 0,
    enableKeyRotation: false,
    customModel: model,
    groupName: name,
    groupKey: `${name}-group`,
    categoryIds: [],
    isActive: true,
  };
}

function hostWithConfigs(value) {
  const host = createMemoryHost({
    localStorage: {
      api_configs_manager: JSON.stringify(value),
      api_configs_categories: JSON.stringify([]),
      api_configs_category_switch_indexes: JSON.stringify({}),
      stb_api_management_settings: JSON.stringify({ enabled: true, lockTavernConfig: true }),
    },
  });
  host.hasTavernScript = id => id === API_MANAGER_SCRIPT_ID;
  return host;
}

test('API manager capture accepts a unique config array inside an unknown nested wrapper', async () => {
  const codec = createPassphraseSensitiveCodec('generic wrapper passphrase');
  const sourceConfigs = [config()];
  const host = hostWithConfigs({ state: { savedItems: sourceConfigs }, revision: 3 });

  const captured = await apiManagerAdapter.capture(host, { includeSensitive: true, sensitiveCodec: codec });
  const decrypted = await codec.decrypt(captured.payload.encryptedConfigs, 'api-manager-2/configs/v1');
  const probe = apiManagerAdapter.diagnose(host);

  assert.deepEqual(decrypted.configs, sourceConfigs);
  assert.equal(captured.diagnostics.configStorageShape, 'generic-wrapper-configs');
  assert.equal(probe.configStorageShape, 'generic-wrapper-configs');
  assert.equal(probe.configStorageReadable, true);
  assert.equal(probe.configCount, 1);
  assert.deepEqual(probe.configStorageCandidatePath, ['state', 'savedItems']);
  assert.deepEqual(probe.configStorageObjectFields, [
    { name: 'state', type: 'object' },
    { name: 'revision', type: 'number' },
  ]);
});

test('API manager capture accepts an object map whose values are API configs', async () => {
  const codec = createPassphraseSensitiveCodec('named map passphrase');
  const first = config('First', 'model-a');
  const second = config('Second', 'model-b');
  const host = hostWithConfigs({ first, second });

  const captured = await apiManagerAdapter.capture(host, { includeSensitive: true, sensitiveCodec: codec });
  const decrypted = await codec.decrypt(captured.payload.encryptedConfigs, 'api-manager-2/configs/v1');

  assert.deepEqual(decrypted.configs, [first, second]);
  assert.equal(captured.diagnostics.configStorageShape, 'named-config-map');
});

test('API manager leaves ambiguous wrapper objects fail-closed', async () => {
  const first = [config('First', 'model-a')];
  const second = [config('Second', 'model-b')];
  const host = hostWithConfigs({ first, second });
  const before = host.inspect().localStorage.api_configs_manager;

  await assert.rejects(
    () => apiManagerAdapter.capture(host),
    /unsupported storage shape: ambiguous-object/i,
  );
  assert.equal(host.inspect().localStorage.api_configs_manager, before);
  assert.equal(apiManagerAdapter.diagnose(host).configStorageShape, 'ambiguous-object');
});
