import test from 'node:test';
import assert from 'node:assert/strict';

import { createSnapshot, verifySnapshot } from '../src/core/snapshot.js';
import { redactedValue } from '../src/core/redaction.js';

test('snapshot hash is stable for equivalent payload key order', async () => {
  const common = {
    adapterId: 'example',
    adapterVersion: 1,
    sourceRevision: 3,
    capturedAt: '2026-08-22T12:00:00.000Z',
    deviceId: 'device-a',
    sensitiveDataIncluded: false,
  };

  const first = await createSnapshot({ ...common, payload: { alpha: 1, nested: { z: true, a: false } } });
  const second = await createSnapshot({ ...common, payload: { nested: { a: false, z: true }, alpha: 1 } });

  assert.equal(first.contentHash, second.contentHash);
  assert.equal(await verifySnapshot(first, { adapterId: 'example', adapterVersion: 1 }), true);
});

test('snapshot verification rejects payload tampering', async () => {
  const snapshot = await createSnapshot({
    adapterId: 'example',
    adapterVersion: 1,
    sourceRevision: 1,
    capturedAt: '2026-08-22T12:00:00.000Z',
    deviceId: 'device-a',
    sensitiveDataIncluded: false,
    payload: { enabled: true },
  });

  snapshot.payload.enabled = false;

  await assert.rejects(
    () => verifySnapshot(snapshot, { adapterId: 'example', adapterVersion: 1 }),
    /content hash mismatch/i,
  );
});

test('snapshot verification rejects unknown schema and adapter versions', async () => {
  const snapshot = await createSnapshot({
    adapterId: 'example',
    adapterVersion: 1,
    sourceRevision: 1,
    capturedAt: '2026-08-22T12:00:00.000Z',
    deviceId: 'device-a',
    sensitiveDataIncluded: false,
    payload: {},
  });

  await assert.rejects(
    () => verifySnapshot({ ...snapshot, schemaVersion: 2 }, { adapterId: 'example', adapterVersion: 1 }),
    /schema version/i,
  );
  await assert.rejects(
    () => verifySnapshot({ ...snapshot, adapterVersion: 2 }, { adapterId: 'example', adapterVersion: 1 }),
    /adapter version/i,
  );
});

test('non-sensitive hash ignores credential placeholders while content hash still protects exact payload', async () => {
  const common = {
    adapterId: 'example',
    adapterVersion: 1,
    sourceRevision: 1,
    capturedAt: '2026-08-22T12:00:00.000Z',
    deviceId: 'device-a',
  };
  const withoutCredentialField = await createSnapshot({
    ...common,
    payload: { providers: [{ id: 'one', model: 'm' }] },
  });
  const withRedactedCredentialField = await createSnapshot({
    ...common,
    payload: { providers: [{ id: 'one', model: 'm', apiKey: redactedValue() }] },
  });

  assert.notEqual(withoutCredentialField.contentHash, withRedactedCredentialField.contentHash);
  assert.match(withoutCredentialField.nonSensitiveHash, /^[a-f0-9]{64}$/);
  assert.equal(withoutCredentialField.nonSensitiveHash, withRedactedCredentialField.nonSensitiveHash);
  assert.equal(await verifySnapshot(withRedactedCredentialField, {
    adapterId: 'example',
    adapterVersion: 1,
  }), true);
});
