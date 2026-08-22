const REDACTED_MARKER = 'redacted-v1';
const OMIT = Symbol('omit-redacted-without-local-value');

export function redactedValue() {
  return { $ttSyncBridge: REDACTED_MARKER };
}

export function isRedacted(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.keys(value).length === 1
      && value.$ttSyncBridge === REDACTED_MARKER,
  );
}

export function stripRedacted(value) {
  function strip(current) {
    if (isRedacted(current)) return OMIT;
    if (current === null || typeof current !== 'object') return current;
    if (Array.isArray(current)) {
      return current.flatMap(item => {
        const stripped = strip(item);
        return stripped === OMIT ? [] : [stripped];
      });
    }
    const output = {};
    for (const [key, child] of Object.entries(current)) {
      const stripped = strip(child);
      if (stripped !== OMIT) output[key] = stripped;
    }
    return output;
  }

  const stripped = strip(value);
  return stripped === OMIT ? null : stripped;
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function childPath(parent, key, isArrayIndex = false) {
  return isArrayIndex ? `${parent}[${key}]` : `${parent}.${key}`;
}

export function redactClone(value, {
  sensitiveKeyPatterns = [],
  excludedPaths = [],
  includeSensitive = false,
} = {}) {
  if (includeSensitive) {
    throw new Error('Encrypted sensitive sync is not implemented; refusing plaintext inclusion');
  }

  const exactExcludedPaths = new Set(excludedPaths);
  const redactions = [];

  function visit(current, path, key = '') {
    const keyIsSensitive = key !== '' && sensitiveKeyPatterns.some(pattern => pattern.test(key));
    if (keyIsSensitive || exactExcludedPaths.has(path)) {
      redactions.push({ path, reason: keyIsSensitive ? 'sensitive-key' : 'excluded-path' });
      return redactedValue();
    }
    if (current === null || typeof current !== 'object') {
      return current;
    }
    if (Array.isArray(current)) {
      return current.map((item, index) => visit(item, childPath(path, index, true)));
    }
    const output = {};
    for (const [childKey, childValue] of Object.entries(current)) {
      output[childKey] = visit(childValue, childPath(path, childKey), childKey);
    }
    return output;
  }

  return { value: visit(value, '$'), redactions };
}

function identityFor(value, identityKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const key of identityKeys) {
    if (typeof value[key] === 'string' || typeof value[key] === 'number') {
      return `${key}:${String(value[key])}`;
    }
  }
  return null;
}

export function mergeRedacted(localValue, incomingValue, {
  arrayIdentityKeys = ['id', 'uuid', 'key', 'name'],
  preserveLocalKeyPatterns = [],
} = {}) {
  function merge(local, incoming) {
    if (isRedacted(incoming)) {
      return local === undefined ? OMIT : cloneJson(local);
    }
    if (incoming === null || typeof incoming !== 'object') {
      return incoming;
    }
    if (Array.isArray(incoming)) {
      const localArray = Array.isArray(local) ? local : [];
      const localByIdentity = new Map();
      for (const item of localArray) {
        const identity = identityFor(item, arrayIdentityKeys);
        if (identity !== null) localByIdentity.set(identity, item);
      }
      return incoming.map((item, index) => {
        const identity = identityFor(item, arrayIdentityKeys);
        const matchingLocal = identity === null ? localArray[index] : localByIdentity.get(identity);
        const merged = merge(matchingLocal, item);
        return merged === OMIT ? undefined : merged;
      });
    }

    const localObject = local && typeof local === 'object' && !Array.isArray(local) ? local : {};
    const output = {};
    for (const [key, incomingChild] of Object.entries(incoming)) {
      const merged = merge(localObject[key], incomingChild);
      if (merged !== OMIT) output[key] = merged;
    }
    for (const [key, localChild] of Object.entries(localObject)) {
      if (Object.hasOwn(incoming, key)) continue;
      if (preserveLocalKeyPatterns.some(pattern => {
        pattern.lastIndex = 0;
        return pattern.test(key);
      })) {
        output[key] = cloneJson(localChild);
      }
    }
    return output;
  }

  const result = merge(localValue, incomingValue);
  return result === OMIT ? undefined : result;
}
