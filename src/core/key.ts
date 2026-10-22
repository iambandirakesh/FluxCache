import { FluxCacheKeyError } from './errors';
import type { QueryKey, QueryKeyPart } from './types';

const MAX_DEPTH = 64;

/**
 * Serializes a query key into a stable, collision-free string.
 *
 * Values are tagged and length-prefixed so that `['a', 'b']`, `['ab']` and
 * `['s1:']` can never collide. Object property order does not matter and
 * `undefined` object properties are ignored; array elements keep their
 * position, and `undefined` is distinct from `null`.
 *
 * @throws FluxCacheKeyError synchronously for anything that cannot be keyed.
 */
export function canonicalizeQueryKey(key: QueryKey): string {
  if (!Array.isArray(key)) {
    throw new FluxCacheKeyError('Query keys must be arrays', 'queryKey');
  }
  return encode(key as QueryKeyPart, 'queryKey', 0, new Set<object>());
}

/** Returns true when the key is structurally valid and can be serialized. */
export function isQueryKey(value: unknown): value is QueryKey {
  try {
    canonicalizeQueryKey(value as QueryKey);
    return true;
  } catch {
    return false;
  }
}

/** Stable structural equality for two validated keys. */
export function queryKeysEqual(left: QueryKey, right: QueryKey): boolean {
  return deepEqualPart(left, right, 0);
}

/** True when `key` starts with `prefix`, comparing elements structurally. */
export function queryKeyStartsWith(key: QueryKey, prefix: QueryKey): boolean {
  if (prefix.length > key.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (!deepEqualPart(key[index], prefix[index], 0)) return false;
  }
  return true;
}

/** 32-bit FNV-1a hash used for diagnostic events (never for lookups). */
export function hashQueryKey(canonicalKey: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonicalKey.length; index += 1) {
    hash ^= canonicalKey.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function encode(value: QueryKeyPart, path: string, depth: number, seen: Set<object>): string {
  if (depth > MAX_DEPTH) {
    throw new FluxCacheKeyError(`Query key nesting exceeds ${MAX_DEPTH} levels`, path);
  }

  switch (typeof value) {
    case 'string':
      return `s${value.length}:${value}`;
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new FluxCacheKeyError(`Non-finite number ${String(value)} is not serializable`, path);
      }
      return `n${Object.is(value, -0) ? '0' : String(value)}`;
    }
    case 'boolean':
      return value ? 'b1' : 'b0';
    case 'undefined':
      return 'u';
    case 'bigint':
      throw new FluxCacheKeyError('BigInt values are not supported in query keys', path);
    case 'function':
      throw new FluxCacheKeyError('Functions are not supported in query keys', path);
    case 'symbol':
      throw new FluxCacheKeyError('Symbols are not supported in query keys', path);
    case 'object':
      break;
    default:
      throw new FluxCacheKeyError(`Unsupported value of type ${typeof value}`, path);
  }

  if (value === null) return 'z';

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new FluxCacheKeyError('Circular references are not supported in query keys', path);
    }
    seen.add(value);
    let out = `a${value.length}:`;
    for (let index = 0; index < value.length; index += 1) {
      out += encode(value[index] as QueryKeyPart, `${path}[${index}]`, depth + 1, seen);
    }
    seen.delete(value);
    return out;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    const name =
      (value as { constructor?: { name?: string } }).constructor?.name ?? 'class instance';
    throw new FluxCacheKeyError(
      `${name} values are not supported in query keys; use plain objects, arrays and primitives`,
      path,
    );
  }
  if (seen.has(value)) {
    throw new FluxCacheKeyError('Circular references are not supported in query keys', path);
  }

  seen.add(value);
  const record = value as Record<string, QueryKeyPart>;
  const keys = Object.keys(record)
    .filter((property) => record[property] !== undefined)
    .sort();
  let out = `o${keys.length}:`;
  for (const property of keys) {
    out += `s${property.length}:${property}`;
    out += encode(record[property] as QueryKeyPart, `${path}.${property}`, depth + 1, seen);
  }
  seen.delete(value);
  return out;
}

function deepEqualPart(left: unknown, right: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (typeof left !== 'object') return false;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqualPart(left[index], right[index], depth + 1)) return false;
    }
    return true;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord)
    .filter((property) => leftRecord[property] !== undefined)
    .sort();
  const rightKeys = Object.keys(rightRecord)
    .filter((property) => rightRecord[property] !== undefined)
    .sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    if (leftKeys[index] !== rightKeys[index]) return false;
    if (
      !deepEqualPart(
        leftRecord[leftKeys[index] as string],
        rightRecord[leftKeys[index] as string],
        depth + 1,
      )
    ) {
      return false;
    }
  }
  return true;
}
