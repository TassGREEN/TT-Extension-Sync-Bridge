import { sha256Json } from './hash.js';
import { stripRedacted } from './redaction.js';

export const SNAPSHOT_SCHEMA_VERSION = 1;

function requireInteger(value, name, minimum = 1) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

export async function createSnapshot({
  adapterId,
  adapterVersion,
  sourceRevision,
  capturedAt,
  deviceId,
  sensitiveDataIncluded = false,
  payload,
}) {
  requireNonEmptyString(adapterId, 'adapterId');
  requireInteger(adapterVersion, 'adapterVersion');
  requireInteger(sourceRevision, 'sourceRevision');
  requireNonEmptyString(deviceId, 'deviceId');
  if (typeof capturedAt !== 'string' || Number.isNaN(Date.parse(capturedAt))) {
    throw new TypeError('capturedAt must be an ISO-8601 timestamp');
  }
  if (typeof sensitiveDataIncluded !== 'boolean') {
    throw new TypeError('sensitiveDataIncluded must be boolean');
  }
  if (payload === undefined) {
    throw new TypeError('payload is required');
  }

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    adapterId,
    adapterVersion,
    sourceRevision,
    capturedAt,
    deviceId,
    contentHash: await sha256Json(payload),
    nonSensitiveHash: await sha256Json(stripRedacted(payload)),
    sensitiveDataIncluded,
    payload,
  };
}

export async function verifySnapshot(snapshot, { adapterId, adapterVersion }) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('Snapshot must be an object');
  }
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`Unsupported snapshot schema version: ${String(snapshot.schemaVersion)}`);
  }
  if (snapshot.adapterId !== adapterId) {
    throw new Error(`Snapshot adapter mismatch: expected ${adapterId}`);
  }
  requireInteger(snapshot.adapterVersion, 'adapterVersion');
  if (snapshot.adapterVersion > adapterVersion) {
    throw new Error(`Unsupported adapter version: ${String(snapshot.adapterVersion)}`);
  }
  requireInteger(snapshot.sourceRevision, 'sourceRevision');
  requireNonEmptyString(snapshot.deviceId, 'deviceId');
  if (typeof snapshot.capturedAt !== 'string' || Number.isNaN(Date.parse(snapshot.capturedAt))) {
    throw new TypeError('Snapshot capturedAt is invalid');
  }
  if (typeof snapshot.sensitiveDataIncluded !== 'boolean') {
    throw new TypeError('Snapshot sensitiveDataIncluded is invalid');
  }
  requireNonEmptyString(snapshot.contentHash, 'contentHash');
  requireNonEmptyString(snapshot.nonSensitiveHash, 'nonSensitiveHash');

  const actualHash = await sha256Json(snapshot.payload);
  if (actualHash !== snapshot.contentHash) {
    throw new Error('Snapshot content hash mismatch');
  }
  const actualNonSensitiveHash = await sha256Json(stripRedacted(snapshot.payload));
  if (actualNonSensitiveHash !== snapshot.nonSensitiveHash) {
    throw new Error('Snapshot non-sensitive hash mismatch');
  }
  return true;
}
