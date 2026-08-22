import test from 'node:test';
import assert from 'node:assert/strict';

import { createPassphraseSensitiveCodec } from '../src/core/sensitive-envelope.js';

test('AES-GCM sensitive envelope roundtrips without storing plaintext or the passphrase', async () => {
  const passphrase = 'correct horse battery staple';
  const sensitive = {
    baseURL: 'https://private.example/v1',
    apiKey: 'super-secret-api-key',
  };
  const codec = createPassphraseSensitiveCodec(passphrase);

  const envelope = await codec.encrypt(sensitive, 'dream-card-agent/providers/v1');
  const secondEnvelope = await codec.encrypt(sensitive, 'dream-card-agent/providers/v1');
  const serialized = JSON.stringify(envelope);

  assert.equal(envelope.$ttSyncBridge, 'encrypted-v1');
  assert.equal(serialized.includes(sensitive.baseURL), false);
  assert.equal(serialized.includes(sensitive.apiKey), false);
  assert.equal(serialized.includes(passphrase), false);
  assert.equal(envelope.fingerprint, secondEnvelope.fingerprint);
  assert.notEqual(envelope.ciphertext, secondEnvelope.ciphertext);
  assert.deepEqual(await codec.decrypt(envelope, 'dream-card-agent/providers/v1'), sensitive);
});

test('AES-GCM sensitive envelope rejects a wrong passphrase without exposing decrypted data', async () => {
  const envelope = await createPassphraseSensitiveCodec('source passphrase').encrypt(
    { apiKey: 'secret-value' },
    'dream-card-agent/providers/v1',
  );

  await assert.rejects(
    () => createPassphraseSensitiveCodec('wrong passphrase').decrypt(envelope, 'dream-card-agent/providers/v1'),
    /unable to decrypt sensitive data/i,
  );
});

test('sensitive codec refuses short passphrases', () => {
  assert.throws(() => createPassphraseSensitiveCodec('short'), /at least 8 characters/i);
});
