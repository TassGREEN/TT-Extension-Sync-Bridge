import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DREAM_CACHE_KEY,
  DREAM_SCRIPT_ID,
  DREAM_SETTINGS_CHANNEL,
  DREAM_SETTINGS_KEY,
  dreamCardAgentAdapter,
} from '../src/adapters/dream-card-agent-adapter.js';
import { isRedacted } from '../src/core/redaction.js';
import { createPassphraseSensitiveCodec } from '../src/core/sensitive-envelope.js';
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

test('dream creator restore preserves local device state, increments revision, and aligns both stores', async () => {
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
  const state = target.inspect();
  const restored = state.extensionSettings[DREAM_SETTINGS_KEY];
  const cached = JSON.parse(state.localStorage[DREAM_CACHE_KEY]);

  assert.equal(first.status, 'applied');
  assert.equal(second.status, 'noop');
  assert.equal(restored.providers[0].model, 'model-a');
  assert.equal(restored.providers[0].apiKey, 'target-secret');
  assert.equal(restored.providers[0].baseUrl, 'https://target.private/v1');
  assert.deepEqual(restored.floatingButtonOffset, { x: 9, y: 8 });
  assert.equal(restored.syncRevision, 8);
  assert.deepEqual(cached, restored);
  assert.equal(state.saveCount, 1);
  assert.deepEqual(state.broadcasts, [{
    channel: DREAM_SETTINGS_CHANNEL,
    message: { revision: 8, type: 'settings-updated' },
  }]);
});

test('dream creator overwrites a higher-revision blank cache with restored source data', async () => {
  const codec = createPassphraseSensitiveCodec('dream dual store passphrase');
  const sourceSettings = dreamSettings();
  const source = createMemoryHost({ extensionSettings: { [DREAM_SETTINGS_KEY]: sourceSettings } });
  const captured = await dreamCardAgentAdapter.capture(source, { includeSensitive: true, sensitiveCodec: codec });
  const staleTavern = dreamSettings({ approvalMode: 'old', syncRevision: 2 });
  const blankCache = dreamSettings({
    approvalMode: 'fresh-default',
    providers: [],
    agentConfigurations: [],
    globalSkills: {},
    files: {},
    workspaceFiles: {},
    syncRevision: 9,
  });
  const target = createMemoryHost({
    extensionSettings: { [DREAM_SETTINGS_KEY]: staleTavern },
    localStorage: { [DREAM_CACHE_KEY]: JSON.stringify(blankCache) },
  });

  assert.equal((await dreamCardAgentAdapter.preview(target, captured.payload, { sensitiveCodec: codec })).status, 'would-change');
  assert.equal((await dreamCardAgentAdapter.restore(target, captured.payload, { sensitiveCodec: codec })).status, 'applied');
  const state = target.inspect();
  const restored = state.extensionSettings[DREAM_SETTINGS_KEY];
  const cached = JSON.parse(state.localStorage[DREAM_CACHE_KEY]);

  assert.equal(restored.syncRevision, 10);
  assert.equal(restored.approvalMode, sourceSettings.approvalMode);
  assert.deepEqual(restored.globalSkills, sourceSettings.globalSkills);
  assert.deepEqual(restored.providers, sourceSettings.providers);
  assert.deepEqual(cached, restored);
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
  const state = target.inspect();
  assert.equal(state.extensionSettings[DREAM_SETTINGS_KEY].version, 4);
  assert.equal(state.extensionSettings[DREAM_SETTINGS_KEY].syncRevision, 1);
  assert.equal(Object.hasOwn(state.extensionSettings[DREAM_SETTINGS_KEY].providers[0], 'apiKey'), false);
  assert.deepEqual(JSON.parse(state.localStorage[DREAM_CACHE_KEY]), state.extensionSettings[DREAM_SETTINGS_KEY]);
});

test('dream creator does not restore a provider whose required secrets are unavailable on a clean device', async () => {
  const source = createMemoryHost({
    extensionSettings: {
      [DREAM_SETTINGS_KEY]: dreamSettings({
        providers: [{
          id: 'provider-1',
          name: 'Private provider',
          baseURL: 'https://source.private/v1',
          enabled: true,
          interfaceType: 'openai-chat',
          models: [],
          secrets: {
            algorithm: 'AES-GCM',
            ciphertext: 'synthetic-ciphertext',
            iterations: 150000,
            iv: 'synthetic-iv',
            salt: 'synthetic-salt',
            version: 1,
          },
        }],
      }),
    },
  });
  const captured = await dreamCardAgentAdapter.capture(source);
  const target = createMemoryHost();
  target.hasTavernScript = id => id === DREAM_SCRIPT_ID;

  assert.equal((await dreamCardAgentAdapter.restore(target, captured.payload)).status, 'applied');
  assert.deepEqual(target.inspect().extensionSettings[DREAM_SETTINGS_KEY].providers, []);
});

test('dream creator keeps TT file references while still redacting provider URLs', async () => {
  const source = createMemoryHost({
    extensionSettings: {
      [DREAM_SETTINGS_KEY]: dreamSettings({
        characterStores: {
          'binding-1': {
            bindingId: 'binding-1',
            revision: 1,
            sha256: 'meta-hash',
            size: 735,
            updatedAt: 1,
            url: '/user/files/DreamCreator--Meta--binding-1.json',
          },
        },
        files: {
          'workspace-1': {
            bindingId: 'binding-1',
            createdAt: 1,
            name: 'workspace.bin',
            size: 42,
            url: '/user/files/DreamCreator--Blob--binding-1--workspace-1.bin',
          },
        },
      }),
    },
  });

  const result = await dreamCardAgentAdapter.capture(source);

  assert.equal(
    result.payload.settings.characterStores['binding-1'].url,
    '/user/files/DreamCreator--Meta--binding-1.json',
  );
  assert.equal(
    result.payload.settings.files['workspace-1'].url,
    '/user/files/DreamCreator--Blob--binding-1--workspace-1.bin',
  );
  assert.equal(isRedacted(result.payload.settings.providers[0].baseUrl), true);
});

test('dream creator encrypts provider credentials and restores them only with the passphrase', async () => {
  const passphrase = 'portable bridge passphrase';
  const sourceSettings = dreamSettings({
    providers: [{
      id: 'provider-1',
      name: 'Private provider',
      baseURL: 'https://source.private/v1',
      enabled: true,
      interfaceType: 'openai-chat',
      models: [{ id: 'model-1', name: 'Model', requestSecrets: { header: 'model-secret' } }],
      secrets: {
        algorithm: 'AES-GCM',
        ciphertext: 'dream-owned-secret-payload',
        iterations: 150000,
        iv: 'dream-owned-iv',
        salt: 'dream-owned-salt',
        version: 1,
      },
    }],
  });
  const codec = createPassphraseSensitiveCodec(passphrase);
  const source = createMemoryHost({ extensionSettings: { [DREAM_SETTINGS_KEY]: sourceSettings } });

  const captured = await dreamCardAgentAdapter.capture(source, { includeSensitive: true, sensitiveCodec: codec });
  const serialized = JSON.stringify(captured.payload);

  assert.equal(captured.payload.dataVersion, 2);
  assert.equal(captured.payload.encryptedProviders.$ttSyncBridge, 'encrypted-v1');
  assert.equal(serialized.includes('https://source.private/v1'), false);
  assert.equal(serialized.includes('dream-owned-secret-payload'), false);
  assert.equal(serialized.includes('model-secret'), false);
  assert.equal(serialized.includes(passphrase), false);

  const target = createMemoryHost();
  target.hasTavernScript = id => id === DREAM_SCRIPT_ID;
  assert.equal((await dreamCardAgentAdapter.preview(target, captured.payload)).status, 'locked');
  assert.equal((await dreamCardAgentAdapter.restore(target, captured.payload)).status, 'locked');
  assert.equal(target.inspect().saveCount, 0);

  assert.equal((await dreamCardAgentAdapter.restore(target, captured.payload, { sensitiveCodec: codec })).status, 'applied');
  assert.deepEqual(target.inspect().extensionSettings[DREAM_SETTINGS_KEY].providers, sourceSettings.providers);
});

test('dream creator fails closed when sensitive capture has no encryption codec', async () => {
  const host = createMemoryHost({ extensionSettings: { [DREAM_SETTINGS_KEY]: dreamSettings() } });
  await assert.rejects(
    () => dreamCardAgentAdapter.capture(host, { includeSensitive: true }),
    /encryption passphrase is required/i,
  );
});

test('dream creator repairs only a legacy missing metadata URL without reading session files', async () => {
  const bindingId = 'character:one';
  const host = createMemoryHost({
    extensionSettings: {
      [DREAM_SETTINGS_KEY]: dreamSettings({
        characterStores: {
          [bindingId]: {
            bindingId,
            revision: 2,
            sha256: 'a'.repeat(64),
            size: 735,
            updatedAt: 123,
          },
        },
      }),
    },
  });

  const captured = await dreamCardAgentAdapter.capture(host);
  const expectedUrl = '/user/files/DreamCreator--Meta--character_one.json';
  const state = host.inspect();

  assert.equal(captured.payload.settings.characterStores[bindingId].url, expectedUrl);
  assert.equal(state.extensionSettings[DREAM_SETTINGS_KEY].characterStores[bindingId].url, expectedUrl);
  assert.equal(state.extensionSettings[DREAM_SETTINGS_KEY].syncRevision, 43);
  assert.deepEqual(JSON.parse(state.localStorage[DREAM_CACHE_KEY]), state.extensionSettings[DREAM_SETTINGS_KEY]);
  assert.equal(state.saveCount, 1);
  assert.equal(captured.diagnostics.repairedReferenceCount, 1);
});

test('dream creator does not invent a metadata URL for an incomplete unknown record', async () => {
  const host = createMemoryHost({
    extensionSettings: {
      [DREAM_SETTINGS_KEY]: dreamSettings({
        characterStores: { unknown: { bindingId: 'unknown' } },
      }),
    },
  });

  const captured = await dreamCardAgentAdapter.capture(host);

  assert.equal(Object.hasOwn(captured.payload.settings.characterStores.unknown, 'url'), false);
  assert.equal(host.inspect().saveCount, 0);
  assert.equal(captured.diagnostics.repairedReferenceCount, 0);
});
