import test from 'node:test';
import assert from 'node:assert/strict';

import {
  databaseAdapter,
  DATABASE_SETTINGS_KEY,
  DATABASE_SETTINGS_ROOT,
} from '../src/adapters/database-adapter.js';
import { isRedacted } from '../src/core/redaction.js';
import { createMemoryHost } from './helpers/memory-host.js';

const sourceSettings = {
  shujuku_v104_globalMeta_v1: '{"revision":4}',
  shujuku_v104_profile_v1____default____settings: '{"enabled":true}',
  shujuku_v104_profile_v1____default____template: '{"template":"user"}',
  shujuku_v104_templatePresets_v1: '[{"name":"mine"}]',
  shujuku_v104_windowStates: '{"left":123,"top":456}',
};

function nestedDatabaseSettings(settings, siblings = {}) {
  return { [DATABASE_SETTINGS_ROOT]: { ...siblings, [DATABASE_SETTINGS_KEY]: settings } };
}

test('database adapter captures user configuration but not window state', async () => {
  const host = createMemoryHost({ extensionSettings: nestedDatabaseSettings(sourceSettings) });

  const result = await databaseAdapter.capture(host, { includeSensitive: false });

  assert.equal(result.available, true);
  assert.equal(result.sourceVersion, 'shujuku_v104');
  assert.equal(result.payload.settings.shujuku_v104_profile_v1____default____template, '{"template":"user"}');
  assert.equal(isRedacted(result.payload.settings.shujuku_v104_windowStates), true);
  assert.deepEqual(result.diagnostics.excludedPaths, ['$.settings.shujuku_v104_windowStates']);
});

test('database adapter restore preserves local window state and is idempotent', async () => {
  const sourceHost = createMemoryHost({ extensionSettings: nestedDatabaseSettings(sourceSettings) });
  const captured = await databaseAdapter.capture(sourceHost, { includeSensitive: false });
  const targetHost = createMemoryHost({
    extensionSettings: nestedDatabaseSettings({
        ...sourceSettings,
        shujuku_v104_profile_v1____default____settings: '{"enabled":false}',
        shujuku_v104_windowStates: '{"left":999}',
      }, { unrelated_userscript_settings: { keep: true } }),
  });

  const first = await databaseAdapter.restore(targetHost, captured.payload);
  const second = await databaseAdapter.restore(targetHost, captured.payload);
  const state = targetHost.inspect();

  assert.equal(first.status, 'applied');
  assert.equal(second.status, 'noop');
  assert.equal(state.saveCount, 1);
  assert.equal(
    state.extensionSettings[DATABASE_SETTINGS_ROOT][DATABASE_SETTINGS_KEY].shujuku_v104_windowStates,
    '{"left":999}',
  );
  assert.equal(
    state.extensionSettings[DATABASE_SETTINGS_ROOT][DATABASE_SETTINGS_KEY].shujuku_v104_profile_v1____default____settings,
    '{"enabled":true}',
  );
  assert.deepEqual(
    state.extensionSettings[DATABASE_SETTINGS_ROOT].unrelated_userscript_settings,
    { keep: true },
  );
});

test('database adapter keeps a snapshot when target plugin is absent', async () => {
  const host = createMemoryHost();
  const result = await databaseAdapter.restore(host, { sourceVersion: 'shujuku_v104', settings: sourceSettings });

  assert.equal(result.status, 'missing-target');
  assert.equal(host.inspect().saveCount, 0);
});
