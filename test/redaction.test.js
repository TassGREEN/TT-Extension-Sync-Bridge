import test from 'node:test';
import assert from 'node:assert/strict';

import { isRedacted, mergeRedacted, redactClone } from '../src/core/redaction.js';

test('redaction removes sensitive values without losing safe configuration', () => {
  const source = {
    providers: [
      { id: 'p1', name: 'Primary', model: 'model-a', apiKey: 'secret-a', baseUrl: 'https://private.example' },
    ],
    ui: { theme: 'dark' },
  };

  const result = redactClone(source, {
    sensitiveKeyPatterns: [/api.?key/i, /url/i],
  });

  assert.equal(result.value.providers[0].model, 'model-a');
  assert.equal(isRedacted(result.value.providers[0].apiKey), true);
  assert.equal(isRedacted(result.value.providers[0].baseUrl), true);
  assert.deepEqual(result.redactions.map(item => item.path), [
    '$.providers[0].apiKey',
    '$.providers[0].baseUrl',
  ]);
  assert.equal(JSON.stringify(result.value).includes('secret-a'), false);
  assert.equal(JSON.stringify(result.value).includes('private.example'), false);
});

test('restore keeps device-local secrets by stable array identity', () => {
  const local = {
    providers: [
      { id: 'p2', name: 'Secondary', model: 'old-b', apiKey: 'local-b' },
      { id: 'p1', name: 'Primary', model: 'old-a', apiKey: 'local-a' },
    ],
  };
  const incoming = {
    providers: [
      { id: 'p1', name: 'Primary', model: 'new-a', apiKey: { $ttSyncBridge: 'redacted-v1' } },
      { id: 'p2', name: 'Secondary', model: 'new-b', apiKey: { $ttSyncBridge: 'redacted-v1' } },
      { id: 'p3', name: 'New', model: 'new-c', apiKey: { $ttSyncBridge: 'redacted-v1' } },
    ],
  };

  const restored = mergeRedacted(local, incoming);

  assert.deepEqual(restored.providers, [
    { id: 'p1', name: 'Primary', model: 'new-a', apiKey: 'local-a' },
    { id: 'p2', name: 'Secondary', model: 'new-b', apiKey: 'local-b' },
    { id: 'p3', name: 'New', model: 'new-c' },
  ]);
});

test('unsupported sensitive inclusion fails closed', () => {
  assert.throws(
    () => redactClone({ apiKey: 'secret' }, { sensitiveKeyPatterns: [/api.?key/i], includeSensitive: true }),
    /encrypted sensitive sync is not implemented/i,
  );
});

test('restore preserves a target-only credential field that is absent on the source device', () => {
  const local = {
    providers: [{ id: 'provider-1', model: 'local-model', apiKey: 'target-device-secret' }],
  };
  const incoming = {
    providers: [{ id: 'provider-1', model: 'synced-model' }],
  };

  const restored = mergeRedacted(local, incoming, {
    preserveLocalKeyPatterns: [/^api[_-]?key$/i, /token/i],
  });

  assert.deepEqual(restored, {
    providers: [{ id: 'provider-1', model: 'synced-model', apiKey: 'target-device-secret' }],
  });
});
