import test from 'node:test';
import assert from 'node:assert/strict';

import { ST_CHATU8_SETTINGS_KEY, stChatu8Adapter } from '../src/adapters/st-chatu8-adapter.js';
import { isRedacted } from '../src/core/redaction.js';
import { createMemoryHost } from './helpers/memory-host.js';

function settings(overrides = {}) {
  return {
    mode: 'novelai',
    theme_id: 'theme-user',
    themes: { 'theme-user': { color: '#123456' } },
    llm_profiles: {
      profile1: {
        id: 'profile1',
        name: 'My LLM',
        model: 'model-a',
        api_key: 'source-secret',
        baseUrl: 'https://source.private/v1',
      },
    },
    personaProfiles: {
      p1: { id: 'p1', name: 'Persona', prompt: 'user prompt' },
      currentUserPresetId: 'p1',
      userEnabled: true,
    },
    characterPresets: { c1: { id: 'c1', name: 'Character', prompt: 'user character' } },
    prompt_replace: { r1: { from: 'a', to: 'b' } },
    ai_token: 'source-token',
    novelaiApi: 'source-novelai-credential',
    novelaisite: 'https://source.novelai.private',
    st_chatu8_sd_auth: 'source-auth',
    comfyuiUrl: 'https://source.comfy.private',
    workerid: 'device-worker',
    workers: { one: { status: 'busy' } },
    logState: { sessions: ['runtime'] },
    imageGenStats: { count: 99 },
    chatu8_fab_position: { x: 10, y: 20 },
    ai_test_output: 'temporary output',
    cacheStorageMigrated: true,
    ...overrides,
  };
}

function hostFor(version, value = settings()) {
  return createMemoryHost({
    extensionSettings: { [ST_CHATU8_SETTINGS_KEY]: value },
    pluginVersions: { 'third-party/st-chatu8': version },
    indexedDb: { chatu8_gallery: { tags: [] } },
  });
}

test('st-chatu8 captures user configuration and documents excluded IndexedDB stores', async () => {
  const result = await stChatu8Adapter.capture(hostFor('2.8.1'));
  const captured = result.payload.settings;

  assert.equal(result.sourceVersion, '2.8.1');
  assert.equal(captured.mode, 'novelai');
  assert.equal(captured.personaProfiles.p1.prompt, 'user prompt');
  assert.equal(captured.personaProfiles.currentUserPresetId, 'p1');
  assert.equal(captured.personaProfiles.userEnabled, true);
  assert.equal(captured.characterPresets.c1.prompt, 'user character');
  assert.equal(isRedacted(captured.llm_profiles.profile1.api_key), true);
  assert.equal(isRedacted(captured.llm_profiles.profile1.baseUrl), true);
  assert.equal(isRedacted(captured.ai_token), true);
  assert.equal(isRedacted(captured.novelaiApi), true);
  assert.equal(isRedacted(captured.novelaisite), true);
  assert.equal(isRedacted(captured.comfyuiUrl), true);
  assert.equal(isRedacted(captured.workerid), true);
  assert.equal(isRedacted(captured.logState), true);
  assert.equal(isRedacted(captured.chatu8_fab_position), true);
  assert.deepEqual(result.payload.indexedDb[0].stores[0], {
    name: 'tags',
    included: 'manual-only',
    index: 'fileName',
    equals: 'manual',
    identity: 'name',
  });
  assert.equal(result.payload.indexedDb[0].stores.find(item => item.name === 'tupianhuancun').included, false);
  assert.equal(result.payload.indexedDb[1].included, false);
  assert.equal(JSON.stringify(result.payload).includes('source-secret'), false);
  assert.equal(JSON.stringify(result.payload).includes('source.private'), false);
});

test('st-chatu8 restore preserves target secrets and device state and is idempotent', async () => {
  const captured = await stChatu8Adapter.capture(hostFor('2.8.1'));
  const target = hostFor('2.8.7', settings({
    mode: 'old-mode',
    llm_profiles: {
      profile1: {
        id: 'profile1',
        name: 'My LLM',
        model: 'old-model',
        api_key: 'target-secret',
        baseUrl: 'https://target.private/v1',
      },
    },
    ai_token: 'target-token',
    comfyuiUrl: 'https://target.comfy.private',
    workerid: 'target-worker',
    logState: { sessions: ['target-runtime'] },
    chatu8_fab_position: { x: 90, y: 80 },
  }));

  const first = await stChatu8Adapter.restore(target, captured.payload);
  const second = await stChatu8Adapter.restore(target, captured.payload);
  const restored = target.inspect().extensionSettings[ST_CHATU8_SETTINGS_KEY];

  assert.equal(first.status, 'applied');
  assert.equal(second.status, 'noop');
  assert.equal(restored.mode, 'novelai');
  assert.equal(restored.llm_profiles.profile1.model, 'model-a');
  assert.equal(restored.llm_profiles.profile1.api_key, 'target-secret');
  assert.equal(restored.llm_profiles.profile1.baseUrl, 'https://target.private/v1');
  assert.equal(restored.workerid, 'target-worker');
  assert.deepEqual(restored.logState, { sessions: ['target-runtime'] });
  assert.deepEqual(restored.chatu8_fab_position, { x: 90, y: 80 });
  assert.equal(target.inspect().saveCount, 1);
});

test('st-chatu8 refuses versions outside the audited 2.8 line', async () => {
  await assert.rejects(() => stChatu8Adapter.capture(hostFor('2.9.0')), /unsupported st-chatu8 version 2\.9\.0/i);

  const captured = await stChatu8Adapter.capture(hostFor('2.8.1'));
  const target = hostFor('2.7.9');
  const result = await stChatu8Adapter.restore(target, captured.payload);

  assert.equal(result.status, 'incompatible');
  assert.equal(target.inspect().saveCount, 0);
});

test('st-chatu8 initializes settings on a clean device when version is supported', async () => {
  const captured = await stChatu8Adapter.capture(hostFor('2.8.1'));
  const target = createMemoryHost({
    pluginVersions: { 'third-party/st-chatu8': '2.8.1' },
    indexedDb: { chatu8_gallery: { tags: [] } },
  });

  assert.equal((await stChatu8Adapter.preview(target, captured.payload)).status, 'empty-target');
  assert.equal((await stChatu8Adapter.restore(target, captured.payload)).status, 'applied');
  assert.equal(target.inspect().extensionSettings[ST_CHATU8_SETTINGS_KEY].mode, 'novelai');
  assert.equal(Object.hasOwn(target.inspect().extensionSettings[ST_CHATU8_SETTINGS_KEY], 'ai_token'), false);
});

test('st-chatu8 captures only user-created manual tags from IndexedDB', async () => {
  const host = createMemoryHost({
    extensionSettings: { [ST_CHATU8_SETTINGS_KEY]: settings() },
    pluginVersions: { 'third-party/st-chatu8': '2.8.1' },
    indexedDb: {
      chatu8_gallery: {
        tags: [
          { name: 'manual-b', translation: 'B', hot: 2, fileName: 'manual' },
          { name: 'downloaded', translation: 'cache', hot: 0, fileName: 'tags.json' },
          { name: 'manual-a', translation: 'A', hot: 1, fileName: 'manual' },
        ],
      },
    },
  });

  const captured = await stChatu8Adapter.capture(host);

  assert.equal(captured.payload.manualTags.captured, true);
  assert.deepEqual(captured.payload.manualTags.records, [
    { name: 'manual-a', translation: 'A', hot: 1, fileName: 'manual' },
    { name: 'manual-b', translation: 'B', hot: 2, fileName: 'manual' },
  ]);
  assert.equal(JSON.stringify(captured.payload).includes('downloaded'), false);
});

test('st-chatu8 restores manual tags atomically without touching installed vocabularies', async () => {
  const source = createMemoryHost({
    extensionSettings: { [ST_CHATU8_SETTINGS_KEY]: settings() },
    pluginVersions: { 'third-party/st-chatu8': '2.8.1' },
    indexedDb: {
      chatu8_gallery: {
        tags: [{ name: 'source-manual', translation: 'source', hot: 3, fileName: 'manual' }],
      },
    },
  });
  const captured = await stChatu8Adapter.capture(source);
  const target = createMemoryHost({
    extensionSettings: { [ST_CHATU8_SETTINGS_KEY]: settings() },
    pluginVersions: { 'third-party/st-chatu8': '2.8.7' },
    indexedDb: {
      chatu8_gallery: {
        tags: [
          { name: 'target-manual', translation: 'target', hot: 1, fileName: 'manual' },
          { name: 'installed', translation: 'keep', hot: 0, fileName: 'tags.json' },
        ],
      },
    },
  });

  assert.equal((await stChatu8Adapter.restore(target, captured.payload)).status, 'applied');
  assert.equal((await stChatu8Adapter.restore(target, captured.payload)).status, 'noop');
  assert.deepEqual(target.inspect().indexedDb.chatu8_gallery.tags, [
    { name: 'installed', translation: 'keep', hot: 0, fileName: 'tags.json' },
    { name: 'source-manual', translation: 'source', hot: 3, fileName: 'manual' },
  ]);
  assert.equal(target.inspect().indexedDbWriteCount, 1);
});

test('st-chatu8 refuses an incompatible gallery database version instead of silently dropping manual tags', async () => {
  const host = hostFor('2.8.1');
  host.indexedDb.getAllByIndex = async () => ({ available: false, reason: 'database-version-5' });

  await assert.rejects(() => stChatu8Adapter.capture(host), /gallery database version 5/i);
});

test('st-chatu8 refuses a partial capture while the manual tags database is unavailable', async () => {
  const host = hostFor('2.8.1');
  host.indexedDb.getAllByIndex = async () => ({ available: false, reason: 'database-missing' });

  await assert.rejects(() => stChatu8Adapter.capture(host), /manual tags.*database-missing/i);
});
