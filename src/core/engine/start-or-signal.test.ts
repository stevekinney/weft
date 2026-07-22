import { describe, expect, it } from 'bun:test';

import { CompressedStorage } from '../../storage/compressed-storage.ts';
import type { BatchOperation, Storage } from '../../storage/interface.ts';
import { encodeStorageKeyComponent, KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { flushMicrotasks } from '../../testing/fake-timers.test-support.ts';
import { TestEngine } from '../../testing/test-engine.ts';
import { decode, encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import { WorkflowCompletedEvent } from '../events.ts';
import type { WorkflowContext, WorkflowState } from '../types.ts';
import { workflow } from '../types.ts';
import { drainQueuedInlineWorkflowStartsForEngine } from './engine-runtime-helpers.ts';
import { IdempotencyKeyPurgedError, StartOrSignalConflictError } from './errors.ts';
import { getInternals } from './internals.ts';
import {
  requireWinnerId,
  resolveCallerIdWinnerOrRetry,
  resolveWinnerWithSignal,
  type StartOrSignalCallbacks,
} from './lifecycle/start-or-signal-resolution.ts';
import { startWithIdempotency } from './lifecycle/start-or-signal.ts';

const waitForRelease = workflow({ name: 'wait-for-release' }).execute(async function* (
  ctx: WorkflowContext,
) {
  return yield* ctx.waitForSignal<string>('release');
});

const completesImmediately = workflow({ name: 'completes-immediately' }).execute(
  async function* () {
    return 'done';
  },
);

const throwsImmediately = workflow({ name: 'throws-immediately' }).execute(async function* () {
  throw new Error('boom');
});

// Stays parked after consuming the create-batch `release` signal: it then waits
// for a second `hold` signal that the create batch never sends. Used by the
// white-box race-recovery test so the winning run is still non-terminal when a
// losing caller resolves it.
const releaseThenHold = workflow({ name: 'release-then-hold' }).execute(async function* (
  ctx: WorkflowContext,
) {
  yield* ctx.waitForSignal<string>('release');
  return yield* ctx.waitForSignal<string>('hold');
});

const drainsAndCompletes = workflow({ name: 'drains-and-completes' }).execute(async function* (
  ctx: WorkflowContext,
) {
  const result = yield* ctx.race([ctx.waitForSignal<string>('handoff'), ctx.sleep(0)] as const);
  return result ?? 'completed-before-handoff';
});

// Consumes `ev` signals in a loop, recording each payload's tag, and returns the
// ordered list when a signal carries `stop: true`. Used to prove FIFO buffering:
// the order of the returned tags is the order the engine consumed the signals.
const collectEvents = workflow({ name: 'collect-events' }).execute(async function* (
  ctx: WorkflowContext,
) {
  const events: string[] = [];
  for (;;) {
    const event = (yield* ctx.waitForSignal<{ t: string; stop?: boolean }>('ev')) as {
      t: string;
      stop?: boolean;
    };
    events.push(event.t);
    if (event.stop) return { events };
  }
});

function createEngine(storage: Storage = new MemoryStorage()): Engine {
  const engine = new Engine({ storage });
  engine.register(waitForRelease);
  engine.register(completesImmediately);
  engine.register(throwsImmediately);
  engine.register(releaseThenHold);
  engine.register(drainsAndCompletes);
  engine.register(collectEvents);
  return engine;
}

function storageWithBlockedCompletionBatch(
  inner: Storage,
  workflowId: string,
  onBlocked: () => void,
  release: Promise<void>,
): Storage {
  let blocked = false;
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'batch') {
        return async (operations: BatchOperation[]): Promise<void> => {
          const completion = operations.find(
            (operation): operation is Extract<BatchOperation, { type: 'put' }> =>
              operation.type === 'put' && operation.key === KEYS.workflow(workflowId),
          );
          const nextState = completion ? (decode(completion.value) as WorkflowState) : undefined;
          if (!blocked && nextState?.status === 'completed') {
            blocked = true;
            onBlocked();
            await release;
          }
          return target.batch(operations);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Wrap a storage so the first `get` matching `shouldSuppress` that would return a
 * NON-NULL value is suppressed to `null` exactly once, then delegates normally.
 *
 * Used to force the create-batch CAS-loss recovery path deterministically:
 * suppress the loser's post-commit read of the idempotency mapping key. The
 * winner's pre-create lookup returns null naturally (the mapping does not exist
 * yet), so it is NOT the suppressed read; the loser's later lookup — which would
 * see the winner's real mapping — is the one nulled. The loser then skips the
 * top-level mapping branch, builds its own create batch, loses the CAS, and falls
 * into `requireWinnerId` → `resolveWinnerWithSignal`. Suppressing the first read of
 * ANY kind would consume the one-shot on the winner's natural-null lookup and
 * never exercise the recovery path.
 */
function storageWithOneShotNullGet(
  inner: Storage,
  shouldSuppress: (key: string) => boolean,
): Storage {
  let suppressed = false;
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'get') {
        return async (key: string): Promise<Uint8Array | null> => {
          const value = await target.get(key);
          if (!suppressed && shouldSuppress(key) && value !== null) {
            suppressed = true;
            return null;
          }
          return value;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Wrap a storage so the FIRST `conditionalBatch` (the winning caller-id start's
 * commit) parks until released, then throws — simulating a winner that reserved
 * `pendingStarts` but aborts before its durable write (a storage failure, oversized
 * payload, or throwing start interceptor all land here). `onParked` fires once the
 * winner is parked mid-commit (reservation held); awaiting `release` then makes it
 * throw. Every later `conditionalBatch` delegates, so the losing caller's retry
 * commits normally. The loser's first attempt collides on the in-memory reservation
 * at start.ts and never reaches `conditionalBatch`, so "first batch = winner" holds.
 */
function storageWithAbortingFirstConditionalBatch(
  inner: Storage,
  onParked: () => void,
  release: Promise<void>,
): Storage {
  let parkedOnce = false;
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'conditionalBatch') {
        return async (
          conditions: Parameters<NonNullable<Storage['conditionalBatch']>>[0],
          operations: Parameters<NonNullable<Storage['conditionalBatch']>>[1],
        ): Promise<boolean> => {
          if (!parkedOnce) {
            parkedOnce = true;
            onParked();
            await release;
            throw new Error('injected winner abort before durable commit');
          }
          return target.conditionalBatch!(conditions, operations);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function storageWithInjectedBatchFailure(inner: Storage): Storage & { failNextBatch(): void } {
  let shouldFailBatch = false;
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'batch') {
        return async (operations: BatchOperation[]): Promise<void> => {
          if (shouldFailBatch) {
            shouldFailBatch = false;
            throw new Error('injected plain create batch failure');
          }
          return target.batch(operations);
        };
      }
      if (property === 'failNextBatch') {
        return () => {
          shouldFailBatch = true;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Storage & { failNextBatch(): void };
}

/**
 * Count durable workflow records currently in storage. The record key is exactly
 * `wf:<encoded-id>` (one structural colon); sub-keys like the checkpoint
 * `wf:<id>:ckpt` carry a second colon and are excluded, since a raw `:` in a key
 * always denotes a separator (ids encode their own colons as `%3A`).
 */
async function countWorkflowRecords(engine: Engine): Promise<number> {
  let count = 0;
  for await (const [key] of engine.storage.scan('wf:')) {
    if (key.indexOf(':', 'wf:'.length) === -1) {
      count += 1;
    }
  }
  return count;
}

async function readStoredWorkflowState(engine: Engine, workflowId: string): Promise<WorkflowState> {
  const bytes = await engine.storage.get(KEYS.workflow(workflowId));
  if (bytes === null) {
    throw new Error(`Expected stored workflow state for ${workflowId}`);
  }
  return decode(bytes) as WorkflowState;
}

function unexpectedStartOrSignalCallbacks(): StartOrSignalCallbacks {
  const unexpected = (): never => {
    throw new Error('restart retry regression must not use lifecycle callbacks');
  };
  const unexpectedAsync = async (): Promise<never> => unexpected();

  return {
    dispatchEvent: unexpected,
    getHandle: unexpected,
    createWorkflowHandleWithResultPromise: unexpected,
    runSerializedWorkflowStateWrite: unexpectedAsync,
    getComposedWorkflowInterceptor: () => null,
    resolveWorkflowTypeTarget: unexpected,
    processPendingUpdatesAfterReplay: unexpectedAsync,
    processPendingUpdatesAfterInlineAdvance: unexpectedAsync,
    processPendingUpdatesForHandlers: unexpectedAsync,
    queueInlineWorkflowExecutionStart: unexpected,
    isInlineWorkflowLocallyOwned: () => false,
    hasLocalCheckpointOwnership: () => false,
    handleCleanupError: unexpected,
    swallowPromiseRejection: async () => {},
    enforceHistoryCircuitBreaker: unexpectedAsync,
    failWorkflowForUnavailableServices: unexpectedAsync,
    failWorkflowForRecoveryHook: unexpectedAsync,
    failWorkflowForCheckpointDecodeError: unexpectedAsync,
    failWorkflowForVersionMismatch: unexpectedAsync,
    signalExistingWorkflow: unexpectedAsync,
  };
}

/**
 * Load-bearing precondition for atomic startOrSignal: a workflow consumes a
 * signal that was durably present BEFORE it first ran. `processWaitSignalOperation`
 * is scan-then-park — it calls `consumeSignal` (a durable storage scan) before
 * registering any in-memory waiter — so a signal sitting in storage at launch is
 * found on first drive rather than orphaned.
 */
describe('signal buffered before a workflow starts', () => {
  it('is consumed on the first drive when present in storage at launch', async () => {
    const engine = createEngine();
    try {
      const workflowId = 'buffered-before-start';
      await engine.signal(workflowId, 'release', 'unblocked', { signalId: 'sig-1' });
      const handle = await engine.start('wait-for-release', null, { id: workflowId });
      expect(await handle.result()).toBe('unblocked');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('dedupes a duplicate signalId so a second identical signal is a no-op', async () => {
    const engine = createEngine();
    try {
      const workflowId = 'dedupe-before-start';
      await engine.signal(workflowId, 'release', 'first', { signalId: 'dup' });
      await engine.signal(workflowId, 'release', 'second', { signalId: 'dup' });
      const handle = await engine.start('wait-for-release', null, { id: workflowId });
      expect(await handle.result()).toBe('first');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});

describe('engine.start idempotency', () => {
  it('returns the same handle for a duplicate idempotency key', async () => {
    const engine = createEngine();
    try {
      const first = await engine.start('wait-for-release', null, { idempotencyKey: 'key-1' });
      const second = await engine.start('wait-for-release', null, { idempotencyKey: 'key-1' });
      expect(second.id).toBe(first.id);
      expect(await countWorkflowRecords(engine)).toBe(1);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('returns the existing handle for a duplicate key even after the run is terminal', async () => {
    const engine = createEngine();
    try {
      const first = await engine.start('completes-immediately', null, { idempotencyKey: 'term-1' });
      expect(await first.result()).toBe('done');

      const second = await engine.start('completes-immediately', null, {
        idempotencyKey: 'term-1',
      });
      expect(second.id).toBe(first.id);
      // Dedup never restarts: the terminal handle is returned, not a fresh run.
      expect(await second.result()).toBe('done');
      expect(await countWorkflowRecords(engine)).toBe(1);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('creates distinct workflows for distinct idempotency keys', async () => {
    const engine = createEngine();
    try {
      const first = await engine.start('wait-for-release', null, { idempotencyKey: 'a' });
      const second = await engine.start('wait-for-release', null, { idempotencyKey: 'b' });
      expect(second.id).not.toBe(first.id);
      expect(await countWorkflowRecords(engine)).toBe(2);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('throws when the storage backend lacks conditionalBatch', async () => {
    const engine = createEngine(new CompressedStorage(new MemoryStorage()));
    try {
      await expect(
        engine.start('wait-for-release', null, { idempotencyKey: 'no-cas' }),
      ).rejects.toThrow(/conditionalBatch/);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('converges concurrent same-key starts to one workflow and one shared handle id', async () => {
    const engine = createEngine();
    try {
      const [a, b, c] = await Promise.all([
        engine.start('wait-for-release', null, { idempotencyKey: 'race' }),
        engine.start('wait-for-release', null, { idempotencyKey: 'race' }),
        engine.start('wait-for-release', null, { idempotencyKey: 'race' }),
      ]);
      expect(b.id).toBe(a.id);
      expect(c.id).toBe(a.id);
      expect(await countWorkflowRecords(engine)).toBe(1);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('rejects supplying both id and idempotencyKey', async () => {
    const engine = createEngine();
    try {
      await expect(
        engine.start('wait-for-release', null, { id: 'fixed', idempotencyKey: 'k' }),
      ).rejects.toThrow(/mutually exclusive/);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('rejects an empty idempotencyKey', async () => {
    const engine = createEngine();
    try {
      await expect(engine.start('wait-for-release', null, { idempotencyKey: '' })).rejects.toThrow(
        /must not be empty/,
      );
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('throws when startWithIdempotency is invoked without an idempotency key (white-box)', async () => {
    const engine = createEngine();
    try {
      await expect(
        startWithIdempotency(
          getInternals(engine),
          'wait-for-release',
          null,
          {} as never,
          {} as never,
        ),
      ).rejects.toThrow('startWithIdempotency requires options.idempotencyKey');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('rejects an idempotencyKey longer than the byte cap', async () => {
    const engine = createEngine();
    try {
      await expect(
        engine.start('wait-for-release', null, { idempotencyKey: 'k'.repeat(118) }),
      ).rejects.toThrow(/at most 117 UTF-8 bytes/);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('throws IdempotencyKeyPurgedError when the key maps to a purged workflow', async () => {
    const engine = createEngine();
    try {
      const first = await engine.start('completes-immediately', null, {
        idempotencyKey: 'purge-me',
      });
      await first.result();
      // The run is terminal; purge deletes its record but leaves the mapping.
      await engine.purge({ idPrefix: first.id });

      await expect(
        engine.start('completes-immediately', null, { idempotencyKey: 'purge-me' }),
      ).rejects.toBeInstanceOf(IdempotencyKeyPurgedError);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('throws IdempotencyKeyPurgedError when the post-CAS winner lookup hits a purged run (white-box)', async () => {
    // White-box coverage for the keyed CAS-loss recovery line (startWithIdempotency
    // line 164): after losing the mapping CAS, the winner id is read back from the
    // surviving mapping and its record asserted present. If that record was purged
    // since the key created, the recovery must reject with IdempotencyKeyPurgedError
    // rather than hand back a handle to a vanished run — mirroring the top-level
    // mapping hit. We force the CAS-loss branch deterministically: create + purge a
    // keyed run (record gone, mapping survives), then suppress the top-level mapping
    // lookup so the second start skips that early throw, builds its own create
    // batch, loses the still-present mapping CAS, and recovers into the line under
    // test — which re-reads the mapping and finds the record purged.
    const inner = new MemoryStorage();
    const mappingKey = KEYS.startIdempotency('start-cas-purged');
    const engine = new Engine({
      storage: storageWithOneShotNullGet(inner, (key) => key === mappingKey),
    });
    engine.register(completesImmediately);
    try {
      const first = await engine.start('completes-immediately', null, {
        idempotencyKey: 'start-cas-purged',
      });
      await first.result();
      await engine.purge({ idPrefix: first.id });

      await expect(
        engine.start('completes-immediately', null, { idempotencyKey: 'start-cas-purged' }),
      ).rejects.toBeInstanceOf(IdempotencyKeyPurgedError);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('propagates an unregistered-type error from the keyed start path (not swallowed as a race)', async () => {
    const engine = createEngine();
    try {
      // The keyed path commits via the idempotency CAS; an unregistered type
      // throws WorkflowNotRegisteredError, which is NOT a lost-race sentinel and
      // must surface rather than being mistaken for a concurrent winner.
      await expect(
        engine.start('not-registered', null, { idempotencyKey: 'unregistered-key' }),
      ).rejects.toThrow(/No workflow registered/);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});

describe('engine.startOrSignal', () => {
  it('creates the workflow and delivers the signal when the target is absent', async () => {
    const engine = createEngine();
    try {
      const { handle } = await engine.startOrSignal(
        'wait-for-release',
        null,
        { name: 'release', payload: 'go', signalId: 'sig-create' },
        { id: 'sos-create' },
      );
      expect(handle.id).toBe('sos-create');
      expect(await handle.result()).toBe('go');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('signals an existing running workflow without starting a second run', async () => {
    const engine = createEngine();
    try {
      const started = await engine.start('wait-for-release', null, { id: 'sos-existing' });

      const { handle } = await engine.startOrSignal(
        'wait-for-release',
        null,
        { name: 'release', payload: 'late', signalId: 'sig-existing' },
        { id: 'sos-existing' },
      );
      expect(handle.id).toBe(started.id);
      expect(await started.result()).toBe('late');
      expect(await countWorkflowRecords(engine)).toBe(1);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('hands off to a successor when completion is already committing (#693)', async () => {
    const inner = new MemoryStorage();
    const completionBlocked = Promise.withResolvers<void>();
    const releaseCompletion = Promise.withResolvers<void>();
    const workflowId = 'sos-completion-handoff';
    const engine = createEngine(
      storageWithBlockedCompletionBatch(
        inner,
        workflowId,
        completionBlocked.resolve,
        releaseCompletion.promise,
      ),
    );
    const completedResults: unknown[] = [];
    engine.addEventListener(WorkflowCompletedEvent.type, (event) => {
      if (event.workflowId === workflowId) completedResults.push(event.result);
    });

    try {
      await engine.start('drains-and-completes', null, { id: workflowId });
      await completionBlocked.promise;

      const handoff = engine.startOrSignal(
        'drains-and-completes',
        null,
        { name: 'handoff', payload: 'delivered-after-drain', signalId: 'sig-handoff' },
        { id: workflowId, onTerminalConflict: 'start-new' },
      );

      await flushMicrotasks(10);
      releaseCompletion.resolve();

      const result = await handoff;
      expect(result.outcome).toBe('started');
      expect(result.handle.id).toBe(workflowId);
      expect(completedResults).toContain('completed-before-handoff');
      expect(await result.handle.result()).toBe('delivered-after-drain');
      expect(await countWorkflowRecords(engine)).toBe(1);
    } finally {
      releaseCompletion.resolve();
      await engine[Symbol.asyncDispose]();
    }
  });

  it('reports outcome "started" when it creates the workflow (#466)', async () => {
    const engine = createEngine();
    try {
      const { handle, outcome } = await engine.startOrSignal(
        'wait-for-release',
        null,
        { name: 'release', payload: 'go', signalId: 'sig-outcome-started' },
        { id: 'sos-outcome-started' },
      );
      expect(outcome).toBe('started');
      await handle.signal('release', 'go');
      await handle.result();
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('reports outcome "signalled" when it signals an existing run (#466)', async () => {
    const engine = createEngine();
    try {
      await engine.start('wait-for-release', null, { id: 'sos-outcome-signalled' });

      const { handle, outcome } = await engine.startOrSignal(
        'wait-for-release',
        null,
        { name: 'release', payload: 'late', signalId: 'sig-outcome-signalled' },
        { id: 'sos-outcome-signalled' },
      );
      expect(outcome).toBe('signalled');
      expect(await handle.result()).toBe('late');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('reports outcome "signalled" for the keyed race loser, "started" for the winner (#466)', async () => {
    const engine = createEngine();
    try {
      // Concurrent same-key callers converge on one run: exactly one creates it
      // ('started'); the rest lose the create race and signal it ('signalled').
      const results = await Promise.all([
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release', payload: 'a' },
          { idempotencyKey: 'sos-outcome-race' },
        ),
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release', payload: 'b' },
          { idempotencyKey: 'sos-outcome-race' },
        ),
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release', payload: 'c' },
          { idempotencyKey: 'sos-outcome-race' },
        ),
      ]);
      // All converge on one workflow id.
      expect(new Set(results.map((result) => result.handle.id)).size).toBe(1);
      expect(await countWorkflowRecords(engine)).toBe(1);
      // Exactly one 'started', the rest 'signalled' — each call reports its OWN
      // per-call outcome even though they converge on one run.
      const outcomes = results
        .map((result) => result.outcome)
        .toSorted((first, second) => (first < second ? -1 : first > second ? 1 : 0));
      expect(outcomes).toEqual(['signalled', 'signalled', 'started']);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('signals a suspended workflow, which delivers on resume (non-terminal target)', async () => {
    const engine = createEngine();
    try {
      const started = await engine.start('wait-for-release', null, { id: 'sos-suspended' });
      await engine.suspend('sos-suspended');

      await engine.startOrSignal(
        'wait-for-release',
        null,
        { name: 'release', payload: 'after-suspend', signalId: 'sig-suspended' },
        { id: 'sos-suspended' },
      );

      await engine.resume('sos-suspended');
      expect(await started.result()).toBe('after-suspend');
      expect(await countWorkflowRecords(engine)).toBe(1);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('throws StartOrSignalConflictError when the target is terminal', async () => {
    const engine = createEngine();
    try {
      const completed = await engine.start('completes-immediately', null, { id: 'sos-terminal' });
      expect(await completed.result()).toBe('done');

      await expect(
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release', payload: 'too-late', signalId: 'sig-terminal' },
          { id: 'sos-terminal' },
        ),
      ).rejects.toBeInstanceOf(StartOrSignalConflictError);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('restarts a completed prior run under the same id and delivers the initial signal', async () => {
    const engine = createEngine();
    try {
      const completed = await engine.start('completes-immediately', null, {
        id: 'sos-restart-completed',
      });
      expect(await completed.result()).toBe('done');
      const completedState = await engine.get(completed.id);
      const completedWorkflowExecutionToken = completedState?.workflowExecutionToken;
      if (completedWorkflowExecutionToken === undefined) throw new Error('Expected prior token');

      const { handle, outcome } = await engine.startOrSignal(
        'wait-for-release',
        null,
        { name: 'release', payload: 'after-completed', signalId: 'sig-restart-completed' },
        { id: 'sos-restart-completed', onTerminalConflict: 'start-new' },
      );

      expect(outcome).toBe('started');
      expect(handle.id).toBe('sos-restart-completed');
      expect(await handle.result()).toBe('after-completed');
      const restartedState = await engine.get(handle.id);
      const restartedCreatedAt = restartedState?.createdAt;
      if (restartedCreatedAt === undefined) throw new Error('Expected restarted state');
      expect(restartedState?.restartedFrom).toEqual({
        workflowId: completed.id,
        workflowExecutionToken: completedWorkflowExecutionToken,
        replacedAt: restartedCreatedAt,
      });
      expect(await countWorkflowRecords(engine)).toBe(1);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('restarts a failed prior run under the same id and delivers the initial signal', async () => {
    const engine = createEngine();
    try {
      const failed = await engine.start('throws-immediately', null, { id: 'sos-restart-failed' });
      await expect(failed.result()).rejects.toThrow('boom');

      const { handle, outcome } = await engine.startOrSignal(
        'wait-for-release',
        null,
        { name: 'release', payload: 'after-failed', signalId: 'sig-restart-failed' },
        { id: 'sos-restart-failed', onTerminalConflict: 'start-new' },
      );

      expect(outcome).toBe('started');
      expect(await handle.result()).toBe('after-failed');
      expect(await countWorkflowRecords(engine)).toBe(1);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('restarts a cancelled prior run under the same id and delivers the initial signal', async () => {
    const engine = createEngine();
    try {
      const cancelled = await engine.start('wait-for-release', null, {
        id: 'sos-restart-cancelled',
      });
      const settled = cancelled.result().then(
        () => 'resolved',
        () => 'rejected',
      );
      await engine.cancel('sos-restart-cancelled');
      expect(await settled).toBe('rejected');

      const { handle, outcome } = await engine.startOrSignal(
        'wait-for-release',
        null,
        { name: 'release', payload: 'after-cancelled', signalId: 'sig-restart-cancelled' },
        { id: 'sos-restart-cancelled', onTerminalConflict: 'start-new' },
      );

      expect(outcome).toBe('started');
      expect(await handle.result()).toBe('after-cancelled');
      expect(await countWorkflowRecords(engine)).toBe(1);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('restarts a timed-out prior run under the same id and delivers the initial signal', async () => {
    await using engine = new TestEngine();
    engine.register(waitForRelease);

    const timedOut = await engine.start('wait-for-release', null, {
      id: 'sos-restart-timed-out',
      executionTimeout: '1s',
    });
    const settled = timedOut.result().then(
      () => 'resolved',
      () => 'rejected',
    );
    await engine.advanceTime('2s');
    expect(await settled).toBe('rejected');

    const { handle, outcome } = await engine.startOrSignal(
      'wait-for-release',
      null,
      { name: 'release', payload: 'after-timeout', signalId: 'sig-restart-timed-out' },
      { id: 'sos-restart-timed-out', onTerminalConflict: 'start-new' },
    );

    expect(outcome).toBe('started');
    expect(await handle.result()).toBe('after-timeout');
    expect(await countWorkflowRecords(engine)).toBe(1);
  });

  it('signals an existing non-terminal run when restart policy is present', async () => {
    const engine = createEngine();
    try {
      const running = await engine.start('wait-for-release', 'original', {
        id: 'sos-restart-non-terminal',
      });

      const { handle, outcome } = await engine.startOrSignal(
        'completes-immediately',
        'ignored',
        { name: 'release', payload: 'still-running', signalId: 'sig-restart-non-terminal' },
        { id: 'sos-restart-non-terminal', onTerminalConflict: 'start-new' },
      );

      expect(outcome).toBe('signalled');
      expect(handle.id).toBe(running.id);
      expect(await running.result()).toBe('still-running');
      expect(await countWorkflowRecords(engine)).toBe(1);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('rejects idempotencyKey with restart-capable startOrSignal', async () => {
    const engine = createEngine();
    try {
      await expect(
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release' },
          { idempotencyKey: 'sos-restart-idempotency', onTerminalConflict: 'start-new' },
        ),
      ).rejects.toThrow(/mutually exclusive with options\.idempotencyKey/);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('rejects restart-capable startOrSignal without a deterministic signalId', async () => {
    const engine = createEngine();
    try {
      await expect(
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release' },
          { id: 'sos-restart-missing-signal', onTerminalConflict: 'start-new' },
        ),
      ).rejects.toThrow(/requires signal\.signalId/);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('converges concurrent restart-capable callers for the same terminal id', async () => {
    const engine = createEngine();
    try {
      const completed = await engine.start('completes-immediately', null, {
        id: 'sos-restart-concurrent',
      });
      expect(await completed.result()).toBe('done');

      const results = await Promise.all([
        engine.startOrSignal(
          'release-then-hold',
          null,
          { name: 'release', payload: 'go', signalId: 'sig-restart-concurrent' },
          { id: 'sos-restart-concurrent', onTerminalConflict: 'start-new' },
        ),
        engine.startOrSignal(
          'release-then-hold',
          null,
          { name: 'release', payload: 'go', signalId: 'sig-restart-concurrent' },
          { id: 'sos-restart-concurrent', onTerminalConflict: 'start-new' },
        ),
      ]);

      expect(new Set(results.map((result) => result.handle.id)).size).toBe(1);
      expect(await countWorkflowRecords(engine)).toBe(1);
      expect(
        results
          .map((result) => result.outcome)
          .toSorted((first, second) => (first < second ? -1 : first > second ? 1 : 0)),
      ).toEqual(['signalled', 'started']);

      let acceptedMarkers = 0;
      for await (const _entry of engine.storage.scan(`sigres:v1:`)) {
        acceptedMarkers += 1;
      }
      expect(acceptedMarkers).toBe(1);

      await results[0].handle.signal('hold', 'done');
      expect(await results[0].handle.result()).toBe('done');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('retries restart create when a lost caller-id reservation leaves the old terminal record', async () => {
    const engine = createEngine();
    try {
      const completed = await engine.start('completes-immediately', null, {
        id: 'sos-restart-stale-terminal',
      });
      expect(await completed.result()).toBe('done');

      await expect(
        resolveCallerIdWinnerOrRetry(
          getInternals(engine),
          'sos-restart-stale-terminal',
          {
            name: 'release',
            payload: 'after-aborted-winner',
            signalId: 'sig-restart-stale-terminal',
          },
          'sig-restart-stale-terminal',
          unexpectedStartOrSignalCallbacks(),
          true,
        ),
      ).resolves.toBeUndefined();
      expect(await engine.getHandle('sos-restart-stale-terminal').result()).toBe('done');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('conflicts immediately when a caller-id race resolves to an existing terminal run without restart permission', async () => {
    const engine = createEngine();
    try {
      const completed = await engine.start('completes-immediately', null, {
        id: 'sos-terminal-conflict',
      });
      expect(await completed.result()).toBe('done');

      await expect(
        resolveCallerIdWinnerOrRetry(
          getInternals(engine),
          'sos-terminal-conflict',
          {
            name: 'release',
            payload: 'after-terminal',
            signalId: 'sig-terminal-conflict',
          },
          'sig-terminal-conflict',
          unexpectedStartOrSignalCallbacks(),
        ),
      ).rejects.toBeInstanceOf(StartOrSignalConflictError);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('conflicts when a restart-capable caller-id race rereads a different terminal run after the reservation clears', async () => {
    const workflowId = 'sos-terminal-rerun';
    const inner = new MemoryStorage();
    const engine = createEngine(
      new Proxy(inner, {
        get(target, property, receiver) {
          if (property === 'get') {
            return async (key: string): Promise<Uint8Array | null> => {
              const value = await target.get(key);
              if (key === KEYS.workflow(workflowId) && shouldReturnRereadState && value !== null) {
                shouldReturnRereadState = false;
                return encode(rereadState);
              }
              return value;
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    );
    const pendingStarts = getInternals(engine).pendingStarts;
    let shouldReturnRereadState = false;
    let rereadState!: WorkflowState;
    const originalHas = pendingStarts.has.bind(pendingStarts);
    try {
      const completed = await engine.start('completes-immediately', null, {
        id: workflowId,
      });
      expect(await completed.result()).toBe('done');

      const previousState = await readStoredWorkflowState(engine, workflowId);
      rereadState = {
        ...previousState,
        updatedAt: previousState.updatedAt + 1,
        terminalCleanupToken: 'changed-terminal-cleanup-token',
      };
      pendingStarts.add(workflowId);
      pendingStarts.has = (id: string): boolean => {
        const present = originalHas(id);
        if (present && id === workflowId) {
          shouldReturnRereadState = true;
          pendingStarts.delete(workflowId);
        }
        return present;
      };

      await expect(
        resolveCallerIdWinnerOrRetry(
          getInternals(engine),
          workflowId,
          {
            name: 'release',
            payload: 'after-restart-loss',
            signalId: 'sig-terminal-rerun',
          },
          'sig-terminal-rerun',
          unexpectedStartOrSignalCallbacks(),
          true,
        ),
      ).rejects.toBeInstanceOf(StartOrSignalConflictError);
    } finally {
      pendingStarts.has = originalHas;
      pendingStarts.delete(workflowId);
      await engine[Symbol.asyncDispose]();
    }
  });

  it('requires a signalId or idempotencyKey for convergence', async () => {
    const engine = createEngine();
    try {
      await expect(
        engine.startOrSignal('wait-for-release', null, { name: 'release', payload: 'x' }, {}),
      ).rejects.toThrow(/signalId or options\.idempotencyKey/);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('rejects supplying both signalId and idempotencyKey', async () => {
    // They are mutually exclusive: the key-derived signal id is what makes
    // concurrent callers converge, so honoring a caller signalId alongside a key
    // would silently re-introduce double-delivery. Reject rather than pick one.
    const engine = createEngine();
    try {
      await expect(
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release', payload: 'x', signalId: 'explicit' },
          { idempotencyKey: 'also-a-key' },
        ),
      ).rejects.toThrow(/does not accept both/);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('converges concurrent idempotency-key callers (no caller signalId) to one signal', async () => {
    // Independent callers share ONLY the idempotency key — they pass no signalId
    // (the realistic webhook-retry case). Convergence relies on the key-derived
    // id: exactly one signal is delivered to one workflow even though two callers
    // raced, each with its own payload.
    const engine = createEngine();
    try {
      const [{ handle: a }, { handle: b }] = await Promise.all([
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release', payload: 'from-a' },
          { idempotencyKey: 'converge' },
        ),
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release', payload: 'from-b' },
          { idempotencyKey: 'converge' },
        ),
      ]);
      expect(b.id).toBe(a.id);
      expect(await countWorkflowRecords(engine)).toBe(1);

      // Exactly one signal landed: the workflow resolves to one of the two
      // payloads and there is no buffered second signal left in storage.
      const result = (await a.result()) as string;
      expect(['from-a', 'from-b']).toContain(result);

      let remainingSignals = 0;
      for await (const _entry of engine.storage.scan(
        `sig:${encodeStorageKeyComponent(a.id)}:${encodeStorageKeyComponent('release')}:`,
      )) {
        remainingSignals += 1;
      }
      expect(remainingSignals).toBe(0);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('converges concurrent absent-target callers to one workflow and one signal', async () => {
    const engine = createEngine();
    try {
      const [{ handle: a }, { handle: b }, { handle: c }] = await Promise.all([
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release', payload: 'go', signalId: 'same-id' },
          { id: 'sos-concurrent' },
        ),
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release', payload: 'go', signalId: 'same-id' },
          { id: 'sos-concurrent' },
        ),
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release', payload: 'go', signalId: 'same-id' },
          { id: 'sos-concurrent' },
        ),
      ]);
      expect(b.id).toBe(a.id);
      expect(c.id).toBe(a.id);
      expect(await countWorkflowRecords(engine)).toBe(1);
      expect(await a.result()).toBe('go');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('throws when the storage backend lacks conditionalBatch', async () => {
    const engine = createEngine(new CompressedStorage(new MemoryStorage()));
    try {
      await expect(
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release', payload: 'x', signalId: 'no-cas' },
          { id: 'sos-no-cas' },
        ),
      ).rejects.toThrow(/conditionalBatch/);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('persists a key→id mapping so startOrSignal can dedup by idempotency key', async () => {
    const engine = createEngine();
    try {
      const { handle: created } = await engine.startOrSignal(
        'wait-for-release',
        null,
        { name: 'release', payload: 'first' },
        { idempotencyKey: 'sos-key' },
      );
      const mapping = await engine.storage.get(KEYS.startIdempotency('sos-key'));
      expect(mapping).not.toBeNull();

      // A second startOrSignal with the same key resolves the mapping and
      // signals the existing run instead of creating a new one.
      const { handle: again } = await engine.startOrSignal(
        'wait-for-release',
        null,
        { name: 'release', payload: 'second' },
        { idempotencyKey: 'sos-key' },
      );
      expect(again.id).toBe(created.id);
      expect(await countWorkflowRecords(engine)).toBe(1);
      expect(await created.result()).toBe('first');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('does not deliver a second signal to a still-running run on a repeat same-key call', async () => {
    // The convergence guarantee for a non-terminal run rests on the `sigres:`
    // accepted-response marker outliving signal consumption: a repeat same-key
    // call derives the same `start-idem:` signalId, and bufferSignalPayloads
    // short-circuits on the existing marker rather than buffering a second signal.
    // Asserted at the storage level (not via the run's result) so the dedup
    // mechanism itself is pinned, independent of what the workflow observes.
    const engine = createEngine();
    try {
      // `release-then-hold` consumes the create-batch `release` then parks on
      // `hold` (never sent), so the run stays non-terminal across both calls.
      const { handle: created } = await engine.startOrSignal(
        'release-then-hold',
        null,
        { name: 'release', payload: 'first' },
        { idempotencyKey: 'sos-rerun-key' },
      );

      const acceptedResponseKey = KEYS.signalAcceptedResponse(
        created.id,
        'release',
        KEYS.startIdempotencySignalId('sos-rerun-key'),
      );
      expect(await engine.storage.get(acceptedResponseKey)).not.toBeNull();

      const { handle: again } = await engine.startOrSignal(
        'release-then-hold',
        null,
        { name: 'release', payload: 'second' },
        { idempotencyKey: 'sos-rerun-key' },
      );
      expect(again.id).toBe(created.id);

      // The dedup proof: exactly ONE accepted-response marker for this run's
      // `release` signal id. The repeat same-key call derived the same signal id,
      // saw the existing marker, and short-circuited — it did not accept and buffer
      // a second signal. (We cannot await the run's result to force consumption: it
      // is parked on `hold`, so we assert on the marker the dedup hinges on.)
      let acceptedMarkers = 0;
      for await (const _entry of engine.storage.scan(`sigres:v1:`)) {
        acceptedMarkers += 1;
      }
      expect(acceptedMarkers).toBe(1);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('signals a pending (delayed-start) workflow, delivering once the timer fires', async () => {
    const engine = new TestEngine({ startTime: 0 });
    engine.register(waitForRelease);
    try {
      // A delayed-start run sits in 'pending' until its timer fires — a
      // non-terminal target, so startOrSignal signals it (buffered durably).
      const started = await engine.start('wait-for-release', null, {
        id: 'sos-pending',
        startAfter: '10s',
      });
      const pending = await engine.get('sos-pending');
      expect(pending?.status).toBe('pending');

      await engine.startOrSignal(
        'wait-for-release',
        null,
        { name: 'release', payload: 'pre-launch', signalId: 'sig-pending' },
        { id: 'sos-pending' },
      );

      // Fire the delayed-start timer: the run launches and consumes the signal
      // that was buffered before it ever drove.
      await engine.advanceTime('11s');
      expect(await started.result()).toBe('pre-launch');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('rejects supplying both id and idempotencyKey', async () => {
    const engine = createEngine();
    try {
      await expect(
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release', payload: 'x' },
          { id: 'fixed', idempotencyKey: 'k' },
        ),
      ).rejects.toThrow(/mutually exclusive/);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('throws IdempotencyKeyPurgedError when the key maps to a purged workflow', async () => {
    const engine = createEngine();
    try {
      const { handle: created } = await engine.startOrSignal(
        'completes-immediately',
        null,
        { name: 'release', payload: 'x' },
        { idempotencyKey: 'sos-purge' },
      );
      await created.result();
      await engine.purge({ idPrefix: created.id });

      await expect(
        engine.startOrSignal(
          'completes-immediately',
          null,
          { name: 'release', payload: 'y' },
          { idempotencyKey: 'sos-purge' },
        ),
      ).rejects.toBeInstanceOf(IdempotencyKeyPurgedError);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('propagates an unregistered-type error from the create path (not swallowed as a race)', async () => {
    const engine = createEngine();
    try {
      // The absent-target branch attempts to create via the conditional batch; an
      // unregistered type throws WorkflowNotRegisteredError, which is neither a
      // mapping-CAS loss nor a caller-id collision, so it must surface unchanged.
      await expect(
        engine.startOrSignal(
          'not-registered',
          null,
          { name: 'release', signalId: 'sos-unregistered' },
          {},
        ),
      ).rejects.toThrow(/No workflow registered/);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('recovers a lost create CAS by resolving the winner and signalling it (white-box race path)', async () => {
    // White-box coverage for the create-batch CAS-loss recovery path. A real
    // concurrent race resolves the loser via the top-level mapping lookup, so the
    // CAS-loss branch (requireWinnerId → resolveWinnerWithSignal) never fires in
    // ordinary tests. Here we force it deterministically: caller A wins and stays
    // PARKED (release-then-hold consumes the create-batch `release`, then waits on
    // `hold`, which is never sent), so it is non-terminal when caller B resolves
    // it. Caller B's first read of the idempotency mapping is suppressed to null,
    // so B skips the early lookup, builds its own create batch, loses the CAS, and
    // recovers by signalling the parked winner.
    const inner = new MemoryStorage();
    const mappingKey = KEYS.startIdempotency('race-recover');
    const engine = new Engine({
      storage: storageWithOneShotNullGet(inner, (key) => key === mappingKey),
    });
    engine.register(releaseThenHold);
    try {
      const { handle: winner } = await engine.startOrSignal(
        'release-then-hold',
        null,
        { name: 'release', payload: 'from-a' },
        { idempotencyKey: 'race-recover' },
      );

      const { handle: loser } = await engine.startOrSignal(
        'release-then-hold',
        null,
        { name: 'release', payload: 'from-b' },
        { idempotencyKey: 'race-recover' },
      );

      // Both callers converge on the single parked run; no second workflow exists.
      expect(loser.id).toBe(winner.id);
      expect(await countWorkflowRecords(engine)).toBe(1);
      // The winner is intentionally parked on `hold` (never delivered); asyncDispose
      // tears it down. We do not await completion — the point is the convergence.
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('creates and delivers a pre-buffered signal on the caller-id path (no sentinel leak)', async () => {
    // Regression: a signal pre-buffered under the SAME signalId the caller-id
    // create batch would derive made the batch's signal CAS fail, surfacing the
    // internal StartIdempotencyRaceLostError sentinel to the caller — despite no
    // concurrency and no idempotency key. The fix recognizes the caller-id path
    // (whose only CAS condition is the signal's) and plain-creates the run; the
    // buffered signal is consumed on first drive, and the caller's payload loses
    // to the pre-buffered one by first-wins dedup.
    const engine = createEngine();
    try {
      // Pre-buffer a signal for an id whose workflow record does not exist yet.
      await engine.signal('sos-prebuffered', 'release', 'buffered', { signalId: 'shared-sig' });

      const { handle } = await engine.startOrSignal(
        'wait-for-release',
        null,
        { name: 'release', payload: 'from-caller', signalId: 'shared-sig' },
        { id: 'sos-prebuffered' },
      );

      expect(handle.id).toBe('sos-prebuffered');
      expect(await countWorkflowRecords(engine)).toBe(1);
      // First-wins: the pre-buffered payload is delivered, not the caller's.
      expect(await handle.result()).toBe('buffered');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('converges concurrent same-id callers when the signal is pre-buffered (no duplicate-id leak)', async () => {
    // Regression for the CONVERGENCE OUTCOME with a pre-buffered signal: two
    // concurrent same-id callers converge on one workflow, neither leaking a
    // WorkflowAlreadyExistsError (Promise.all would reject if either did). The
    // specific recovery LINE — the loser plain-creating, hitting
    // WorkflowAlreadyExistsError, and resolving the winner — fires only on a rare
    // mid-sequence interleaving that in-process storage produces by chance, not on
    // command; in practice the loser usually resolves via the top-level lookup.
    // That line is coverage-allowanced; this test pins the outcome it guards.
    //
    // `release-then-hold` parks on `hold` after consuming the pre-buffered
    // `release`, so the winner stays non-terminal while the loser resolves it —
    // making the loser deterministically receive the handle (not a terminal
    // StartOrSignalConflictError, which is the correct-but-racy outcome if the
    // winner had already completed).
    const engine = createEngine();
    try {
      await engine.signal('sos-concurrent-prebuffered', 'release', 'go', {
        signalId: 'shared-sig',
      });

      const [{ handle: a }, { handle: b }] = await Promise.all([
        engine.startOrSignal(
          'release-then-hold',
          null,
          { name: 'release', payload: 'from-a', signalId: 'shared-sig' },
          { id: 'sos-concurrent-prebuffered' },
        ),
        engine.startOrSignal(
          'release-then-hold',
          null,
          { name: 'release', payload: 'from-b', signalId: 'shared-sig' },
          { id: 'sos-concurrent-prebuffered' },
        ),
      ]);

      // Both callers converge on the single parked run; neither leaked a
      // WorkflowAlreadyExistsError (Promise.all would have rejected).
      expect(a.id).toBe('sos-concurrent-prebuffered');
      expect(b.id).toBe(a.id);
      expect(await countWorkflowRecords(engine)).toBe(1);

      // Signal dedup held: exactly one accepted-response marker. The loser's
      // resolveWinnerWithSignal short-circuits on the pre-buffered `sigres:`
      // (written atomically by the standalone engine.signal and surviving the
      // winner's first-drive consumption), so no second signal was accepted.
      let acceptedMarkers = 0;
      for await (const _entry of engine.storage.scan(`sigres:v1:`)) {
        acceptedMarkers += 1;
      }
      expect(acceptedMarkers).toBe(1);
      // The run is parked on `hold` (never delivered); asyncDispose tears it down.
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('throws IdempotencyKeyPurgedError when winner resolution exhausts on a purged keyed run (white-box)', async () => {
    // White-box coverage for the keyed-exhaustion branch in resolveWinnerWithSignal.
    // The retry loop reads the WINNER RECORD (not the mapping). On the keyed path,
    // if the record stays absent through every attempt because the run was purged —
    // while the mapping survives — exhaustion must disambiguate: a still-present
    // mapping means a spent key (IdempotencyKeyPurgedError), not the caller-id
    // "reserved but never committed" invariant. We force the CAS-loss recovery
    // branch deterministically: create + purge a keyed run (record gone, mapping
    // survives), suppress the top-level mapping lookup so the second startOrSignal
    // skips the early purged-throw, builds its own create+signal batch, loses the
    // still-present mapping CAS, and routes into resolveWinnerWithSignal — whose
    // record reads all return null (purged), driving it to the keyed-exhaustion
    // re-read.
    const inner = new MemoryStorage();
    const mappingKey = KEYS.startIdempotency('sos-cas-purged');
    const engine = new Engine({
      storage: storageWithOneShotNullGet(inner, (key) => key === mappingKey),
    });
    engine.register(completesImmediately);
    try {
      const { handle: created } = await engine.startOrSignal(
        'completes-immediately',
        null,
        { name: 'release', payload: 'x' },
        { idempotencyKey: 'sos-cas-purged' },
      );
      await created.result();
      await engine.purge({ idPrefix: created.id });

      await expect(
        engine.startOrSignal(
          'completes-immediately',
          null,
          { name: 'release', payload: 'y' },
          { idempotencyKey: 'sos-cas-purged' },
        ),
      ).rejects.toBeInstanceOf(IdempotencyKeyPurgedError);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('throws the invariant error when keyed winner resolution exhausts after the idempotency mapping changes', async () => {
    const engine = createEngine();
    try {
      await engine.storage.put(
        KEYS.startIdempotency('sos-remapped'),
        encode({ workflowId: 'other-winner' }),
      );

      await expect(
        resolveWinnerWithSignal(
          getInternals(engine),
          'missing-winner',
          { name: 'release', payload: 'x', signalId: 'sig-remapped' },
          'sig-remapped',
          unexpectedStartOrSignalCallbacks(),
          'sos-remapped',
        ),
      ).rejects.toThrow(/record never became readable after 5 attempts/);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('throws when the winner idempotency mapping vanishes after a lost compare-and-swap', async () => {
    const engine = createEngine();
    try {
      await expect(requireWinnerId(getInternals(engine), 'missing-key')).rejects.toThrow(
        /vanished after a lost compare-and-swap/,
      );
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('retries the create when a caller-id winner aborts before its durable commit', async () => {
    // Regression: a caller-id loser collides on the winner's in-memory
    // pendingStarts reservation BEFORE the winner's durable commit. If that winner
    // then aborts (storage failure, oversized payload, throwing start interceptor),
    // no run ever exists — the loser must retry its own create and win, not strand
    // waiting for a record that never appears. Deterministic via event ordering (no
    // sleeps): the winner parks mid-conditionalBatch with its reservation held; once
    // the loser has collided and entered winner-resolution, we release the winner so
    // it throws; the loser then re-reads (absent), retries create, and succeeds.
    const winnerParked = Promise.withResolvers<void>();
    const releaseWinner = Promise.withResolvers<void>();
    const loserCollided = Promise.withResolvers<void>();
    const inner = new MemoryStorage();
    const engine = new Engine({
      storage: storageWithAbortingFirstConditionalBatch(
        inner,
        () => winnerParked.resolve(),
        releaseWinner.promise,
      ),
    });
    engine.register(waitForRelease);

    // Fire `loserCollided` when the loser's start observes the winner's held
    // reservation (has() returns true for this id). The winner's own pre-reserve
    // check returns false, so only the loser's collision trips it.
    const pendingStarts = getInternals(engine).pendingStarts;
    const originalHas = pendingStarts.has.bind(pendingStarts);
    pendingStarts.has = (id: string): boolean => {
      const present = originalHas(id);
      if (present && id === 'sos-abort') {
        loserCollided.resolve();
      }
      return present;
    };

    try {
      const winnerPromise = engine.startOrSignal(
        'wait-for-release',
        null,
        { name: 'release', payload: 'winner', signalId: 'sig-abort' },
        { id: 'sos-abort' },
      );
      await winnerParked.promise; // winner parked mid-commit; reservation held

      const loserPromise = engine.startOrSignal(
        'wait-for-release',
        null,
        { name: 'release', payload: 'loser', signalId: 'sig-abort' },
        { id: 'sos-abort' },
      );
      await loserCollided.promise; // loser hit the held reservation → lost-caller-id

      releaseWinner.resolve(); // winner throws → aborts → finally clears the reservation

      // The winner's start rejects with the injected abort; the loser recovers by
      // retrying its own create (the wrapper lets the second conditionalBatch
      // through) and resolves to a real run.
      await expect(winnerPromise).rejects.toThrow(/injected winner abort/);
      const { handle: loser } = await loserPromise;
      expect(loser.id).toBe('sos-abort');
      expect(await countWorkflowRecords(engine)).toBe(1);
      // Drive the loser's queued inline start in-band instead of waiting on its
      // background flush macrotask. The freshly-created run consumes its
      // create-batch `release` signal on first drive (scan-then-park) and reaches
      // terminal synchronously here, so `result()` resolves on engine state rather
      // than on macrotask scheduling — which a heavily loaded test runner can
      // starve past the test timeout (the macrotask-starvation footgun the dispose
      // drain also guards against). Without this the assertion is real-time-budget
      // dependent under parallel-suite Worker contention rather than deterministic.
      await drainQueuedInlineWorkflowStartsForEngine(engine);
      expect(await loser.result()).toBe('loser');
    } finally {
      pendingStarts.has = originalHas;
      await engine[Symbol.asyncDispose]();
    }
  });

  it('throws after the create-attempt cap when every caller-id winner keeps aborting', async () => {
    // White-box coverage for the CALLER_ID_CREATE_MAX_ATTEMPTS exhaustion throw: if
    // every create attempt collides with a reservation that never clears into a
    // committed record, the loser must surface a bounded error rather than loop
    // forever. Hold a permanent reservation for the target id so every retry
    // re-collides and the reservation never clears.
    const engine = createEngine();
    getInternals(engine).pendingStarts.add('sos-cap');
    try {
      await expect(
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release', payload: 'x', signalId: 'sig-cap' },
          { id: 'sos-cap' },
        ),
      ).rejects.toThrow(/after 5 attempts/);
    } finally {
      getInternals(engine).pendingStarts.delete('sos-cap');
      await engine[Symbol.asyncDispose]();
    }
  });

  it('resolves the committed caller-id winner when buffered-signal plain create collides', async () => {
    const engine = createEngine();
    const pendingStarts = getInternals(engine).pendingStarts;
    const originalHas = pendingStarts.has.bind(pendingStarts);
    let competingStartPromise: Promise<ReturnType<Engine['getHandle']>> | undefined;
    let isStartingCompetingWorkflow = false;

    pendingStarts.has = ((workflowId: string) => {
      const isPendingStart = originalHas(workflowId);
      if (
        workflowId === 'buffered-collision' &&
        !isPendingStart &&
        competingStartPromise === undefined &&
        !isStartingCompetingWorkflow
      ) {
        isStartingCompetingWorkflow = true;
        competingStartPromise = engine
          .start('release-then-hold', null, { id: workflowId })
          .finally(() => {
            isStartingCompetingWorkflow = false;
          });
      }
      return isPendingStart;
    }) as typeof pendingStarts.has;

    try {
      await engine.signal('buffered-collision', 'release', 'winner', { signalId: 'sig-buffered' });

      const { handle } = await engine.startOrSignal(
        'release-then-hold',
        null,
        { name: 'release', payload: 'loser', signalId: 'sig-buffered' },
        { id: 'buffered-collision' },
      );

      const competingHandle = await competingStartPromise;
      expect(competingHandle).toBeDefined();
      expect(handle.id).toBe('buffered-collision');
      expect(competingHandle!.id).toBe(handle.id);

      await engine.signal(handle.id, 'hold', 'done');
      expect(await handle.result()).toBe('done');
    } finally {
      pendingStarts.has = originalHas;
      await engine[Symbol.asyncDispose]();
    }
  });

  it('rethrows non-collision errors from the buffered-signal plain create path', async () => {
    const storage = storageWithInjectedBatchFailure(new MemoryStorage());
    const engine = createEngine(storage);

    try {
      await engine.signal('buffered-batch-failure', 'release', 'winner', { signalId: 'sig-batch' });
      storage.failNextBatch();

      await expect(
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release', payload: 'loser', signalId: 'sig-batch' },
          { id: 'buffered-batch-failure' },
        ),
      ).rejects.toThrow('injected plain create batch failure');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});

describe('startOrSignal start-signal FIFO ordering (#458)', () => {
  it('consumes the start-signal before later same-tick signals', async () => {
    // Regression for #458: a startOrSignal start-signal must be consumed before
    // signals delivered later in the same event-loop tick (before the workflow
    // reaches its first park). Previously the start-signal's storage key sorted
    // AFTER same-name anonymous keys, so a scan-first consume took the later
    // signals first; if one carried `stop`, the workflow returned before ever
    // consuming the start payload — silent data loss.
    //
    // The terminator is decoupled from the same-tick pair: `b` and `c` are both
    // un-awaited anonymous signals whose relative order is best-effort, so the
    // `stop` is sent separately afterward (anonymously, so it draws the highest
    // sequence and is consumed last). The invariant under test is "start-signal
    // first", not the b-vs-c order.
    const engine = createEngine();
    try {
      const id = 'fifo-start';
      const { handle } = await engine.startOrSignal(
        'collect-events',
        null,
        { name: 'ev', payload: { t: 'a' }, signalId: 's-a' },
        { id },
      );
      // Two more signals in the same tick (no awaits between sends).
      await Promise.all([engine.signal(id, 'ev', { t: 'b' }), engine.signal(id, 'ev', { t: 'c' })]);
      await engine.signal(id, 'ev', { t: 'stop', stop: true });

      const result = (await handle.result()) as { events: string[] };
      expect(result.events[0]).toBe('a');
      expect(result.events.at(-1)).toBe('stop');
      expect(result.events.slice(1, -1).toSorted()).toEqual(['b', 'c']);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('orders the start-signal first even when the explicit signalId sorts low', async () => {
    // The start payload must win regardless of how its signalId sorts against the
    // anonymous-id namespace. `0-...` sorts lexically before `anonymous%3A...`, so
    // a fix that merely relied on explicit ids sorting after anonymous ones would
    // regress here; the sort-class component guarantees the start-signal first.
    const engine = createEngine();
    try {
      const id = 'fifo-start-low-id';
      const { handle } = await engine.startOrSignal(
        'collect-events',
        null,
        { name: 'ev', payload: { t: 'a' }, signalId: '0-start' },
        { id },
      );
      await Promise.all([engine.signal(id, 'ev', { t: 'b' }), engine.signal(id, 'ev', { t: 'c' })]);
      await engine.signal(id, 'ev', { t: 'stop', stop: true });

      const result = (await handle.result()) as { events: string[] };
      expect(result.events[0]).toBe('a');
      expect(result.events.slice(1).toSorted()).toEqual(['b', 'c', 'stop']);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('dedups a pre-buffered signal against a startOrSignal create on the same signalId', async () => {
    // The dedup identity is the `sigres:` accepted-response marker (keyed by
    // signalId alone), NOT the `sig:` payload key. The FIFO sort-class makes the
    // start-signal's `sig:` key (class `0`) differ from the live path's (class
    // `1`), so a `sig:`-keyed create CAS would NOT collide with a pre-buffered
    // signal and the create batch would write a SECOND copy — the exact double-
    // delivery the marker exists to prevent. Both write paths gate on `sigres:`.
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    try {
      const id = 'prebuffer-create-dedup';
      // Buffer a signal for a not-yet-existent run (class `1`, plus its `sigres:`).
      await engine.signal(id, 'ev', { t: 'x' }, { signalId: 'dup' });

      // startOrSignal sees no record → create path. Its start-signal shares the
      // signalId `dup`; the create-batch CAS must collide on the pre-buffered
      // `sigres:` and create the run WITHOUT folding a second `ev` signal in.
      await engine.startOrSignal(
        'collect-events',
        null,
        { name: 'ev', payload: { t: 'y' }, signalId: 'dup' },
        { id },
      );

      // Exactly one `ev` payload may be buffered for signalId `dup`.
      const buffered: string[] = [];
      for await (const [key] of storage.scan(`sig:${encodeStorageKeyComponent(id)}:ev:`)) {
        buffered.push(key);
      }
      expect(buffered).toHaveLength(1);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('dedups a live signal whose accepted-response read races a startOrSignal commit (TOCTOU)', async () => {
    // The live signal path reads `sigres:` once, then CASes. A startOrSignal that
    // creates the run+start-signal can commit in that read→CAS gap. Because the
    // start-signal's `sig:` key is class `0` and the live path's is class `1`, a
    // `sig:`-keyed CAS would still pass (the keys differ) and buffer a second copy.
    // Gating the live CAS on the class-independent `sigres:` marker closes the gap:
    // the start batch's `sigres:` makes the live CAS fail, so it deduplicates.
    const id = 'toctou-live-vs-create';
    const inner = new MemoryStorage();
    const acceptedResponseKey = KEYS.signalAcceptedResponse(id, 'ev', 'dup');

    let injected = false;
    let runCreateInGap: (() => Promise<unknown>) | undefined;

    const storage = new Proxy(inner, {
      get(target, property, receiver) {
        if (property === 'get') {
          return async (key: string): Promise<Uint8Array | null> => {
            const value = await target.get(key);
            // The live path's pre-CAS read of the accepted-response marker: commit
            // the competing startOrSignal create here, in the read→CAS gap.
            if (!injected && key === acceptedResponseKey && runCreateInGap !== undefined) {
              injected = true;
              await runCreateInGap();
            }
            return value;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const engine = createEngine(storage);
    runCreateInGap = () =>
      engine.startOrSignal(
        'collect-events',
        null,
        { name: 'ev', payload: { t: 'created' }, signalId: 'dup' },
        { id },
      );

    try {
      // The live signal sees no run yet (buffer-before-start); its accepted-response
      // read fires the injected create, then its CAS must lose to the start batch.
      await engine.signal(id, 'ev', { t: 'live' }, { signalId: 'dup' });

      const buffered: string[] = [];
      for await (const [key] of inner.scan(`sig:${encodeStorageKeyComponent(id)}:ev:`)) {
        buffered.push(key);
      }
      expect(buffered).toHaveLength(1);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});
