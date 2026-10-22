import { describe, expect, it } from 'vitest';
import { FluxCacheKeyError } from '../../src/core/errors';
import {
  canonicalizeQueryKey,
  isQueryKey,
  queryKeysEqual,
  queryKeyStartsWith,
} from '../../src/core/key';

describe('canonicalizeQueryKey', () => {
  it('is deterministic', () => {
    expect(canonicalizeQueryKey(['product', 1, { a: 1 }])).toBe(
      canonicalizeQueryKey(['product', 1, { a: 1 }]),
    );
  });

  it('ignores object property order', () => {
    expect(canonicalizeQueryKey(['x', { a: 1, b: 2 }])).toBe(
      canonicalizeQueryKey(['x', { b: 2, a: 1 }]),
    );
  });

  it('respects array order', () => {
    expect(canonicalizeQueryKey(['a', 'b'])).not.toBe(canonicalizeQueryKey(['b', 'a']));
  });

  it('keeps null and undefined distinct', () => {
    expect(canonicalizeQueryKey([null])).not.toBe(canonicalizeQueryKey([undefined]));
    expect(canonicalizeQueryKey(['x', null])).not.toBe(canonicalizeQueryKey(['x', undefined]));
  });

  it('ignores undefined object properties, like JSON', () => {
    expect(canonicalizeQueryKey([{ a: 1, b: undefined }])).toBe(canonicalizeQueryKey([{ a: 1 }]));
  });

  it('never collides on delimiters or types', () => {
    const keys = [['a', 'b'], ['ab'], ['s1:'], [1], ['1'], [true], ['true'], [{ a: 'b' }], ['a:b']];
    const serialized = keys.map((key) => canonicalizeQueryKey(key));
    expect(new Set(serialized).size).toBe(keys.length);
  });

  it('treats negative zero as zero', () => {
    expect(canonicalizeQueryKey([-0])).toBe(canonicalizeQueryKey([0]));
  });

  it('supports nested structures', () => {
    const key = ['a', { b: [1, { c: null }] }, undefined];
    expect(canonicalizeQueryKey(key)).toBe(canonicalizeQueryKey(structuredClone(key)));
  });

  it('rejects non-array keys with a synchronous error', () => {
    expect(() => canonicalizeQueryKey('todos' as never)).toThrow(FluxCacheKeyError);
    expect(() => canonicalizeQueryKey('todos' as never)).toThrow(/must be arrays/);
  });

  it.each([
    ['function', () => 1],
    ['symbol', Symbol('x')],
    ['bigint', 1n],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['Date', new Date(0)],
    ['Map', new Map()],
  ])('rejects %s values', (_label, value) => {
    expect(() => canonicalizeQueryKey(['x', value as never])).toThrow(FluxCacheKeyError);
  });

  it('rejects class instances with a useful message', () => {
    class User {
      constructor(readonly id: number) {}
    }
    expect(() => canonicalizeQueryKey([new User(1) as never])).toThrow(
      /User values are not supported/,
    );
  });

  it('rejects circular references', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonicalizeQueryKey([cyclic as never])).toThrow(/Circular references/);
  });

  it('reports the failing path', () => {
    expect(() => canonicalizeQueryKey(['product', { id: () => 1 } as never])).toThrow(
      /queryKey\[1\]\.id/,
    );
  });

  it('isQueryKey never throws', () => {
    expect(isQueryKey(['ok'])).toBe(true);
    expect(isQueryKey('nope')).toBe(false);
    expect(isQueryKey([() => 1])).toBe(false);
  });
});

describe('queryKeysEqual', () => {
  it('compares structurally', () => {
    expect(queryKeysEqual(['a', { b: 1, c: [2] }], ['a', { c: [2], b: 1 }])).toBe(true);
    expect(queryKeysEqual(['a'], ['a', 'b'])).toBe(false);
  });

  it('distinguishes null from undefined', () => {
    expect(queryKeysEqual([null], [undefined])).toBe(false);
  });
});

describe('queryKeyStartsWith', () => {
  it('matches prefixes element by element', () => {
    expect(queryKeyStartsWith(['product', 1, 'detail'], ['product'])).toBe(true);
    expect(queryKeyStartsWith(['product', 1], ['product', 1])).toBe(true);
    expect(queryKeyStartsWith(['product', 1], ['product', 2])).toBe(false);
    expect(queryKeyStartsWith(['product'], ['product', 1])).toBe(false);
  });

  it('compares object elements structurally', () => {
    expect(
      queryKeyStartsWith(['items', { page: 1, size: 2 }], ['items', { size: 2, page: 1 }]),
    ).toBe(true);
  });

  it('does not treat a partial array element as a prefix', () => {
    expect(queryKeyStartsWith([['a', 'b']], [['a']])).toBe(false);
  });
});
