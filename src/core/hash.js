import { strictCanonicalJson } from './canonical-json.js';

function toHex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Bytes(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable');
  }
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', value);
  return toHex(new Uint8Array(digest));
}

export async function sha256Text(text) {
  return sha256Bytes(new TextEncoder().encode(text));
}

export async function sha256Json(value) {
  return sha256Text(strictCanonicalJson(value));
}
