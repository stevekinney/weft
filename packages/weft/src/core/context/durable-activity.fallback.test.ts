import { afterEach, describe, expect, it } from 'bun:test';

import {
  DurableActivityScopeError,
  durableActivity,
  resetDurableActivityScopeStorageForTesting,
  runWithDurableActivityScope,
  type DurableActivityScope,
} from './durable-activity.ts';

/**
 * Makes the module choose its process-local fallback instead of `AsyncLocalStorage`, as it does on
 * an edge or browser host, by running its first scope lookup while `process` offers no way to load
 * a built-in module. The module keeps that choice, so `process` is put back as soon as the lookup
 * is done and the rest of the test runs on the real runtime.
 */
function chooseFallback(hideProcess: (lookup: () => void) => void): void {
  resetDurableActivityScopeStorageForTesting();
  hideProcess(() => {
    runWithDurableActivityScope({ dispatch: async () => undefined as never }, () => undefined);
  });
}

/** The host has a `process` global that offers no way to load a built-in module. */
function withProcessLackingBuiltinModules(lookup: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
  Object.defineProperty(globalThis, 'process', { configurable: true, value: {}, writable: true });
  try {
    lookup();
  } finally {
    if (descriptor !== undefined) Object.defineProperty(globalThis, 'process', descriptor);
  }
}

/** The host has no `process` global at all. */
function withoutProcessGlobal(lookup: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
  Reflect.deleteProperty(globalThis, 'process');
  try {
    lookup();
  } finally {
    if (descriptor !== undefined) Object.defineProperty(globalThis, 'process', descriptor);
  }
}

function recordingScope(dispatched: string[], answer: unknown): DurableActivityScope {
  return {
    dispatch: async (invocation) => {
      dispatched.push(String(invocation.activity));
      return answer as never;
    },
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('durableActivity scope without AsyncLocalStorage', () => {
  // Leave the module on the runtime's own choice for whichever test file runs next.
  afterEach(() => {
    resetDurableActivityScopeStorageForTesting();
  });

  for (const [label, hideProcess] of [
    ['a process global with no getBuiltinModule', withProcessLackingBuiltinModules],
    ['no process global', withoutProcessGlobal],
  ] as const) {
    describe(label, () => {
      it('keeps the one active scope across awaits, so an awaited helper dispatches through it', async () => {
        chooseFallback(hideProcess);
        const dispatched: string[] = [];

        const result = await runWithDurableActivityScope(
          recordingScope(dispatched, 'fallback-result'),
          async () => {
            await Promise.resolve();
            return durableActivity('fallbackTool');
          },
        );

        expect(result).toBe('fallback-result');
        expect(dispatched).toEqual(['fallbackTool']);
      });

      it('drops the scope once an async callback settles, so the helper is refused afterwards', async () => {
        chooseFallback(hideProcess);

        await runWithDurableActivityScope(recordingScope([], null), async () => 'done');
        const refused = await rejectionOf(durableActivity('afterScope'));

        expect(refused).toBeInstanceOf(DurableActivityScopeError);
        expect((refused as Error).message).toContain(
          'can only be called from a ctx.memo() callback',
        );
      });

      it('returns a plain value, object or function result untouched and drops the scope at once', async () => {
        chooseFallback(hideProcess);
        const answer = {};
        const callback = () => 'callback';

        expect(runWithDurableActivityScope(recordingScope([], null), () => 41)).toBe(41);
        expect(runWithDurableActivityScope(recordingScope([], null), () => answer)).toBe(answer);
        expect(runWithDurableActivityScope(recordingScope([], null), () => callback)).toBe(
          callback,
        );
        expect(runWithDurableActivityScope(recordingScope([], null), () => null)).toBeNull();
        expect(await rejectionOf(durableActivity('afterScope'))).toBeInstanceOf(
          DurableActivityScopeError,
        );
      });

      it('drops the scope when the callback throws, and rethrows', async () => {
        chooseFallback(hideProcess);

        expect(() =>
          runWithDurableActivityScope(recordingScope([], null), () => {
            throw new Error('callback failed');
          }),
        ).toThrow('callback failed');
        expect(await rejectionOf(durableActivity('afterScope'))).toBeInstanceOf(
          DurableActivityScopeError,
        );
      });

      it('refuses to guess between two memo callbacks that are active at once', async () => {
        chooseFallback(hideProcess);
        const dispatched: string[] = [];
        const firstMayContinue = Promise.withResolvers<void>();
        const secondMayFinish = Promise.withResolvers<void>();

        const first = runWithDurableActivityScope(recordingScope(dispatched, 'first'), async () => {
          await firstMayContinue.promise;
          return durableActivity('firstTool');
        });
        const second = runWithDurableActivityScope(
          recordingScope(dispatched, 'second'),
          async () => {
            await secondMayFinish.promise;
            return 'second-done';
          },
        );
        firstMayContinue.resolve();
        const refused = await rejectionOf(first);
        secondMayFinish.resolve();

        expect(refused).toBeInstanceOf(DurableActivityScopeError);
        expect((refused as Error).message).toContain('cannot resolve a unique ctx.memo() scope');
        expect(await second).toBe('second-done');
        expect(dispatched).toEqual([]);
      });
    });
  }
});
