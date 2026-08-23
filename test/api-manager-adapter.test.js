import test from 'node:test';
import assert from 'node:assert/strict';

import {
  API_MANAGER_KEYS,
  API_MANAGER_SCRIPT_ID,
  apiManagerAdapter,
} from '../src/adapters/api-manager-adapter.js';
import { isRedacted } from '../src/core/redaction.js';
import { createPassphraseSensitiveCodec } from '../src/core/sensitive-envelope.js';
import { createMemoryHost } from './helpers/memory-host.js';

function configs(overrides = {}) {
  return [{
    name: '[Primary] model-a',
    source: 'custom',
    customUrl: 'https://source.private/v1',
    apiKeys: [{ id: 'key-1', key: 'source-secret' }],
    currentKeyIndex: 0,
    enableKeyRotation: false,
    customModel: 'model-a',
    groupName: 'Primary',
    groupKey: 'primary-group',
    categoryIds: ['cat-1'],
    isActive: true,
    ...overrides,
  }];
}

function createApiManagerHost(overrides = {}) {
  const host = createMemoryHost({
    localStorage: {
      api_configs_manager: JSON.stringify(configs()),
      api_configs_categories: JSON.stringify([{ id: 'cat-1', name: '常用', color: '#ffffff', order: 0 }]),
      api_configs_collapsed_categories: JSON.stringify(['cat-1']),
      api_configs_category_switch_indexes: JSON.stringify({ 'cat-1': 2 }),
      stb_api_management_settings: JSON.stringify({ enabled: true, lockTavernConfig: true }),
      ...overrides,
    },
  });
  host.hasTavernScript = id => id === API_MANAGER_SCRIPT_ID;
  return host;
}

test('API manager public capture never serializes configs or device-only UI state', async () => {
  const host = createApiManagerHost();

  const result = await apiManagerAdapter.capture(host, { includeSensitive: false });

  assert.equal(result.available, true);
  assert.equal(result.payload.dataVersion, 2);
  assert.deepEqual(Object.keys(result.payload.entries).sort(), [...API_MANAGER_KEYS].sort());
  assert.equal(isRedacted(result.payload.entries.api_configs_manager), true);
  assert.equal(isRedacted(result.payload.entries.api_configs_collapsed_categories), true);
  assert.deepEqual(result.payload.entries.stb_api_management_settings, { enabled: true, lockTavernConfig: true });
  const serialized = JSON.stringify(result.payload);
  assert.equal(serialized.includes('source-secret'), false);
  assert.equal(serialized.includes('source.private'), false);
});

test('API manager encrypted capture restores a complete usable config on a clean device', async () => {
  const codec = createPassphraseSensitiveCodec('portable api manager passphrase');
  const source = createApiManagerHost();
  const captured = await apiManagerAdapter.capture(source, { includeSensitive: true, sensitiveCodec: codec });
  const serialized = JSON.stringify(captured.payload);

  assert.equal(captured.payload.encryptedConfigs.$ttSyncBridge, 'encrypted-v1');
  assert.equal(isRedacted(captured.payload.entries.api_configs_manager), true);
  assert.equal(serialized.includes('source-secret'), false);
  assert.equal(serialized.includes('source.private'), false);

  const target = createMemoryHost();
  target.hasTavernScript = id => id === API_MANAGER_SCRIPT_ID;
  assert.equal((await apiManagerAdapter.preview(target, captured.payload)).status, 'locked');
  assert.equal((await apiManagerAdapter.restore(target, captured.payload)).status, 'locked');
  assert.equal(Object.hasOwn(target.inspect().localStorage, 'api_configs_manager'), false);

  assert.equal((await apiManagerAdapter.preview(target, captured.payload, { sensitiveCodec: codec })).status, 'empty-target');
  assert.equal((await apiManagerAdapter.restore(target, captured.payload, { sensitiveCodec: codec })).status, 'applied');
  assert.deepEqual(JSON.parse(target.inspect().localStorage.api_configs_manager), configs());
  assert.deepEqual(JSON.parse(target.inspect().localStorage.stb_api_management_settings), {
    enabled: true,
    lockTavernConfig: true,
  });
});

test('API manager non-sensitive restore preserves the target config as a whole', async () => {
  const captured = await apiManagerAdapter.capture(createApiManagerHost(), { includeSensitive: false });
  const targetConfig = configs({
    name: '[Target] model-b',
    customUrl: 'https://target.private/v1',
    apiKeys: [{ id: 'target-key', key: 'target-secret' }],
    customModel: 'model-b',
  });
  const target = createApiManagerHost({
    api_configs_manager: JSON.stringify(targetConfig),
    api_configs_categories: JSON.stringify([]),
    api_configs_collapsed_categories: JSON.stringify(['target-ui']),
    api_configs_category_switch_indexes: JSON.stringify({}),
    stb_api_management_settings: JSON.stringify({ enabled: false, lockTavernConfig: false }),
  });

  const first = await apiManagerAdapter.restore(target, captured.payload);
  const second = await apiManagerAdapter.restore(target, captured.payload);
  const state = target.inspect();

  assert.equal(first.status, 'applied');
  assert.equal(second.status, 'noop');
  assert.deepEqual(JSON.parse(state.localStorage.api_configs_manager), targetConfig);
  assert.deepEqual(JSON.parse(state.localStorage.api_configs_categories), [{ id: 'cat-1', name: '常用', color: '#ffffff', order: 0 }]);
  assert.deepEqual(JSON.parse(state.localStorage.api_configs_collapsed_categories), ['target-ui']);
  assert.deepEqual(JSON.parse(state.localStorage.stb_api_management_settings), { enabled: true, lockTavernConfig: true });
});

test('API manager migration discards legacy partially-redacted configs instead of restoring malformed data', () => {
  const migrated = apiManagerAdapter.migratePayload({
    dataVersion: 1,
    entries: {
      api_configs_manager: [{ name: 'legacy', customUrl: { $ttSyncBridge: 'redacted-v1' } }],
      api_configs_categories: [{ id: 'cat-1', name: '常用' }],
      api_configs_collapsed_categories: ['cat-1'],
      api_configs_category_switch_indexes: { 'cat-1': 1 },
      st_api_manager_sync_metadata_v1: { revision: 9 },
      st_api_manager_debug_modal: { open: true },
    },
  }, 1);

  assert.equal(migrated.dataVersion, 2);
  assert.equal(isRedacted(migrated.entries.api_configs_manager), true);
  assert.equal(isRedacted(migrated.entries.api_configs_collapsed_categories), true);
  assert.equal(isRedacted(migrated.entries.stb_api_management_settings), true);
  assert.deepEqual(migrated.entries.api_configs_categories, [{ id: 'cat-1', name: '常用' }]);
});

test('API manager capture rejects malformed managed JSON without changing storage', async () => {
  const host = createApiManagerHost({ api_configs_manager: '{broken' });

  await assert.rejects(() => apiManagerAdapter.capture(host), /api_configs_manager.*valid JSON/i);
  assert.equal(host.inspect().localStorage.api_configs_manager, '{broken');
});

test('API manager recognizes a re-imported Tavern Helper script by name rather than UUID', async () => {
  const source = createApiManagerHost();
  const captured = await apiManagerAdapter.capture(source);
  const target = createMemoryHost();
  target.tavernHelperScripts = {
    get: () => ({
      available: true,
      trees: [{ type: 'script', id: 'fresh-random-uuid', name: '💡API管理器2.0.3' }],
    }),
  };

  assert.equal((await apiManagerAdapter.preview(target, captured.payload)).status, 'empty-target');
});
