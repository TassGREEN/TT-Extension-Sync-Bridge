import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalJson, strictCanonicalJson } from '../src/core/canonical-json.js';

test('canonicalJson follows JSON.stringify semantics for undefined inside containers', () => {
  assert.equal(canonicalJson({ b: undefined, a: 1 }), '{"a":1}');
  assert.equal(canonicalJson([1, undefined, 3]), '[1,null,3]');
});

test('strictCanonicalJson still rejects undefined for snapshot hashing', () => {
  assert.throws(
    () => strictCanonicalJson({ a: 1, b: undefined }),
    /Snapshot payload contains unsupported undefined/,
  );
});
