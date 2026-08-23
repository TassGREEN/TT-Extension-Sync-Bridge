import test from 'node:test';
import assert from 'node:assert/strict';

import { ST_CHATU8_SETTINGS_KEY, stChatu8Adapter } from '../src/adapters/st-chatu8-adapter.js';
import { createPassphraseSensitiveCodec } from '../src/core/sensitive-envelope.js';
import { createMemoryHost } from './helpers/memory-host.js';

function sourceSettings(overrides = {}) {
  return {
    mode: 'novelai',
    theme_id: 'theme-user',
    llm_profiles: {
      profile1: {
        id: 'profile1',
        name: 'My LLM',
        model: 'model-a',
        api_key: 'source-secret',
        baseUrl: 'https://source.private/v1',
      },
    },
    ai_token: 'source-token',
    novelaiApi: 'source-novelai-credential',
    novelaisite: 'https://source.novelai.private',
    st_chatu8_sd_auth: 'source-auth',
    comfyuiUrl: 'https://source.comfy.private',
    workerid: 'source-worker',
    workers: { one: { status: 'busy' } },
    imageGenStats: { count: 99 },
    chatu8_fab_position: { x: 10, y: 20 },
    ...overrides,
  };
}

function hostFor(value = sourceSettings()) {
  return createMemoryHost({
    extensionSettings: { [ST_CHATU8_SETTINGS_KEY]: value },
    pluginVersions: { 'third-party/st-chatu8': '2.8.4' },
    indexedDb: { chatu8_gallery: { tags: [] } },
  });
}

test('st-chatu8 encrypted snapshot restores API settings on a clean device without device state', async () => {
  const codec = createPassphraseSensitiveCodec('portable st chatu8 passphrase');
  const captured = await stChatu8Adapter.capture(hostFor(), { includeSensitive: true, sensitiveCodec: codec });
  const serialized = JSON.stringify(captured.payload);

  assert.equal(captured.payload.dataVersion, 2);
  assert.equal(captured.payload.encryptedSettings.$ttSyncBridge, 'encrypted-v1');
  assert.equal(serialized.includes('source-secret'), false);
  assert.equal(serialized.includes('source-token'), false);
  assert.equal(serialized.includes('source.private'), false);
  assert.equal(serialized.includes('source-worker'), false);

  const target = createMemoryHost({
    pluginVersions: { 'third-party/st-chatu8': '2.8.4' },
    indexedDb: { chatu8_gallery: { tags: [] } },
  });
  assert.equal((await stChatu8Adapter.preview(target, captured.payload)).status, 'locked');
  assert.equal((await stChatu8Adapter.restore(target, captured.payload)).status, 'locked');
  assert.equal((await stChatu8Adapter.restore(target, captured.payload, { sensitiveCodec: codec })).status, 'applied');

  const restored = target.inspect().extensionSettings[ST_CHATU8_SETTINGS_KEY];
  assert.equal(restored.llm_profiles.profile1.api_key, 'source-secret');
  assert.equal(restored.llm_profiles.profile1.baseUrl, 'https://source.private/v1');
  assert.equal(restored.ai_token, 'source-token');
  assert.equal(restored.novelaiApi, 'source-novelai-credential');
  assert.equal(restored.novelaisite, 'https://source.novelai.private');
  assert.equal(restored.comfyuiUrl, 'https://source.comfy.private');
  assert.equal(Object.hasOwn(restored, 'workerid'), false);
  assert.equal(Object.hasOwn(restored, 'workers'), false);
  assert.equal(Object.hasOwn(restored, 'imageGenStats'), false);
  assert.equal(Object.hasOwn(restored, 'chatu8_fab_position'), false);
});

test('st-chatu8 encrypted restore preserves target device-only fields', async () => {
  const codec = createPassphraseSensitiveCodec('portable st chatu8 passphrase');
  const captured = await stChatu8Adapter.capture(hostFor(), { includeSensitive: true, sensitiveCodec: codec });
  const target = hostFor(sourceSettings({
    ai_token: 'target-token',
    workerid: 'target-worker',
    workers: { local: { status: 'idle' } },
    imageGenStats: { count: 3 },
    chatu8_fab_position: { x: 90, y: 80 },
  }));

  assert.equal((await stChatu8Adapter.restore(target, captured.payload, { sensitiveCodec: codec })).status, 'applied');
  const restored = target.inspect().extensionSettings[ST_CHATU8_SETTINGS_KEY];

  assert.equal(restored.ai_token, 'source-token');
  assert.equal(restored.workerid, 'target-worker');
  assert.deepEqual(restored.workers, { local: { status: 'idle' } });
  assert.deepEqual(restored.imageGenStats, { count: 3 });
  assert.deepEqual(restored.chatu8_fab_position, { x: 90, y: 80 });
});

test('st-chatu8 sensitive capture fails closed without an encryption codec', async () => {
  await assert.rejects(
    () => stChatu8Adapter.capture(hostFor(), { includeSensitive: true }),
    /encryption passphrase is required/i,
  );
});
