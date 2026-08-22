function canonicalize(value, stack) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Snapshot payload contains a non-finite number');
    }
    return JSON.stringify(value);
  }

  if (typeof value !== 'object') {
    throw new TypeError(`Snapshot payload contains unsupported ${typeof value}`);
  }

  if (stack.has(value)) {
    throw new TypeError('Snapshot payload contains a cycle');
  }
  stack.add(value);

  let result;
  if (Array.isArray(value)) {
    result = `[${value.map(item => canonicalize(item, stack)).join(',')}]`;
  } else {
    const keys = Object.keys(value).sort();
    const entries = keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key], stack)}`);
    result = `{${entries.join(',')}}`;
  }

  stack.delete(value);
  return result;
}

export function canonicalJson(value) {
  return canonicalize(value, new Set());
}
