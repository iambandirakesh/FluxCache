/**
 * Testing helpers for consumers and for this repository's own suite.
 * Kept free of test-framework imports so they work in any runner.
 */

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  settled: boolean;
}

/** A promise whose resolution is controlled by the test. */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = (value) => {
      settled = true;
      resolvePromise(value);
    };
    reject = (reason) => {
      settled = true;
      rejectPromise(reason);
    };
  });
  return {
    promise,
    resolve,
    reject,
    get settled() {
      return settled;
    },
  };
}

/** Lets pending microtasks run (two ticks are enough for one await chain). */
export async function flushMicrotasks(times = 2): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}
