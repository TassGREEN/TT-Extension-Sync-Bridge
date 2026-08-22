import test from 'node:test';
import assert from 'node:assert/strict';

import {
  API_MANAGER_KEYS,
  API_MANAGER_SCRIPT_ID,
  apiManagerAdapter,
} from '../src/adapters/api-manager-adapter.js';
import { isRedacted } from '../src/core/redaction.js';
import { createMemoryHost } from './helpers/memory-host.js';

function createApiManagerHost(overrides = {}) {
  const host = createMemoryHost({
    localStorage: {
      api_configs_manager: JSON.stringify([
        {
          id: 'primary',
          name: 'Primary',
          model: 'model-a',
          api_key: 'source-secret',
          base_url: 'https://source.private/v1',
          account: 'source-account',
        },
      ]),
      api_configs_categories: JSON.stringify([{ id: 'cat-1', name: '常用' }]),
      api_configs_collapsed_categories: JSON.stringify(['cat-1']),
      api_configs_category_switch_indexes: JSON.stringify({ 'cat-1': 2 }),
      st_api_manager_sync_metadata_v1: JSON.stringify({ revision: 99 }),
      st_api_manager_debug_modal: JSON.stringify({ open: true }),
      ...overrides,
    },
  });
  host.hasTavernScript = id => id === API_MANAGER_SCRIPT_ID;
  return host;
}

test('API manager capture handles all known keys and excludes secrets and UI state', async () => {
  const host = createApiManagerHost();

  const result = await apiManagerAdapter.capture(host, { includeSensitive: false });
  const config = result.payload.entries.api_configs_manager[0];

  assert.equal(result.available, true);
  assert.deepEqual(Object.keys(result.payload.entries).sort(), [...API_MANAGER_KEYS].sort());
  assert.equal(config.model, 'model-a');
  assert.equal(isRedacted(config.api_key), true);
  assert.equal(isRedacted(config.base_url), true);
  assert.equal(isRedacted(config.account), true);
  assert.equal(isRedacted(result.payload.entries.api_configs_collapsed_categories), true);
  assert.equal(isRedacted(result.payload.entries.st_api_manager_sync_metadata_v1), true);
  assert.equal(isRedacted(result.payload.entries.st_api_manager_debug_modal), true);
  const serialized = JSON.stringify(result.payload);
  assert.equal(serialized.includes('source-secret'), false);
  assert.equal(serialized.includes('source.private'), false);
  assert.equal(serialized.includes('source-account'), false);
});

test('API manager restore preserves local credentials and is idempotent', async () => {
  const captured = await apiManagerAdapter.capture(createApiManagerHost(), { includeSensitive: false });
  const target = createApiManagerHost({
    api_configs_manager: JSON.stringify([
      {
        id: 'primary',
        name: 'Primary',
        model: 'old-model',
        api_key: 'target-secret',
        base_url: 'https://target.private/v1',
        account: 'target-account',
      },
    ]),
    api_configs_categories: JSON.stringify([]),
    api_configs_collapsed_categories: JSON.stringify(['target-ui']),
    st_api_manager_sync_metadata_v1: JSON.stringify({ revision: 7 }),
    st_api_manager_debug_modal: JSON.stringify({ open: false }),
  });

  const first = await apiManagerAdapter.restore(target, captured.payload);
  const second = await apiManagerAdapter.restore(target, captured.payload);
  const state = target.inspect();
  const restoredConfig = JSON.parse(state.localStorage.api_configs_manager)[0];

  assert.equal(first.status, 'applied');
  assert.equal(second.status, 'noop');
  assert.equal(restoredConfig.model, 'model-a');
  assert.equal(restoredConfig.api_key, 'target-secret');
  assert.equal(restoredConfig.base_url, 'https://target.private/v1');
  assert.equal(restoredConfig.account, 'target-account');
  assert.deepEqual(JSON.parse(state.localStorage.api_configs_collapsed_categories), ['target-ui']);
  assert.deepEqual(JSON.parse(state.localStorage.st_api_manager_sync_metadata_v1), { revision: 7 });
  assert.deepEqual(JSON.parse(state.localStorage.st_api_manager_debug_modal), { open: false });
});

test('API manager capture rejects malformed managed JSON without changing storage', async () => {
  const host = createApiManagerHost({ api_configs_manager: '{broken' });

  await assert.rejects(() => apiManagerAdapter.capture(host), /api_configs_manager.*valid JSON/i);
  assert.equal(host.inspect().localStorage.api_configs_manager, '{broken');
});

test('API manager initializes a clean device when its Tavern Helper script exists', async () => {
  const captured = await apiManagerAdapter.capture(createApiManagerHost());
  const target = createMemoryHost();
  target.hasTavernScript = id => id === API_MANAGER_SCRIPT_ID;

  assert.equal((await apiManagerAdapter.preview(target, captured.payload)).status, 'empty-target');
  assert.equal((await apiManagerAdapter.restore(target, captured.payload)).status, 'applied');
  const config = JSON.parse(target.inspect().localStorage.api_configs_manager)[0];
  assert.equal(config.model, 'model-a');
  assert.equal(Object.hasOwn(config, 'api_key'), false);
});
