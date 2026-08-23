import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalJson, strictCanonicalJson } from '../src/core/canonical-json.js';

test('API Manager flattened optional fields are JSON-compatible for runtime fingerprints', () => {
  const flattenedConfig = {
    name: '[Primary] model-a',
    source: 'custom',
    customUrl: 'https://source.private/v1',
    apiKeys: [{ id: 'key-1', key: 'source-secret' }],
    currentKeyIndex: 0,
    enableKeyRotation: true,
    customModel: 'model-a',
    groupName: 'Primary',
    groupKey: 'primary|https://source.private/v1',
    categoryId: undefined,
    categoryIds: [],
    isActive: false,
    lastVerifiedAt: undefined,
    lastVerifiedKeyIndex: undefined,
    lastHealthStatus: undefined,
    lastHealthError: undefined,
    isPlaceholder: false,
  };

  const runtimeCanonical = canonicalJson({ configs: [flattenedConfig] });
  const jsonRoundTrip = JSON.parse(JSON.stringify({ configs: [flattenedConfig] }));

  assert.equal(runtimeCanonical, canonicalJson(jsonRoundTrip));
  assert.throws(() => strictCanonicalJson({ configs: [flattenedConfig] }), /unsupported undefined/);
});
