import { canonicalJson } from './canonical-json.js';

const ENVELOPE_MARKER = 'encrypted-v1';
const KDF_ITERATIONS = 310_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FINGERPRINT_SALT = encoder.encode('tt-extension-sync-bridge/fingerprint/v1');

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  if (typeof value !== 'string' || value === '') throw new TypeError('Encrypted envelope is invalid');
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    throw new TypeError('Encrypted envelope is invalid');
  }
}

function validateEnvelope(envelope) {
  if (
    !envelope
    || typeof envelope !== 'object'
    || Array.isArray(envelope)
    || envelope.$ttSyncBridge !== ENVELOPE_MARKER
    || envelope.algorithm !== 'AES-GCM-256'
    || envelope.kdf !== 'PBKDF2-SHA-256'
    || !Number.isInteger(envelope.iterations)
    || envelope.iterations < 100_000
  ) {
    throw new TypeError('Encrypted envelope is invalid');
  }
}

async function deriveKey(cryptoImpl, passphrase, salt, iterations, usages) {
  const material = await cryptoImpl.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return cryptoImpl.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}

async function sensitiveFingerprint(cryptoImpl, passphrase, value, context) {
  const material = await cryptoImpl.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const key = await cryptoImpl.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: FINGERPRINT_SALT, iterations: KDF_ITERATIONS },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  const signature = await cryptoImpl.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${context}\n${canonicalJson(value)}`),
  );
  return bytesToBase64(new Uint8Array(signature));
}

export function isEncryptedEnvelope(value) {
  return Boolean(value && typeof value === 'object' && value.$ttSyncBridge === ENVELOPE_MARKER);
}

export function createPassphraseSensitiveCodec(passphrase, { cryptoImpl = globalThis.crypto } = {}) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new TypeError('Sensitive sync passphrase must be at least 8 characters');
  }
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== 'function') {
    throw new Error('Web Crypto API is unavailable');
  }

  return Object.freeze({
    async encrypt(value, context) {
      if (typeof context !== 'string' || context === '') throw new TypeError('Encryption context is required');
      const salt = cryptoImpl.getRandomValues(new Uint8Array(SALT_BYTES));
      const iv = cryptoImpl.getRandomValues(new Uint8Array(IV_BYTES));
      const key = await deriveKey(cryptoImpl, passphrase, salt, KDF_ITERATIONS, ['encrypt']);
      const ciphertext = await cryptoImpl.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(context), tagLength: 128 },
        key,
        encoder.encode(JSON.stringify(value)),
      );
      const fingerprint = await sensitiveFingerprint(cryptoImpl, passphrase, value, context);
      return {
        $ttSyncBridge: ENVELOPE_MARKER,
        algorithm: 'AES-GCM-256',
        kdf: 'PBKDF2-SHA-256',
        iterations: KDF_ITERATIONS,
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
        fingerprint,
      };
    },

    async decrypt(envelope, context) {
      try {
        validateEnvelope(envelope);
        if (typeof context !== 'string' || context === '') throw new TypeError('Encryption context is required');
        const salt = base64ToBytes(envelope.salt);
        const iv = base64ToBytes(envelope.iv);
        const ciphertext = base64ToBytes(envelope.ciphertext);
        if (salt.byteLength !== SALT_BYTES || iv.byteLength !== IV_BYTES) {
          throw new TypeError('Encrypted envelope is invalid');
        }
        const key = await deriveKey(cryptoImpl, passphrase, salt, envelope.iterations, ['decrypt']);
        const plaintext = await cryptoImpl.subtle.decrypt(
          { name: 'AES-GCM', iv, additionalData: encoder.encode(context), tagLength: 128 },
          key,
          ciphertext,
        );
        return JSON.parse(decoder.decode(plaintext));
      } catch {
        throw new Error('Unable to decrypt sensitive data; check the passphrase');
      }
    },
  });
}
