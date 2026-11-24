/**
 * COR-1626, correction 7: every exit that ends a run after one of its writes failed is bound to
 * the run that issued the write, and never touches another run that holds the same workflow id.
 *
 * The matrix crosses the exits (rows) with the state of the workflow id when the exit decides
 * (columns). The column's change lands in the narrowest window an exit has: its own read of the
 * record, after the write's last attempt and before its decision. The read answers with the bytes
 * from before the change, so the exit sees the run still open, which is the race as it happens.
 * Every cell asserts the stored record and whose it is, `result()` for the issuing run and for a
 * replacement, the failed events announced, and what is held for the id afterwards: the execution
 * attempt, the concurrency slot's holder marker, and the result waiter. Ownership claims exist only
 * under `workflow-lease`, which the claim tests in `terminal-write-outcomes.test.ts` cover.
 *
 * The second half turns the two probes of review thread 4351725341 into regressions: a same-id
 * `start-new` replacement installed while the checkpoint batch is still being retried.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage, type BatchOperation } from "../../embedded/storage/src/index.ts";
import { drainMicrotasks } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../../storage/keys.ts';
import { flushPortableMicrotasks } from '../../testing/event-loop.ts';
import { deserializeCheckpoint, serializeCheckpoint } from '../checkpoint.ts';
import { decode, encode } from '../codec/api.ts';
import { Engine, ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING } from '../engine.ts';
import { WorkflowFailedEvent } from '../events.ts';
import {
  workflow,
  type WorkerOutboundMessage,
  type WorkflowContext,
  type WorkflowState,
} from '../types.ts';
import { createInlineParkingCallbacks } from './callback-creators.ts';
import { CheckpointCommitFailedError } from './checkpoint-commit-failed-error.ts';
import { CheckpointEncodingError } from './checkpoint-encoding-error.ts';
import {
  abandonedExecutionAttemptCount,
  beginExecutionAttempt,
  currentExecutionAttempt,
  retireExecutionAttempt,
} from './execution-attempts.ts';
import type { WorkflowHandle } from './handles.ts';
import { handleStrategyMessage } from './inline-parking.ts';
import { getInternals } from './internals.ts';
import {
  createRefusingStorage,
  putsCheckpoint,
  putsWorkflowStatus,
  type RefusingStorage,
} from './storage-write-refusal.test-support.ts';
import { ATTEMPTS, NO_WAIT, readState } from './storage-write-retry.test-support.ts';
import { holdStorageWriteRetryWaitsForTesting } from './storage-write-retry.ts';

type ExecuteBody = Parameters<ReturnType<typeof workflow>['execute']>[0];

/** The matrix's workflows carry a concurrency limit, so every run holds a slot and its marker. */
function limited(name: string, execute: ExecuteBody) {
  return workflow({ name, concurrency: { max: 2 } }).execute(execute);
}

/** Parks on `go`, then takes two checkpointed steps and returns `<signal>:a:b`. */
const boundSteps = limited('bound-steps', async function* (ctx: WorkflowContext) {
  const go = yield* ctx.waitForSignal<string>('go');
  const first = yield* ctx.run(() => 'a');
  const second = yield* ctx.run(() => 'b');
  return [go, first, second].join(':');
});

/** Parks on `go`, then fails with `the workflow body failed`. */
const boundFails = limited('bound-fails', async function* (ctx: WorkflowContext) {
  yield* ctx.waitForSignal<string>('go');
  throw new Error('the workflow body failed');
});

/**
 * Parks on `go`, then takes a step whose result cannot be encoded when the input says so: the
 * checkpoint persisted for the step after it is the one that cannot be encoded.
 */
const boundEncodes = limited('bound-encodes', async function* (ctx: WorkflowContext, input) {
  const bad = (input as { bad: boolean } | null)?.bad === true;
  const go = yield* ctx.waitForSignal<string>('go');
  const first = yield* ctx.run(() => (bad ? 1n : 'a'));
  const second = yield* ctx.run(() => 'b');
  return [go, String(first), second].join(':');
});

/**
 * The worker fixture's `wait-signal-then-complete`, which parks on the signal its input names and
 * returns `{ input, payload, workflowId }`; the host-side definition only names and limits it.
 */
const boundWorkerWait = limited('wait-signal-then-complete', async function* () {
  return undefined;
});

const workerUrl = new URL('../../workers/test-browser-worker.ts', import.meta.url);

/** The matrix's definitions share one shape; `boundSteps` names it. */
type Definition = typeof boundSteps;

/** A run parked on its signal over a refusing storage that is armed and ready. */
type Run = {
  readonly engine: Engine;
  readonly refusing: RefusingStorage;
  readonly id: string;
  /** The run's `result()`, with its rejection already observed. */
  readonly result: Promise<unknown>;
  /** The run's execution token as it was started. */
  readonly token: string | undefined;
};

async function openParked(
  definition: Definition,
  id: string,
  input: unknown,
  mode: 'inline' | 'worker' = 'inline',
): Promise<Run> {
  const refusing = createRefusingStorage(new MemoryStorage());
  const engine =
    mode === 'worker'
      ? new Engine({
          storage: refusing.storage,
          workflowExecutionMode: 'worker',
          workerExecution: { workerUrl, poolSize: 1, workflowTurnTimeoutMs: 30_000 },
        })
      : new Engine({ storage: refusing.storage });
  engine.register(definition);
  getInternals(engine).storageWriteRetryDelaysForTesting = NO_WAIT;
  const handle = await engine.start(definition.name, input, { id });
  const result = handle.result();
  void result.catch(() => {});
  await engine[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](id);
  refusing.arm();
  const token = getInternals(engine).checkpoints.get(id)?.workflowExecutionToken;
  return { engine, refusing, id, result, token };
}

/**
 * Make `run` a run from before execution tokens existed, as a store written then would hold it:
 * no token on its record, on its stored and in-memory checkpoint, or on the attempt that holds it.
 * The signal that wakes the parked run launches it again from the stored checkpoint, so the
 * attempt that issues the write carries no token either.
 */
async function stripToken(run: Run): Promise<void> {
  const internals = getInternals(run.engine);
  const record = await readState(run.refusing, run.id);
  delete record.workflowExecutionToken;
  await run.refusing.base.put(KEYS.workflow(run.id), encode(record));
  const stored = deserializeCheckpoint((await run.refusing.base.get(KEYS.checkpoint(run.id)))!);
  delete stored.workflowExecutionToken;
  await run.refusing.base.put(KEYS.checkpoint(run.id), serializeCheckpoint(stored));
  const checkpoint = internals.checkpoints.get(run.id) as { workflowExecutionToken?: string };
  delete checkpoint.workflowExecutionToken;
  retireExecutionAttempt(internals, run.id);
  beginExecutionAttempt(internals, run.id, undefined);
}

/**
 * Run `change` the next time the record of `run.id` is read after `arm()` is called, skipping
 * `skipReads` reads first, and answer that read with the bytes from before the change. Resolves
 * `ran` once the change has run.
 */
function changeRecordUnderNextRead(
  run: Run,
  skipReads: number,
  change: () => Promise<void>,
): { readonly arm: () => void; readonly ran: Promise<void> } {
  const base = run.refusing.base;
  const read = base.get.bind(base);
  const ran = Promise.withResolvers<void>();
  let armed = false;
  let remaining = skipReads;
  base.get = async (key: string) => {
    if (key !== KEYS.workflow(run.id) || !armed) return read(key);
    if (remaining > 0) {
      remaining -= 1;
      return read(key);
    }
    armed = false;
    const stale = await read(key);
    await change();
    ran.resolve();
    return stale;
  };
  return {
    arm: () => {
      armed = true;
    },
    ran: ran.promise,
  };
}

/**
 * Assert that `promise` has not settled once pending microtasks drain. Both outcomes are observed,
 * so a promise that settles later, with a rejection, leaves no unhandled rejection behind.
 */
async function expectStillPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  const observe = (): void => {
    settled = true;
  };
  void promise.then(observe, observe);
  await flushPortableMicrotasks();
  expect(settled).toBe(false);
}

/** Counts the failed events `engine` dispatches from now on. */
function countFailedEvents(engine: Engine): () => number {
  let count = 0;
  engine.addEventListener(WorkflowFailedEvent.type, () => (count += 1));
  return () => count;
}

const failedPut = (id: string) => putsWorkflowStatus(id, 'failed');

type Exit = 'checkpoint' | 'completion' | 'failure' | 'encoding' | 'wait-signal';

type Row = {
  readonly exit: Exit;
  readonly definition: Definition;
  /** Whether the run is driven inline or in a worker; the worker's wait-signal loop is its own exit. */
  readonly mode: 'inline' | 'worker';
  /** The input the issuing run starts with, and the one a replacement starts with. */
  readonly input: unknown;
  readonly replacementInput: unknown;
  /**
   * Reach the exit with `change` applied inside its window: resolves once the change has run and
   * the exit has had the turns it needs to decide.
   */
  readonly trigger: (run: Run, change: () => Promise<void>) => Promise<void>;
  /** The `failed` writes the issuing run's own path sends before the exit decides. */
  readonly ownFailedWrites: number;
};

/** A rule that resolves `reached` when its `times`-th matching write is being handled. */
function attemptReached(times: number): {
  readonly rule: { readonly before: () => void };
  readonly reached: Promise<void>;
} {
  const reached = Promise.withResolvers<void>();
  let seen = 0;
  return {
    rule: {
      before: () => {
        seen += 1;
        if (seen === times) reached.resolve();
      },
    },
    reached: reached.promise,
  };
}

/** The exit's remaining steps are storage reads and in-memory work: a microtask drain lands them. */
async function letTheExitDecide(): Promise<void> {
  await drainMicrotasks();
}

/**
 * A row whose write is refused on every attempt the issuing run makes, and whose exit reads the
 * record once the last attempt is in, after `readsBeforeExit` reads the write's own path makes.
 */
function refusingRow(
  exit: Exit,
  definition: Definition,
  matches: (id: string) => (operations: readonly BatchOperation[]) => boolean,
  readsBeforeExit: number,
  ownFailedWrites: number,
): Row {
  return {
    exit,
    definition,
    mode: 'inline',
    input: null,
    replacementInput: null,
    trigger: async (run, change) => {
      const last = attemptReached(ATTEMPTS);
      run.refusing.refuse({ matches: matches(run.id), times: ATTEMPTS, ...last.rule });
      const interception = changeRecordUnderNextRead(run, readsBeforeExit, change);
      void last.reached.then(interception.arm);
      await run.engine.signal(run.id, 'go', 'x');
      await interception.ran;
      await letTheExitDecide();
    },
    ownFailedWrites,
  };
}

const encodingRow: Row = {
  exit: 'encoding',
  definition: boundEncodes,
  mode: 'inline',
  input: { bad: true },
  replacementInput: { bad: false },
  trigger: async (run, change) => {
    // The checkpoint that cannot be encoded is the third one after the signal: the two before it
    // commit, and the second's commit reads the record once more afterwards, for the worker
    // upgrade evaluation, before the exit reads it.
    const interception = changeRecordUnderNextRead(run, 1, change);
    void run.refusing.whenAttempts(2, putsCheckpoint(run.id)).then(interception.arm);
    await run.engine.signal(run.id, 'go', 'x');
    await interception.ran;
    await letTheExitDecide();
  },
  ownFailedWrites: 0,
};

/** What the worker's wait-signal loop fails with, in the row that ends the run on it. */
const WAIT_LOOP_FAILURE = 'the wait-signal loop failed';

/**
 * The worker strategy's wait-signal loop runs detached from the checkpoint message that started
 * it, and the engine ends the run on its rejection from that detached continuation. The row hands
 * `handleStrategyMessage` the message the worker sends for a signal wait, with the engine's own
 * callbacks except the loop itself, which applies the column's change and then rejects.
 */
const workerWaitSignalRow: Row = {
  exit: 'wait-signal',
  definition: boundWorkerWait,
  mode: 'worker',
  input: { signalName: 'go' },
  replacementInput: { signalName: 'go' },
  trigger: async (run, change) => {
    const message: WorkerOutboundMessage = {
      type: 'checkpoint',
      pendingStepIndex: 0,
      workflowId: run.id,
      checkpoint: new ArrayBuffer(0),
      operationRequest: {
        id: `wait:${run.id}:go`,
        workflowId: run.id,
        kind: 'signal-wait',
        queue: 'default',
        attempt: 1,
        retryPolicy: { maxAttempts: 1, initialBackoff: 0, backoffMultiplier: 1, maxBackoff: 0 },
        scheduledAt: Date.now(),
        signalName: 'go',
      } as never,
    };
    const rejected = Promise.withResolvers<void>();
    await handleStrategyMessage(getInternals(run.engine), message, {
      ...createInlineParkingCallbacks(run.engine),
      processOperation: async () => {
        await change();
        rejected.resolve();
        throw new Error(WAIT_LOOP_FAILURE);
      },
    });
    await rejected.promise;
    await letTheExitDecide();
  },
  ownFailedWrites: 0,
};

const rows: readonly Row[] = [
  refusingRow('checkpoint', boundSteps, putsCheckpoint, 0, 0),
  refusingRow('completion', boundSteps, (id) => putsWorkflowStatus(id, 'completed'), 0, 0),
  // The failure write re-reads the record once after its last refusal, to decide again.
  refusingRow('failure', boundFails, failedPut, 1, ATTEMPTS),
  encodingRow,
  workerWaitSignalRow,
];

type ColumnName =
  | 'still current'
  | 'cancelled, not replaced'
  | 'replaced by a running start-new run'
  | 'replaced, and the replacement already ended'
  | 'pre-token, and the generation was launched again';

/** What the column installed under the id, for the cell to drive and check afterwards. */
type Installed = {
  readonly replacement?: WorkflowHandle;
  readonly replacementResult?: Promise<unknown>;
};

type Column = {
  readonly name: ColumnName;
  /** Prepare the issuing run before its write is refused. */
  readonly prepare?: (run: Run) => Promise<void>;
  /** Change the state of the id, inside the exit's read of the record. */
  readonly change: (run: Run, row: Row) => Promise<Installed>;
};

async function cancelAndReplace(run: Run, row: Row): Promise<Installed> {
  await run.engine.cancel(run.id);
  const replacement = await run.engine.start(row.definition.name, row.replacementInput, {
    id: run.id,
    onTerminalConflict: 'start-new',
  });
  const replacementResult = replacement.result();
  void replacementResult.catch(() => {});
  // A worker-mode engine never parks a same-id `start-new` replacement of a run it has cancelled:
  // the replacement launches, and its wait-signal loop never registers a signal waiter (the same
  // under the previous change). `start` resolving is what installs it, so that is the wait there.
  if (row.mode === 'inline') await run.engine[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](run.id);
  return { replacement, replacementResult };
}

/**
 * End the replacement installed under the id. An inline replacement is signalled and runs to its
 * own end; a worker replacement never parks on a signal, so it is cancelled, which ends it just as
 * surely and without waiting for the worker realm.
 */
async function endReplacement(row: Row, run: Run): Promise<void> {
  if (row.mode === 'worker') await run.engine.cancel(run.id);
  else await run.engine.signal(run.id, 'go', 'y');
}

const columns: readonly Column[] = [
  { name: 'still current', change: () => Promise.resolve({}) },
  {
    name: 'cancelled, not replaced',
    change: async (run) => {
      await run.engine.cancel(run.id);
      return {};
    },
  },
  { name: 'replaced by a running start-new run', change: cancelAndReplace },
  {
    name: 'replaced, and the replacement already ended',
    change: async (run, row) => {
      const installed = await cancelAndReplace(run, row);
      await endReplacement(row, run);
      await installed.replacementResult!.catch(() => {});
      return installed;
    },
  },
  {
    name: 'pre-token, and the generation was launched again',
    prepare: stripToken,
    change: async (run) => {
      // A relaunch of the same generation: the attempt the engine holds for the id is a new one,
      // which carries no token, as the one the write began under carried none.
      const internals = getInternals(run.engine);
      retireExecutionAttempt(internals, run.id);
      beginExecutionAttempt(internals, run.id, undefined);
      return {};
    },
  },
];

/** The outcome the issuing run's own exit produces when nothing else touched the id. */
function expectOwnExit(row: Row, run: Run, record: WorkflowState, reason: unknown): void {
  if (row.exit === 'failure') {
    expect(record.status).toBe('running');
    expect(reason).toBeInstanceOf(CheckpointCommitFailedError);
    expect((reason as CheckpointCommitFailedError).write).toBe('failure');
    expect(abandonedExecutionAttemptCount(getInternals(run.engine))).toBe(1);
    return;
  }
  expect(record.status).toBe('failed');
  expect(record.failureCategory).toBe('system');
  if (row.exit === 'encoding') {
    expect(reason).toBeInstanceOf(CheckpointEncodingError);
    expect(record.error).toContain('checkpoint cannot be encoded');
  } else if (row.exit === 'wait-signal') {
    expect((reason as Error).message).toBe(WAIT_LOOP_FAILURE);
    expect(record.error).toBe(WAIT_LOOP_FAILURE);
  } else {
    expect(reason).toBeInstanceOf(CheckpointCommitFailedError);
    expect((reason as CheckpointCommitFailedError).write).toBe(row.exit);
    expect(record.error).toBe((reason as Error).message);
  }
  expect(currentExecutionAttempt(getInternals(run.engine), run.id)).toBeUndefined();
}

/** What a replacement of `row`'s workflow ends with once it is signalled. */
async function expectReplacementEnding(row: Row, run: Run, installed: Installed): Promise<void> {
  if (row.mode === 'worker') {
    expect((await rejectionOf(installed.replacementResult)) as Error).toHaveProperty(
      'message',
      'Workflow cancelled',
    );
    const cancelled = await readState(run.refusing, run.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.workflowExecutionToken).not.toBe(run.token);
    expect(currentExecutionAttempt(getInternals(run.engine), run.id)).toBeUndefined();
    expect(await run.refusing.base.get(KEYS.workflowConcurrencyHolder(run.id))).toBeNull();
    return;
  }
  const replacementValue = 'y:a:b';
  if (row.exit === 'failure') {
    expect((await rejectionOf(installed.replacementResult)) as Error).toHaveProperty(
      'message',
      'the workflow body failed',
    );
  } else {
    expect(await installed.replacementResult).toEqual(replacementValue);
  }
  const record = await readState(run.refusing, run.id);
  expect(record.workflowExecutionToken).not.toBe(run.token);
  if (row.exit === 'failure') {
    expect(record.status).toBe('failed');
    expect(record.error).toBe('the workflow body failed');
  } else {
    expect(record.status).toBe('completed');
    expect(record.result).toEqual(replacementValue);
  }
  const internals = getInternals(run.engine);
  expect(currentExecutionAttempt(internals, run.id)).toBeUndefined();
  expect(await run.refusing.base.get(KEYS.workflowConcurrencyHolder(run.id))).toBeNull();
}

describe('a failed write ends only the run that issued it', () => {
  for (const row of rows) {
    for (const column of columns) {
      it(`${row.exit}: ${column.name}`, async () => {
        const id = `bound-${row.exit}-${columns.indexOf(column).toString()}`;
        const run = await openParked(row.definition, id, row.input, row.mode);
        await using engine = run.engine;
        const internals = getInternals(engine);
        await column.prepare?.(run);
        const token = internals.checkpoints.get(id)?.workflowExecutionToken;
        const failedEvents = countFailedEvents(engine);
        let installed: Installed = {};
        await row.trigger(run, async () => {
          installed = await column.change(run, row);
        });

        const record = await readState(run.refusing, id);
        const holder = await run.refusing.base.get(KEYS.workflowConcurrencyHolder(id));
        const failedWrites = run.refusing.attemptsMatching(failedPut(id)).length;
        if (column.name === 'still current') {
          expectOwnExit(row, run, record, await rejectionOf(run.result));
          expect(failedEvents()).toBe(row.exit === 'failure' ? 0 : 1);
          if (row.exit !== 'failure') expect(holder).toBeNull();
          return;
        }

        // The exit wrote nothing, released nothing of another run's, and announced nothing. A
        // replacement that already ended by failing wrote and announced its own failure.
        const replacementFailed =
          row.exit === 'failure' && column.name === 'replaced, and the replacement already ended';
        expect(failedWrites).toBe(row.ownFailedWrites + (replacementFailed ? 1 : 0));
        expect(failedEvents()).toBe(replacementFailed ? 1 : 0);
        expect(abandonedExecutionAttemptCount(internals)).toBe(0);

        if (column.name === 'pre-token, and the generation was launched again') {
          expect(token).toBeUndefined();
          expect(record.status).toBe('running');
          expect(record.workflowExecutionToken).toBeUndefined();
          // The relaunched attempt is left as it stands, and the run's waiter waits for it.
          const attempt = currentExecutionAttempt(internals, id);
          expect(attempt).toBeDefined();
          expect(attempt?.workflowExecutionToken).toBeUndefined();
          expect(internals.resultResolvers.has(id)).toBe(true);
          await expectStillPending(run.result);
          expect(holder).not.toBeNull();
          return;
        }

        // The cancel ended the issuing run, and nothing changed that.
        expect((await rejectionOf(run.result)) as Error).toHaveProperty(
          'message',
          'Workflow cancelled',
        );
        if (column.name === 'cancelled, not replaced') {
          expect(record.status).toBe('cancelled');
          expect(record.workflowExecutionToken).toBe(token);
          expect(currentExecutionAttempt(internals, id)).toBeUndefined();
          expect(holder).toBeNull();
          expect(internals.resultResolvers.has(id)).toBe(false);
          return;
        }

        if (column.name === 'replaced by a running start-new run') {
          expect(record.status).toBe('running');
          expect(record.workflowExecutionToken).not.toBe(token);
          const attempt = currentExecutionAttempt(internals, id);
          expect(attempt?.workflowExecutionToken).toBe(record.workflowExecutionToken);
          expect(attempt?.abandoned).toBe(false);
          expect(holder).not.toBeNull();
          await expectStillPending(installed.replacementResult!);
          // The replacement is untouched: it runs to its own end.
          await endReplacement(row, run);
          await expectReplacementEnding(row, run, installed);
          return;
        }

        // The replacement had already ended, and its record and outcome stand.
        await expectReplacementEnding(row, run, installed);
      });
    }
  }
});

/** Whether `operations` put the checkpoint of `id` carrying `token`. */
function checkpointBatchOf(id: string, token: string | undefined) {
  const needle = token === undefined ? undefined : new TextEncoder().encode(token);
  return (operations: readonly BatchOperation[]) =>
    operations.some(
      (operation) =>
        operation.type === 'put' &&
        operation.key === KEYS.checkpoint(id) &&
        (needle === undefined || containsBytes(operation.value, needle)),
    );
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  for (let index = 0; index + needle.length <= haystack.length; index++) {
    if (needle.every((byte, offset) => haystack[index + offset] === byte)) return true;
  }
  return false;
}

/**
 * Cancel the run under `id` and start a replacement under it, which parks on `go`. The
 * replacement's `result()` comes back wrapped, so awaiting this does not await that result.
 */
async function replaceWhileRetrying(run: Run): Promise<{ readonly result: Promise<unknown> }> {
  await run.engine.cancel(run.id);
  const replacement = await run.engine.start(boundSteps.name, null, {
    id: run.id,
    onTerminalConflict: 'start-new',
  });
  const result = replacement.result();
  void result.catch(() => {});
  await run.engine[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](run.id);
  return { result };
}

/** What the replacement and the store look like once the issuing run's retries have run out. */
async function expectReplacementUntouched(
  run: Run,
  replacementResult: Promise<unknown>,
  failedEvents: () => number,
): Promise<void> {
  const internals = getInternals(run.engine);
  const batchOfA = checkpointBatchOf(run.id, run.token);
  await run.refusing.whenAttempts(ATTEMPTS, batchOfA);
  await drainMicrotasks();

  expect(run.refusing.attemptsMatching(batchOfA as never)).toHaveLength(ATTEMPTS);
  expect(run.refusing.attemptsMatching(failedPut(run.id))).toHaveLength(0);
  expect(failedEvents()).toBe(0);
  const record = await readState(run.refusing, run.id);
  expect(record.status).toBe('running');
  expect(record.workflowExecutionToken).not.toBe(run.token);
  expect(currentExecutionAttempt(internals, run.id)?.workflowExecutionToken).toBe(
    record.workflowExecutionToken,
  );
  expect(abandonedExecutionAttemptCount(internals)).toBe(0);
  await expectStillPending(replacementResult);
  expect((await rejectionOf(run.result)) as Error).toHaveProperty('message', 'Workflow cancelled');

  await run.engine.signal(run.id, 'go', 'y');
  expect(await replacementResult).toBe('y:a:b');
  expect(await readState(run.refusing, run.id)).toMatchObject({
    status: 'completed',
    result: 'y:a:b',
  });
}

describe('a start-new replacement installed while the checkpoint batch is retried', () => {
  it('is left alone when it lands while a retry is in flight', async () => {
    const run = await openParked(boundSteps, 'replace-in-flight', null);
    await using engine = run.engine;
    const failedEvents = countFailedEvents(engine);
    const reachedFirstRetry = Promise.withResolvers<void>();
    const releaseFirstRetry = Promise.withResolvers<void>();
    let seen = 0;
    run.refusing.refuse({
      matches: checkpointBatchOf(run.id, run.token),
      before: async () => {
        seen += 1;
        if (seen !== 2) return;
        reachedFirstRetry.resolve();
        await releaseFirstRetry.promise;
      },
    });

    await engine.signal(run.id, 'go', 'x');
    await reachedFirstRetry.promise;
    const replacement = await replaceWhileRetrying(run);
    releaseFirstRetry.resolve();

    await expectReplacementUntouched(run, replacement.result, failedEvents);
  });

  it('is left alone when it lands during the wait before the last retry', async () => {
    const run = await openParked(boundSteps, 'replace-in-wait', null);
    await using engine = run.engine;
    const failedEvents = countFailedEvents(engine);
    const batchOfA = checkpointBatchOf(run.id, run.token);
    // The first three retries follow at once; the wait before the last one is held by the test,
    // with no attempt in flight, until the replacement is installed.
    const lastWait = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    getInternals(engine).storageWriteRetryDelaysForTesting = [0, 0, 0, 1];
    holdStorageWriteRetryWaitsForTesting(getInternals(engine), (milliseconds) => {
      if (milliseconds === 0) return Promise.resolve();
      waiting.resolve();
      return lastWait.promise;
    });
    run.refusing.refuse({ matches: batchOfA });

    await engine.signal(run.id, 'go', 'x');
    await waiting.promise;
    expect(run.refusing.attemptsMatching(batchOfA as never)).toHaveLength(ATTEMPTS - 1);
    const replacement = await replaceWhileRetrying(run);
    lastWait.resolve();

    await expectReplacementUntouched(run, replacement.result, failedEvents);
  });
});

describe('a failure write the exit itself issues', () => {
  it('settles the run from the record when its last attempt lands but reports failure', async () => {
    const run = await openParked(boundSteps, 'nested-failure-landed', null);
    await using engine = run.engine;
    const failedEvents = countFailedEvents(engine);
    run.refusing.refuse({ matches: putsCheckpoint(run.id), times: ATTEMPTS });
    run.refusing.refuse({ matches: failedPut(run.id), times: ATTEMPTS - 1 });
    run.refusing.refuse({ matches: failedPut(run.id), mode: 'land-then-throw', times: 1 });

    await engine.signal(run.id, 'go', 'x');
    const reason = await rejectionOf(run.result);

    const record = await readState(run.refusing, run.id);
    expect(record.status).toBe('failed');
    expect(record.failureCategory).toBe('system');
    expect(record.error).toContain('checkpoint write was not committed');
    expect((reason as Error).message).toBe(record.error ?? '');
    expect(failedEvents()).toBe(1);
    const internals = getInternals(engine);
    expect(abandonedExecutionAttemptCount(internals)).toBe(0);
    expect(currentExecutionAttempt(internals, run.id)).toBeUndefined();
    expect(internals.resultResolvers.has(run.id)).toBe(false);
    expect(
      decode((await run.refusing.base.get(KEYS.workflow(run.id)))!) as WorkflowState,
    ).toMatchObject({
      status: 'failed',
    });
  });
});
