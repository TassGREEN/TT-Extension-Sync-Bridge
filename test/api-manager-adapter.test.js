import test from 'node:test';
import assert from 'node:assert/strict';

import {
  API_MANAGER_SCRIPT_ID,
  apiManagerAdapter,
} from '../src/adapters/api-manager-adapter.js';
import { isRedacted } from '../src/core/redaction.js';
import { createPassphraseSensitiveCodec } from '../src/core/sensitive-envelope.js';
import { createMemoryHost } from './helpers/memory-host.js';

function configs(overrides = {}) {
  return [{
    name: '[Group] Example',
    source: 'custom',
    customUrl: 'https://source.private/v1',
    apiKeys: [{ id: 'key-1', key: 'source-key' }],
    currentKeyIndex: 0,
    enableKeyRotation: false,
    customModel: 'model-a',
    groupName: 'Group',
    groupKey: 'group',
    categoryIds: ['cat-1'],
    isActive: true,
    ...overrides,
  }];
}

function categories() {
  return [{ id: 'cat-1', name: 'Main', color: '#ffffff', order: 0 }];
}

function createApiManagerHost(localStorage = {}) {
  const host = createMemoryHost({ localStorage });
  host.hasTavernScript = id => id === API_MANAGER_SCRIPT_ID;
  return host;
}

function fullStorage() {
  return {
    api_configs_manager: JSON.stringify(configs()),
    api_configs_categories: JSON.stringify(categories()),
    api_configs_collapsed_categories: JSON.stringify(['cat-1']),
    api_configs_category_switch_indexes: JSON.stringify({ 'cat-1': 1 }),
    stb_api_management_settings: JSON.stringify({ enabled: true, lockTavernConfig: true }),
  };
}

test('API manager public capture never serializes configs or device-only UI state', async () => {
  const host = createApiManagerHost(fullStorage());
  const result = await apiManagerAdapter.capture(host);
  const serialized = JSON.stringify(result.payload);

  assert.equal(result.payload.dataVersion, 2);
  assert.equal(Object.hasOwn(result.payload, 'encryptedConfigs'), false);
  assert.equal(isRedacted(result.payload.entries.api_configs_manager), true);
  assert.equal(isRedacted(result.payload.entries.api_configs_collapsed_categories), true);
  assert.equal(serialized.includes('source-key'), false);
  assert.equal(serialized.includes('source.private'), false);
});

test('API manager encrypted capture restores a complete usable config on a clean device', async () => {
  const codec = createPassphraseSensitiveCodec('api manager portable passphrase');
  const source = createApiManagerHost(fullStorage());
  const captured = await apiManagerAdapter.capture(source, { includeSensitive: true, sensitiveCodec: codec });
  const serialized = JSON.stringify(captured.payload);

  assert.equal(captured.payload.encryptedConfigs.$ttSyncBridge, 'encrypted-v1');
  assert.equal(serialized.includes('source-key'), false);
  assert.equal(serialized.includes('source.private'), false);

  const target = createApiManagerHost();
  assert.equal((await apiManagerAdapter.preview(target, captured.payload)).status, 'locked');
  assert.equal((await apiManagerAdapter.restore(target, captured.payload)).status, 'locked');
  assert.equal((await apiManagerAdapter.restore(target, captured.payload, { sensitiveCodec: codec })).status, 'applied');

  const state = target.inspect();
  const restored = JSON.parse(state.localStorage.api_configs_manager);
  assert.equal(restored[0].apiKeys[0].key, 'source-key');
  assert.equal(restored[0].customUrl, 'https://source.private/v1');
  assert.deepEqual(JSON.parse(state.localStorage.api_configs_categories), categories());
});

test('API manager non-sensitive restore preserves the target config as a whole', async () => {
  const source = createApiManagerHost(fullStorage());
  const captured = await apiManagerAdapter.capture(source);
  const targetConfig = configs({ customModel: 'target-model', customUrl: 'https://target.private/v1' });
  targetConfig[0].apiKeys[0].key = 'target-key';
  const target = createApiManagerHost({
    ...fullStorage(),
    api_configs_manager: JSON.stringify(targetConfig),
    api_configs_collapsed_categories: JSON.stringify(['target-ui']),
  });

  const first = await apiManagerAdapter.restore(target, captured.payload);
  const second = await apiManagerAdapter.restore(target, captured.payload);
  const state = target.inspect();

  assert.equal(first.status, 'noop');
  assert.equal(second.status, 'noop');
  assert.deepEqual(JSON.parse(state.localStorage.api_configs_manager), targetConfig);
  assert.deepEqual(JSON.parse(state.localStorage.api_configs_categories), categories());
  assert.deepEqual(JSON.parse(state.localStorage.api_configs_collapsed_categories), ['target-ui']);
  assert.deepEqual(JSON.parse(state.localStorage.stb_api_management_settings), { enabled: true, lockTavernConfig: true });
});

test('API manager capture accepts an export-style configs wrapper and embedded categories', async () => {
  const codec = createPassphraseSensitiveCodec('wrapper storage passphrase');
  const host = createMemoryHost({
    localStorage: {
      api_configs_manager: JSON.stringify({
        version: '1.0',
        configs: configs(),
        categories: categories(),
      }),
      api_configs_category_switch_indexes: JSON.stringify({ 'cat-1': 1 }),
      stb_api_management_settings: JSON.stringify({ enabled: true, lockTavernConfig: true }),
    },
  });
  host.hasTavernScript = id => id === API_MANAGER_SCRIPT_ID;

  const captured = await apiManagerAdapter.capture(host, { includeSensitive: true, sensitiveCodec: codec });
  const decrypted = await codec.decrypt(captured.payload.encryptedConfigs, 'api-manager-2/configs/v1');
  const diagnostics = apiManagerAdapter.diagnose(host);

  assert.deepEqual(decrypted.configs, configs());
  assert.deepEqual(captured.payload.entries.api_configs_categories, categories());
  assert.equal(captured.diagnostics.configStorageShape, 'wrapper-configs');
  assert.equal(diagnostics.sourceVersion, '2.0.3-compatible-storage');
  assert.equal(diagnostics.configStorageShape, 'wrapper-configs');
  assert.equal(diagnostics.configStorageReadable, true);
  assert.equal(diagnostics.configCount, 1);
  assert.equal(diagnostics.embeddedCategories, true);
  assert.deepEqual(diagnostics.configStorageCandidatePath, ['configs']);
});

test('API manager capture accepts a double-encoded config array', async () => {
  const codec = createPassphraseSensitiveCodec('nested json storage passphrase');
  const host = createApiManagerHost({
    api_configs_manager: JSON.stringify(JSON.stringify(configs())),
  });

  const captured = await apiManagerAdapter.capture(host, { includeSensitive: true, sensitiveCodec: codec });
  const decrypted = await codec.decrypt(captured.payload.encryptedConfigs, 'api-manager-2/configs/v1');
  assert.deepEqual(decrypted.configs, configs());
});

test('API manager restore canonicalizes a recoverable single-config object into the official array format', async () => {
  const codec = createPassphraseSensitiveCodec('single config passphrase');
  const source = createApiManagerHost({ api_configs_manager: JSON.stringify(configs()[0]) });
  const captured = await apiManagerAdapter.capture(source, { includeSensitive: true, sensitiveCodec: codec });
  const target = createApiManagerHost();

  assert.equal((await apiManagerAdapter.restore(target, captured.payload, { sensitiveCodec: codec })).status, 'applied');
  assert.deepEqual(JSON.parse(target.inspect().localStorage.api_configs_manager), configs());
});

test('API manager migration discards legacy partially-redacted configs instead of restoring malformed data', async () => {
  const migrated = apiManagerAdapter.migratePayload({
    dataVersion: 1,
    entries: { api_configs_manager: [{ name: 'legacy' }] },
  }, 1);
  assert.equal(isRedacted(migrated.entries.api_configs_manager), true);
});

test('API manager capture rejects malformed managed JSON without changing storage', async () => {
  const host = createApiManagerHost({ api_configs_manager: '{not-json' });
  const before = host.inspect().localStorage.api_configs_manager;
  await assert.rejects(() => apiManagerAdapter.capture(host), /valid JSON/i);
  assert.equal(host.inspect().localStorage.api_configs_manager, before);
});

test('API manager rejects an unsupported object shape without mutating it', async () => {
  const value = JSON.stringify({ version: 1, random: { nested: true } });
  const host = createApiManagerHost({ api_configs_manager: value });
  await assert.rejects(() => apiManagerAdapter.capture(host), /unsupported storage shape/i);
  assert.equal(host.inspect().localStorage.api_configs_manager, value);
});

test('API manager recognizes a re-imported Tavern Helper script by name rather than UUID', async () => {
  const host = createApiManagerHost({ api_configs_manager: JSON.stringify(configs()) });
  host.hasTavernScript = () => false;
  host.tavernHelperScripts = {
    get: () => ({
      available: true,
      trees: [{ type: 'script', id: 'new-id', name: '💡API管理器2.0.3' }],
    }),
  };
  const result = await apiManagerAdapter.capture(host);
  assert.equal(result.available, true);
});

test('API manager capture accepts a unique config array inside an unknown nested wrapper', async () => {
  const codec = createPassphraseSensitiveCodec('nested wrapper passphrase');
  const host = createApiManagerHost({
    api_configs_manager: JSON.stringify({ data: { payload: { items: configs() } }, other: { count: 1 } }),
  });
  const captured = await apiManagerAdapter.capture(host, { includeSensitive: true, sensitiveCodec: codec });
  const decrypted = await codec.decrypt(captured.payload.encryptedConfigs, 'api-manager-2/configs/v1');
  assert.deepEqual(decrypted.configs, configs());
});

test('API manager capture accepts an object map whose values are API configs', async () => {
  const codec = createPassphraseSensitiveCodec('map storage passphrase');
  const map = { one: configs()[0] };
  const host = createApiManagerHost({ api_configs_manager: JSON.stringify(map) });
  const captured = await apiManagerAdapter.capture(host, { includeSensitive: true, sensitiveCodec: codec });
  const decrypted = await codec.decrypt(captured.payload.encryptedConfigs, 'api-manager-2/configs/v1');
  assert.deepEqual(decrypted.configs, configs());
});

test('API manager leaves ambiguous wrapper objects fail-closed', async () => {
  const host = createApiManagerHost({
    api_configs_manager: JSON.stringify({ a: configs(), b: configs({ name: 'second' }) }),
  });
  await assert.rejects(() => apiManagerAdapter.capture(host), /unsupported storage shape/i);
});
