import { describe, expect, it } from 'bun:test';

import { KEYS, type BatchOperation, type Storage as WeftStorage } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
import { decode, encode } from './codec.ts';
import { Engine } from './engine.ts';
import { normalizeHistoryPolicy } from './engine/validation.ts';
import { WorkflowTimedOutEvent } from './events.ts';
import { WorkflowTimeoutError } from './timeouts.ts';
import type { WorkflowContext, WorkflowState } from './types.ts';
import { HISTORY_CIRCUIT_BREAKER_REASON, workflow } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await sleepForTesting(10);
}

const noop = async () => null;

class TimedOutTransitionFailingStorage implements WeftStorage {
  failTimedOutTransition = false;

  constructor(readonly underlying = new MemoryStorage()) {}

  capabilities(): ReturnType<MemoryStorage['capabilities']> {
    return this.underlying.capabilities();
  }

  get(key: string): Promise<Uint8Array | null> {
    return this.underlying.get(key);
  }

  put(key: string, value: Uint8Array): Promise<void> {
    return this.underlying.put(key, value);
  }

  delete(key: string): Promise<void> {
    return this.underlying.delete(key);
  }

  scan(prefix: string, options?: Parameters<MemoryStorage['scan']>[1]) {
    return this.underlying.scan(prefix, options);
  }

  conditionalBatch(
    conditions: Parameters<NonNullable<MemoryStorage['conditionalBatch']>>[0],
    operations: Parameters<NonNullable<MemoryStorage['conditionalBatch']>>[1],
  ): Promise<boolean> {
    return this.underlying.conditionalBatch(conditions, operations);
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    const transitionsToTimedOut = operations.some((operation) => {
      if (operation.type !== 'put' || !/^wf:[^:]+$/.test(operation.key)) return false;
      const decoded = decode(operation.value) as WorkflowState;
      return decoded.status === 'timed-out';
    });
    if (this.failTimedOutTransition && transitionsToTimedOut) {
      throw new Error('state write failed during circuit-breaker termination');
    }
    return this.underlying.batch(operations);
  }

  [Symbol.dispose](): void {
    this.underlying[Symbol.dispose]();
  }
}

/** Suppress unhandled rejection from a handle's result promise. */
function suppressResult(handle: { result(): Promise<unknown> }): void {
  handle.result().catch(() => {});
}

/**
 * Register a workflow that yields `steps` activity calls — exactly one event-log
 * record per yield — then returns. Each yield drives one `commitCheckpoint`,
 * appending one `workflow:checkpoint` event.
 */
function registerCountingWorkflow(engine: Engine, steps: number): void {
  const counting = workflow({ name: 'counting' }).execute(async function* (ctx: WorkflowContext) {
    for (let index = 0; index < steps; index++) {
      yield* ctx.run(noop);
    }
    return 'done';
  });
  engine.register(counting);
}

/** Decode the persisted workflow state, or fail loudly if absent. */
async function loadState(engine: Engine, workflowId: string): Promise<WorkflowState> {
  const bytes = await engine.storage.get(KEYS.workflow(workflowId));
  expect(bytes).not.toBeNull();
  return decode(bytes!) as WorkflowState;
}

/** Count raw checkpoint-history entries in storage for a workflow. */
async function countCheckpointHistory(storage: MemoryStorage, workflowId: string): Promise<number> {
  let count = 0;
  for await (const [key] of storage.scan(`wf:${workflowId}:ckpt:`)) {
    void key;
    count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// One yield == one event-log record (foundation for the count assertions)
// ---------------------------------------------------------------------------

describe('history circuit breaker — event-log accounting', () => {
  it('appends exactly one event-log record per yield', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    registerCountingWorkflow(engine, 3);

    const handle = await engine.start('counting', null);
    await handle.result();
    await flush();

    const events = await engine.getEvents(handle.id);
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.type === 'workflow:checkpoint')).toBe(true);

    engine[Symbol.dispose]();
  });
});

// ---------------------------------------------------------------------------
// Write-path enforcement
// ---------------------------------------------------------------------------

describe('history circuit breaker — write path', () => {
  it('forces timed-out with the circuit-breaker reason when maxEvents is exceeded', async () => {
    const events: WorkflowTimedOutEvent[] = [];
    const engine = new Engine({ storage: new MemoryStorage(), history: { maxEvents: 3 } });
    engine.addEventListener(WorkflowTimedOutEvent.type, ((event: WorkflowTimedOutEvent) => {
      events.push(event);
    }) as EventListener);
    registerCountingWorkflow(engine, 10);

    const handle = await engine.start('counting', null);
    suppressResult(handle);
    await flush();

    const state = await loadState(engine, handle.id);
    expect(state.status).toBe('timed-out');
    expect(state.terminationReason).toBe(HISTORY_CIRCUIT_BREAKER_REASON);

    // Exactly maxEvents + 1 durable records: the breaching checkpoint event is
    // committed before termination; termination itself appends no event.
    const stored = await engine.getEvents(handle.id);
    expect(stored).toHaveLength(4);
    expect(stored.every((event) => event.type === 'workflow:checkpoint')).toBe(true);

    expect(events).toHaveLength(1);
    expect(events[0]!.workflowId).toBe(handle.id);
    expect(events[0]!.reason).toBe(HISTORY_CIRCUIT_BREAKER_REASON);

    const liveError = await handle.result().then(
      () => null,
      (error: unknown) => error,
    );
    expect(liveError).toBeInstanceOf(WorkflowTimeoutError);
    // The rejection itself carries the termination reason, so a caller can
    // classify circuit-breaker vs deadline without a second engine.get() read.
    expect((liveError as WorkflowTimeoutError).terminationReason).toBe(
      HISTORY_CIRCUIT_BREAKER_REASON,
    );

    engine[Symbol.dispose]();
  });

  it('exposes the circuit-breaker reason on a late result() reading persisted state', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, history: { maxEvents: 3 } });
    registerCountingWorkflow(engine, 10);

    const handle = await engine.start('counting', null);
    suppressResult(handle);
    await flush();

    const state = await loadState(engine, handle.id);
    expect(state.status).toBe('timed-out');
    expect(state.terminationReason).toBe(HISTORY_CIRCUIT_BREAKER_REASON);

    engine[Symbol.dispose]();

    // A second engine over the same storage has no in-memory result resolver, so
    // getHandle().result() bootstraps from the already-terminal persisted state
    // via loadWorkflowResult. That path must thread state.terminationReason onto
    // the rejection so a late caller can still classify it without engine.get().
    const reader = new Engine({ storage, history: { maxEvents: 3 } });
    const lateError = await reader
      .getHandle(handle.id)
      .result()
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(lateError).toBeInstanceOf(WorkflowTimeoutError);
    expect((lateError as WorkflowTimeoutError).terminationReason).toBe(
      HISTORY_CIRCUIT_BREAKER_REASON,
    );

    reader[Symbol.dispose]();
  });

  it('commits no checkpoint beyond the breaching one (hard bound, no overshoot)', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, history: { maxEvents: 2 } });
    registerCountingWorkflow(engine, 50);

    const handle = await engine.start('counting', null);
    suppressResult(handle);
    await flush();

    // maxEvents=2 allowed, the 3rd checkpoint breaches -> 3 checkpoint-history
    // entries total, and no more even though the workflow asked for 50.
    expect(await countCheckpointHistory(storage, handle.id)).toBe(3);

    engine[Symbol.dispose]();
  });

  it('allows exactly maxEvents records and completes normally at the boundary', async () => {
    const engine = new Engine({ storage: new MemoryStorage(), history: { maxEvents: 3 } });
    registerCountingWorkflow(engine, 3);

    const handle = await engine.start('counting', null);
    const result = await handle.result();
    await flush();

    expect(result).toBe('done');
    const state = await loadState(engine, handle.id);
    expect(state.status).toBe('completed');
    expect(state.terminationReason).toBeUndefined();

    engine[Symbol.dispose]();
  });

  it('does nothing when the workflow stays under the limit', async () => {
    const events: WorkflowTimedOutEvent[] = [];
    const engine = new Engine({ storage: new MemoryStorage(), history: { maxEvents: 100 } });
    engine.addEventListener(WorkflowTimedOutEvent.type, ((event: WorkflowTimedOutEvent) => {
      events.push(event);
    }) as EventListener);
    registerCountingWorkflow(engine, 5);

    const handle = await engine.start('counting', null);
    const result = await handle.result();
    await flush();

    expect(result).toBe('done');
    const state = await loadState(engine, handle.id);
    expect(state.status).toBe('completed');
    expect(state.terminationReason).toBeUndefined();
    expect(events).toHaveLength(0);

    engine[Symbol.dispose]();
  });

  it('is disabled when no history policy is configured', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    registerCountingWorkflow(engine, 20);

    const handle = await engine.start('counting', null);
    const result = await handle.result();
    await flush();

    expect(result).toBe('done');
    const state = await loadState(engine, handle.id);
    expect(state.status).toBe('completed');

    engine[Symbol.dispose]();
  });

  it('treats maxEvents: 0 as disabled', async () => {
    const engine = new Engine({ storage: new MemoryStorage(), history: { maxEvents: 0 } });
    registerCountingWorkflow(engine, 20);

    const handle = await engine.start('counting', null);
    const result = await handle.result();
    await flush();

    expect(result).toBe('done');
    const disabledState = await loadState(engine, handle.id);
    expect(disabledState.status).toBe('completed');

    engine[Symbol.dispose]();
  });

  it('terminates when the breaching record is the final yield', async () => {
    const engine = new Engine({ storage: new MemoryStorage(), history: { maxEvents: 2 } });
    // Yields exactly 3: the 3rd is the breaching record and also the last step.
    registerCountingWorkflow(engine, 3);

    const handle = await engine.start('counting', null);
    suppressResult(handle);
    await flush();

    const state = await loadState(engine, handle.id);
    expect(state.status).toBe('timed-out');
    expect(state.terminationReason).toBe(HISTORY_CIRCUIT_BREAKER_REASON);

    engine[Symbol.dispose]();
  });
});

// ---------------------------------------------------------------------------
// Enforcement failure surfaces, then the pre-replay guard retries
// ---------------------------------------------------------------------------

describe('history circuit breaker — enforcement failure', () => {
  it('leaves the workflow running (no silent overshoot) and the guard terminates it on resume', async () => {
    // When the write-path circuit-breaker termination throws, the activation
    // turn unwinds and the engine's strategy turn-tracker swallows the
    // rejection — so the throw is NOT surfaced to the caller; the workflow is
    // simply left `running` with its (durable) oversized history. The durable
    // guarantee is the pre-replay guard: the next resume re-attempts and
    // succeeds. Both halves are asserted below.
    {
      // Proxy storage that fails only the batch that transitions a workflow to
      // `timed-out` — i.e. the circuit-breaker termination's state write. The
      // breaching checkpoint batch and the initial start batch both commit; only
      // termination fails, so we exercise the post-failure invariant precisely.
      const storage = new TimedOutTransitionFailingStorage();

      const engine = new Engine({ storage, history: { maxEvents: 2 } });
      registerCountingWorkflow(engine, 10);

      storage.failTimedOutTransition = true;
      const handle = await engine.start('counting', null);
      suppressResult(handle);
      await flush();

      // Termination threw after the breaching checkpoint committed; the throw
      // unwinds the activation turn. The workflow is left running — NOT silently
      // continued past the limit (no 4th checkpoint), and not falsely terminated.
      const state = await loadState(engine, handle.id);
      expect(state.status).toBe('running');
      expect(state.terminationReason).toBeUndefined();
      expect(await countCheckpointHistory(storage.underlying, handle.id)).toBe(3);
      engine[Symbol.dispose]();

      // On the next resume, the pre-replay guard fires and termination now
      // succeeds — durability comes from the guard, not the thrown error.
      storage.failTimedOutTransition = false;
      const recoverEngine = new Engine({ storage, history: { maxEvents: 2 } });
      registerCountingWorkflow(recoverEngine, 10);
      const resumed = await recoverEngine.resume(handle.id);
      suppressResult(resumed);
      await flush();

      const recovered = await loadState(recoverEngine, handle.id);
      expect(recovered.status).toBe('timed-out');
      expect(recovered.terminationReason).toBe(HISTORY_CIRCUIT_BREAKER_REASON);

      recoverEngine[Symbol.dispose]();
    }
  });
});

// ---------------------------------------------------------------------------
// Distinct from a real deadline timeout
// ---------------------------------------------------------------------------

describe('history circuit breaker — distinct from deadline timeout', () => {
  it('a genuine execution timeout carries no termination reason', async () => {
    const events: WorkflowTimedOutEvent[] = [];
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    engine.addEventListener(WorkflowTimedOutEvent.type, ((event: WorkflowTimedOutEvent) => {
      events.push(event);
    }) as EventListener);

    const waiter = workflow({ name: 'waiter' }).execute(async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('never');
      return 'never';
    });
    engine.register(waiter);

    const handle = await engine.start('waiter', null, { executionTimeout: 5 });
    suppressResult(handle);
    // Drive the deadline timer past the timeout.
    await engine.timeout(handle.id);
    await flush();

    const state = await loadState(engine, handle.id);
    expect(state.status).toBe('timed-out');
    expect(state.terminationReason).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBeUndefined();

    engine[Symbol.dispose]();
  });
});

// ---------------------------------------------------------------------------
// Pre-replay guard (covers direct resume AND recoverAll, which routes through it)
// ---------------------------------------------------------------------------

describe('history circuit breaker — pre-replay guard', () => {
  /**
   * Seed a `running` workflow with an oversized event-log head using a first
   * engine that has the breaker disabled, leaving it blocked on a signal so it
   * persists as `running`. Returns the shared storage and the workflow id.
   */
  async function seedOversizedRunningWorkflow(
    storage: MemoryStorage,
    events: number,
  ): Promise<string> {
    const seeder = new Engine({ storage });
    const blocking = workflow({ name: 'counting' }).execute(async function* (ctx: WorkflowContext) {
      for (let index = 0; index < events; index++) {
        yield* ctx.run(noop);
      }
      yield* ctx.waitForSignal('never');
      return 'done';
    });
    seeder.register(blocking);

    const handle = await seeder.start('counting', null);
    await flush();
    const state = await loadState(seeder, handle.id);
    expect(state.status).toBe('running');
    // Dispose without terminating the workflow — storage retains the running
    // state and the oversized head for the recovering engine to find.
    seeder[Symbol.dispose]();
    return handle.id;
  }

  it('terminates without replaying via resume()', async () => {
    const storage = new MemoryStorage();
    const workflowId = await seedOversizedRunningWorkflow(storage, 5);

    let bodyRan = false;
    const recoverEngine = new Engine({ storage, history: { maxEvents: 2 } });
    const observed = workflow({ name: 'counting' }).execute(async function* (ctx: WorkflowContext) {
      bodyRan = true;
      yield* ctx.run(noop);
      return 'done';
    });
    recoverEngine.register(observed);

    const events: WorkflowTimedOutEvent[] = [];
    recoverEngine.addEventListener(WorkflowTimedOutEvent.type, ((event: WorkflowTimedOutEvent) => {
      events.push(event);
    }) as EventListener);

    const eventsBeforeResume = await recoverEngine.getEvents(workflowId);
    const eventsBefore = eventsBeforeResume.length;
    const handle = await recoverEngine.resume(workflowId);
    suppressResult(handle);
    await flush();

    const state = await loadState(recoverEngine, workflowId);
    expect(state.status).toBe('timed-out');
    expect(state.terminationReason).toBe(HISTORY_CIRCUIT_BREAKER_REASON);
    expect(bodyRan).toBe(false);
    // The pre-replay guard still dispatches the terminal event for observability.
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe(HISTORY_CIRCUIT_BREAKER_REASON);
    // No new event-log records appended — the history was not replayed/extended.
    const eventsAfter = await recoverEngine.getEvents(workflowId);
    expect(eventsAfter.length).toBe(eventsBefore);

    recoverEngine[Symbol.dispose]();
  });

  it('terminates without replaying via recoverAll() (routes through resume)', async () => {
    const storage = new MemoryStorage();
    const workflowId = await seedOversizedRunningWorkflow(storage, 5);

    const recoverEngine = new Engine({ storage, history: { maxEvents: 2 } });
    registerCountingWorkflow(recoverEngine, 1);

    const handles = await recoverEngine.recoverAll();
    handles.forEach(suppressResult);
    await flush();

    const state = await loadState(recoverEngine, workflowId);
    expect(state.status).toBe('timed-out');
    expect(state.terminationReason).toBe(HISTORY_CIRCUIT_BREAKER_REASON);

    recoverEngine[Symbol.dispose]();
  });

  it('resumes normally when the persisted history is under the limit', async () => {
    const storage = new MemoryStorage();
    const workflowId = await seedOversizedRunningWorkflow(storage, 2);

    // Register the same blocking body so replay re-blocks on the signal rather
    // than completing — isolating the guard as the only thing that could
    // terminate it.
    const recoverEngine = new Engine({ storage, history: { maxEvents: 100 } });
    const blocking = workflow({ name: 'counting' }).execute(async function* (ctx: WorkflowContext) {
      for (let index = 0; index < 2; index++) {
        yield* ctx.run(noop);
      }
      yield* ctx.waitForSignal('never');
      return 'done';
    });
    recoverEngine.register(blocking);

    const handle = await recoverEngine.resume(workflowId);
    suppressResult(handle);
    await flush();

    // Still running (blocked on the signal); the guard did not fire.
    const underLimitState = await loadState(recoverEngine, workflowId);
    expect(underLimitState.status).toBe('running');

    await recoverEngine.cancel(workflowId);
    recoverEngine[Symbol.dispose]();
  });

  it('enforces the breaker on resume() even when the workflow is locally owned (guard runs before the ownership short-circuit)', async () => {
    // Reproduces the bug where resume() returned early via the local-ownership
    // path before reaching resumeWorkflowFromStorage, skipping the guard. Here
    // the breaching workflow is left `running` on the SAME engine instance
    // (write-path termination is made to fail), then resume() is called — the
    // ownership check would otherwise short-circuit, but the pre-replay guard
    // must still fire.
    const storage = new TimedOutTransitionFailingStorage();

    const engine = new Engine({ storage, history: { maxEvents: 2 } });
    registerCountingWorkflow(engine, 10);
    storage.failTimedOutTransition = true;
    const handle = await engine.start('counting', null);
    suppressResult(handle);
    await flush();
    // Write-path termination failed → still running with an oversized head, and
    // the engine instance now locally owns the (inline) workflow.
    const stuck = await loadState(engine, handle.id);
    expect(stuck.status).toBe('running');

    // Resume on the SAME engine. Allow the timed-out transition to succeed now.
    storage.failTimedOutTransition = false;
    const resumed = await engine.resume(handle.id);
    suppressResult(resumed);
    await flush();

    const recovered = await loadState(engine, handle.id);
    expect(recovered.status).toBe('timed-out');
    expect(recovered.terminationReason).toBe(HISTORY_CIRCUIT_BREAKER_REASON);

    engine[Symbol.dispose]();
  });
});

// ---------------------------------------------------------------------------
// Synthesized terminal event carries the reason (late-attaching consumers)
// ---------------------------------------------------------------------------

describe('history circuit breaker — synthesized terminal event', () => {
  it('replays the circuit-breaker reason to a consumer that attaches after termination', async () => {
    const engine = new Engine({ storage: new MemoryStorage(), history: { maxEvents: 2 } });
    registerCountingWorkflow(engine, 10);

    const handle = await engine.start('counting', null);
    suppressResult(handle);
    await flush();
    const terminal = await loadState(engine, handle.id);
    expect(terminal.status).toBe('timed-out');

    // Attach a fresh handle AFTER termination; its async iterator synthesizes
    // the terminal event from persisted state. It must carry the persisted
    // terminationReason, matching the live dispatch.
    const lateHandle = engine.getHandle(handle.id);
    let synthesized: WorkflowTimedOutEvent | undefined;
    for await (const event of lateHandle) {
      if (event instanceof WorkflowTimedOutEvent) {
        synthesized = event;
        break;
      }
    }
    expect(synthesized).toBeDefined();
    expect(synthesized!.reason).toBe(HISTORY_CIRCUIT_BREAKER_REASON);

    engine[Symbol.dispose]();
  });

  it('a deadline-timeout synthesized event carries no reason', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const waiter = workflow({ name: 'waiter' }).execute(async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('never');
      return 'never';
    });
    engine.register(waiter);

    const handle = await engine.start('waiter', null, { executionTimeout: 5 });
    suppressResult(handle);
    await engine.timeout(handle.id);
    await flush();
    const terminal = await loadState(engine, handle.id);
    expect(terminal.status).toBe('timed-out');

    const lateHandle = engine.getHandle(handle.id);
    let synthesized: WorkflowTimedOutEvent | undefined;
    for await (const event of lateHandle) {
      if (event instanceof WorkflowTimedOutEvent) {
        synthesized = event;
        break;
      }
    }
    expect(synthesized).toBeDefined();
    expect(synthesized!.reason).toBeUndefined();

    engine[Symbol.dispose]();
  });
});

// ---------------------------------------------------------------------------
// Persisted-state decode contract for history circuit breaker fields
// ---------------------------------------------------------------------------

describe('history circuit breaker — persisted-state fields', () => {
  it('round-trips terminationReason through the state codec (preserve)', () => {
    const state = {
      id: 'wf-1',
      type: 'counting',
      status: 'timed-out' as const,
      input: null,
      terminationReason: HISTORY_CIRCUIT_BREAKER_REASON,
      version: '1.0.0',
      createdAt: 1,
      updatedAt: 2,
    };
    const decoded = decode(encode(state)) as WorkflowState;
    expect(decoded.terminationReason).toBe(HISTORY_CIRCUIT_BREAKER_REASON);
  });

  it('round-trips WorkflowTimedOutEvent.reason on the event (preserve)', () => {
    const event = new WorkflowTimedOutEvent(
      'wf-1',
      'execution',
      100,
      HISTORY_CIRCUIT_BREAKER_REASON,
    );
    expect(event.reason).toBe(HISTORY_CIRCUIT_BREAKER_REASON);
    const plain = new WorkflowTimedOutEvent('wf-2', 'execution', 50);
    expect(plain.reason).toBeUndefined();
  });

  it('tolerates an unknown extra field on a persisted state (downgrade)', () => {
    const recordWithUnknownField = {
      id: 'wf-1',
      type: 'counting',
      status: 'completed' as const,
      input: null,
      version: '1.0.0',
      createdAt: 1,
      updatedAt: 2,
      someFutureField: 'ignored-by-old-readers',
    };
    expect(() => decode(encode(recordWithUnknownField))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Validation contract
// ---------------------------------------------------------------------------

describe('normalizeHistoryPolicy', () => {
  it('disables when policy is omitted', () => {
    expect(normalizeHistoryPolicy(undefined, 'options.history')).toEqual({
      maxEvents: null,
      retentionWindow: null,
    });
  });

  it('disables when maxEvents is omitted', () => {
    expect(normalizeHistoryPolicy({}, 'options.history')).toEqual({
      maxEvents: null,
      retentionWindow: null,
    });
  });

  it('disables when maxEvents is 0', () => {
    expect(normalizeHistoryPolicy({ maxEvents: 0 }, 'options.history')).toEqual({
      maxEvents: null,
      retentionWindow: null,
    });
  });

  it('keeps a positive safe integer', () => {
    expect(normalizeHistoryPolicy({ maxEvents: 1000 }, 'options.history')).toEqual({
      maxEvents: 1000,
      retentionWindow: null,
    });
  });

  it('throws on a negative value', () => {
    expect(() => normalizeHistoryPolicy({ maxEvents: -1 }, 'options.history')).toThrow(TypeError);
  });

  it('throws on a non-integer value', () => {
    expect(() => normalizeHistoryPolicy({ maxEvents: 1.5 }, 'options.history')).toThrow(TypeError);
  });

  it('throws on a non-finite value', () => {
    expect(() =>
      normalizeHistoryPolicy({ maxEvents: Number.POSITIVE_INFINITY }, 'options.history'),
    ).toThrow(TypeError);
  });

  it('throws on an unsafe integer', () => {
    expect(() =>
      normalizeHistoryPolicy({ maxEvents: Number.MAX_SAFE_INTEGER + 1 }, 'options.history'),
    ).toThrow(TypeError);
  });

  it('throws on a non-number value', () => {
    expect(() =>
      // @ts-expect-error — exercising the runtime guard against wrong types.
      normalizeHistoryPolicy({ maxEvents: '100' }, 'options.history'),
    ).toThrow(TypeError);
  });

  it('disables retentionWindow when omitted or 0', () => {
    expect(normalizeHistoryPolicy({}, 'options.history').retentionWindow).toBeNull();
    expect(
      normalizeHistoryPolicy({ retentionWindow: 0 }, 'options.history').retentionWindow,
    ).toBeNull();
  });

  it('keeps a positive safe retentionWindow', () => {
    expect(normalizeHistoryPolicy({ retentionWindow: 500 }, 'options.history')).toEqual({
      maxEvents: null,
      retentionWindow: 500,
    });
  });

  it('throws on an invalid retentionWindow', () => {
    expect(() => normalizeHistoryPolicy({ retentionWindow: -1 }, 'options.history')).toThrow(
      TypeError,
    );
    expect(() => normalizeHistoryPolicy({ retentionWindow: 1.5 }, 'options.history')).toThrow(
      TypeError,
    );
    expect(() =>
      normalizeHistoryPolicy({ retentionWindow: Number.POSITIVE_INFINITY }, 'options.history'),
    ).toThrow(TypeError);
    expect(() =>
      // @ts-expect-error — exercising the runtime guard against wrong types.
      normalizeHistoryPolicy({ retentionWindow: '5' }, 'options.history'),
    ).toThrow(TypeError);
  });
});
