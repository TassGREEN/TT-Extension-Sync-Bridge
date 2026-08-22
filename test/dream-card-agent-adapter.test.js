import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DREAM_SCRIPT_ID,
  DREAM_SETTINGS_KEY,
  dreamCardAgentAdapter,
} from '../src/adapters/dream-card-agent-adapter.js';
import { isRedacted } from '../src/core/redaction.js';
import { createMemoryHost } from './helpers/memory-host.js';

function dreamSettings(overrides = {}) {
  return {
    version: 4,
    activeAgentConfigurationId: 'agent-1',
    activePresetId: 'preset-1',
    activeThemeId: 'dark',
    agentConfigurations: [{ id: 'agent-1', name: 'Writer', providerId: 'provider-1' }],
    approvalMode: 'ask',
    builtinSkillPackages: { builtin: { enabled: true } },
    characterStores: { charA: { notes: 'user-created' } },
    files: { 'guide.md': '# guide' },
    globalSkills: { polish: { prompt: 'polish this' } },
    presetProfiles: [{ id: 'preset-1', name: 'Default' }],
    providers: [
      {
        id: 'provider-1',
        name: 'Private provider',
        model: 'model-a',
        apiKey: 'source-secret',
        baseUrl: 'https://source.private/v1',
      },
    ],
    workspaceFiles: { 'workflow.json': '{"steps":[]}' },
    floatingButtonOffset: { x: 100, y: 200 },
    syncRevision: 42,
    ...overrides,
  };
}

test('dream creator captures user assets while excluding credentials and device state', async () => {
  const host = createMemoryHost({ extensionSettings: { [DREAM_SETTINGS_KEY]: dreamSettings() } });

  const result = await dreamCardAgentAdapter.capture(host, { includeSensitive: false });
  const provider = result.payload.settings.providers[0];

  assert.equal(result.sourceVersion, '4');
  assert.equal(result.payload.pluginDataVersion, 4);
  assert.equal(provider.model, 'model-a');
  assert.equal(isRedacted(provider.apiKey), true);
  assert.equal(isRedacted(provider.baseUrl), true);
  assert.equal(isRedacted(result.payload.settings.floatingButtonOffset), true);
  assert.equal(isRedacted(result.payload.settings.syncRevision), true);
  assert.equal(result.payload.settings.files['guide.md'], '# guide');
  assert.equal(result.payload.settings.globalSkills.polish.prompt, 'polish this');
  assert.equal(JSON.stringify(result.payload).includes('source-secret'), false);
});

test('dream creator restore preserves local credentials and device state', async () => {
  const source = createMemoryHost({ extensionSettings: { [DREAM_SETTINGS_KEY]: dreamSettings() } });
  const captured = await dreamCardAgentAdapter.capture(source);
  const target = createMemoryHost({
    extensionSettings: {
      [DREAM_SETTINGS_KEY]: dreamSettings({
        providers: [{
          id: 'provider-1',
          name: 'Private provider',
          model: 'old-model',
          apiKey: 'target-secret',
          baseUrl: 'https://target.private/v1',
        }],
        floatingButtonOffset: { x: 9, y: 8 },
        syncRevision: 7,
      }),
    },
  });

  const first = await dreamCardAgentAdapter.restore(target, captured.payload);
  const second = await dreamCardAgentAdapter.restore(target, captured.payload);
  const restored = target.inspect().extensionSettings[DREAM_SETTINGS_KEY];

  assert.equal(first.status, 'applied');
  assert.equal(second.status, 'noop');
  assert.equal(restored.providers[0].model, 'model-a');
  assert.equal(restored.providers[0].apiKey, 'target-secret');
  assert.equal(restored.providers[0].baseUrl, 'https://target.private/v1');
  assert.deepEqual(restored.floatingButtonOffset, { x: 9, y: 8 });
  assert.equal(restored.syncRevision, 7);
  assert.equal(target.inspect().saveCount, 1);
});

test('dream creator refuses incompatible plugin data versions', async () => {
  const source = createMemoryHost({ extensionSettings: { [DREAM_SETTINGS_KEY]: dreamSettings() } });
  const captured = await dreamCardAgentAdapter.capture(source);
  const target = createMemoryHost({
    extensionSettings: { [DREAM_SETTINGS_KEY]: dreamSettings({ version: 5 }) },
  });

  const result = await dreamCardAgentAdapter.restore(target, captured.payload);

  assert.equal(result.status, 'incompatible');
  assert.match(result.message, /version 5/i);
  assert.equal(target.inspect().saveCount, 0);
});

test('dream creator initializes a clean device when its stable script ID exists', async () => {
  const source = createMemoryHost({ extensionSettings: { [DREAM_SETTINGS_KEY]: dreamSettings() } });
  const captured = await dreamCardAgentAdapter.capture(source);
  const target = createMemoryHost();
  target.hasTavernScript = id => id === DREAM_SCRIPT_ID;

  assert.equal((await dreamCardAgentAdapter.preview(target, captured.payload)).status, 'empty-target');
  assert.equal((await dreamCardAgentAdapter.restore(target, captured.payload)).status, 'applied');
  assert.equal(target.inspect().extensionSettings[DREAM_SETTINGS_KEY].version, 4);
  assert.equal(Object.hasOwn(target.inspect().extensionSettings[DREAM_SETTINGS_KEY].providers[0], 'apiKey'), false);
});
