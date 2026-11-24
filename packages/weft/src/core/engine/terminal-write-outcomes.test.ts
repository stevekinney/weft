/**
 * COR-1626, review round 2: every exit from the terminal-write path ends the run's waiter.
 *
 * The invariant is stated once and held by a matrix: eight behaviours of the storage and of another
 * writer, each crossed with the two terminal writes (a completion and a failure). Every cell asserts
 * the same five things:
 *
 * - the in-flight `result()` settles;
 * - a `result()` requested afterwards on a fresh handle settles;
 * - the durable record is terminal, except in the one ruled abandon case: a failure write refused
 *   on every attempt, which leaves the record `running` for the next boot;
 * - no change another writer made is overwritten;
 * - nothing the engine held for the run is left behind (the result waiter, the checkpoint), and
 *   the leak guard that runs after every test sees no timer left armed.
 *
 * A hang in any cell fails it by the test runner's own timeout.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/keys.ts';
import { decode, encode } from '../codec/api.ts';
import { WorkflowCompletedEvent, WorkflowFailedEvent } from '../events.ts';
import type { WorkflowState } from '../types.ts';
import { createTerminationCallbacks } from './callback-creators-core.ts';
import { CheckpointCommitFailedError } from './checkpoint-commit-failed-error.ts';
import {
  abandonedExecutionAttemptCount,
  beginExecutionAttempt,
  currentExecutionAttempt,
  retireExecutionAttempt,
} from './execution-attempts.ts';
import { WorkflowHandle } from './handles.ts';
import { getInternals } from './internals.ts';
import { putsWorkflowStatus } from './storage-write-refusal.test-support.ts';
import {
  failsAfterSignal,
  startParked,
  startParkedUnobserved,
  steps,
  type Run,
} from './storage-write-retry.test-support.ts';
import { endRunAfterFailedWrite } from './terminal-run-exit.ts';
import type { TerminationCallbacks } from './termination.ts';
import {
  captureTerminatedRun,
  engineHoldsRun,
  settleRunFromStoredRecord,
} from './termination/settle-refused-terminal.ts';

type Kind = 'completion' | 'failure';

/** How one settled `result()` ended, in terms every cell can compare. */
type Settlement =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'rejection'; readonly error: unknown };

async function settlementOf(promise: Promise<unknown>): Promise<Settlement> {
  try {
    return { kind: 'value', value: await promise };
  } catch (error) {
    return { kind: 'rejection', error };
  }
}

/** What a cell expects of its `result()` calls. */
type Outcome =
  /** The run's own: the completion's value, or the failure's error. */
  | 'own'
  /** The typed commit failure, for the write named. */
  | { readonly commitFailed: Kind }
  /** The outcome another writer's terminal record holds. */
  | 'another writer’s outcome'
  /** A newer run took the id: the waiter was told, and a later result() reads the newer run. */
  | 'replaced';

const ANOTHER_WRITERS_RESULT = 'another writer’s result';
const REPLACEMENT_RESULT = 'the replacement’s result';

/** What a cell does to the storage, and what it leaves to be checked afterwards. */
type Arming = {
  /** The bytes another writer left in `wf:<id>`, when it left any. */
  readonly othersBytes: () => Uint8Array | undefined;
  /** Whether the record keeps what another writer changed, when it only changed part of it. */
  readonly keepsTheChange?: (record: WorkflowState) => boolean;
};

type Behaviour = {
  readonly name: string;
  readonly arm: (run: Run, id: string, kind: Kind) => Arming;
  readonly outcome: (kind: Kind) => Outcome;
  /** The ruled abandon case is the only one that leaves the record `running`. */
  readonly leavesRunning?: (kind: Kind) => boolean;
  /** Writes of the terminal record the storage should have seen, when the cell pins them. */
  readonly terminalWrites?: number;
};

const terminalPut = (id: string, kind: Kind) =>
  putsWorkflowStatus(id, kind === 'completion' ? 'completed' : 'failed');

/** Another writer replaces `wf:<id>` at the moment the first terminal attempt fails. */
function otherWriterChanges(run: Run, id: string, change: (record: WorkflowState) => void) {
  let bytes: Uint8Array | undefined;
  return {
    before: async () => {
      const record = decode((await run.refusing.base.get(KEYS.workflow(id)))!) as WorkflowState;
      change(record);
      bytes = encode(record);
      await run.refusing.base.put(KEYS.workflow(id), bytes);
    },
    bytes: () => bytes,
  };
}

const edited = 'edited-elsewhere';
const addTag = (record: WorkflowState): void => {
  record.tags = [...(record.tags ?? []), edited];
};

const behaviours: readonly Behaviour[] = [
  {
    name: 'lands, then reports failure',
    terminalWrites: 1,
    arm: (run, id, kind) => {
      run.refusing.refuse({ matches: terminalPut(id, kind), mode: 'land-then-throw', times: 1 });
      return { othersBytes: () => undefined };
    },
    outcome: () => 'own',
  },
  {
    name: 'refused on every attempt',
    arm: (run, id, kind) => {
      run.refusing.refuse({ matches: terminalPut(id, kind) });
      return { othersBytes: () => undefined };
    },
    outcome: (kind) => ({ commitFailed: kind }),
    leavesRunning: (kind) => kind === 'failure',
  },
  {
    name: 'another writer changes updatedAt between attempts, then writes pass',
    arm: (run, id, kind) => {
      const other = otherWriterChanges(run, id, (record) => {
        record.updatedAt += 1;
      });
      run.refusing.refuse({ matches: terminalPut(id, kind), times: 1, before: other.before });
      return { othersBytes: () => undefined };
    },
    outcome: () => 'own',
  },
  {
    name: 'another writer adds a tag between attempts, then writes pass',
    arm: (run, id, kind) => {
      const other = otherWriterChanges(run, id, addTag);
      run.refusing.refuse({ matches: terminalPut(id, kind), times: 1, before: other.before });
      return {
        othersBytes: () => undefined,
        keepsTheChange: (r) => r.tags?.includes(edited) === true,
      };
    },
    outcome: () => 'own',
  },
  {
    name: 'another writer leaves a look-alike completed record',
    arm: (run, id, kind) => {
      const other = otherWriterChanges(run, id, (record) => {
        record.status = 'completed';
        record.result = ANOTHER_WRITERS_RESULT;
      });
      run.refusing.refuse({ matches: terminalPut(id, kind), times: 1, before: other.before });
      return { othersBytes: other.bytes };
    },
    outcome: () => 'another writer’s outcome',
  },
  {
    name: 'a compare-and-swap is lost between the read and the send',
    arm: (run, id, kind) => {
      run.refusing.refuse({ matches: terminalPut(id, kind), times: 1 });
      const other = otherWriterChanges(run, id, addTag);
      // The retry reads the record as it decided, and sends: the other writer's change lands just
      // before that send reaches the store.
      run.refusing.refuse({
        matches: terminalPut(id, kind),
        mode: 'pass',
        times: 1,
        before: other.before,
      });
      return {
        othersBytes: () => undefined,
        keepsTheChange: (r) => r.tags?.includes(edited) === true,
      };
    },
    outcome: () => 'own',
  },
  {
    name: 'reads are refused as well as writes',
    arm: (run, id, kind) => {
      let armedReads = false;
      run.refusing.refuse({
        matches: terminalPut(id, kind),
        before: () => {
          if (armedReads) return;
          armedReads = true;
          // Each of the four retries reads the record first, and none of those reads is answered.
          run.refusing.refuseReads(KEYS.workflow(id), 4);
        },
      });
      return { othersBytes: () => undefined };
    },
    outcome: (kind) => ({ commitFailed: kind }),
    leavesRunning: (kind) => kind === 'failure',
  },
  {
    name: 'a record from another generation',
    arm: (run, id, kind) => {
      const other = otherWriterChanges(run, id, (record) => {
        record.workflowExecutionToken = 'another-generation';
        record.status = 'completed';
        record.result = REPLACEMENT_RESULT;
      });
      run.refusing.refuse({ matches: terminalPut(id, kind), times: 1, before: other.before });
      return { othersBytes: other.bytes };
    },
    outcome: () => 'replaced',
  },
];

function expectOutcome(settlement: Settlement, outcome: Outcome, kind: Kind, late: boolean): void {
  if (outcome === 'own') {
    if (kind === 'completion') {
      expect(settlement).toEqual({ kind: 'value', value: 'x:a:b' });
    } else {
      expect(settlement).toMatchObject({
        kind: 'rejection',
        error: { message: 'the workflow body failed' },
      });
    }
  } else if (outcome === 'another writer’s outcome') {
    expect(settlement).toEqual({ kind: 'value', value: ANOTHER_WRITERS_RESULT });
  } else if (outcome === 'replaced') {
    // The waiter that was waiting is told its run was replaced. A result() asked for afterwards
    // reads the run that holds the id now.
    if (late) {
      expect(settlement).toEqual({ kind: 'value', value: REPLACEMENT_RESULT });
    } else {
      expect(settlement).toMatchObject({
        kind: 'rejection',
        error: { message: expect.stringContaining('was replaced by a newer run') },
      });
    }
  } else {
    expect(settlement.kind).toBe('rejection');
    const error = (settlement as { error: Error }).error;
    expect(error.message).toContain(`${outcome.commitFailed} write was not committed after`);
    // The typed error reaches a waiter the engine rejected; a record read back carries its message.
    if (!late) expect(error).toBeInstanceOf(CheckpointCommitFailedError);
  }
}

describe('every exit from a terminal write settles the run', () => {
  for (const kind of ['completion', 'failure'] as const) {
    for (const [index, behaviour] of behaviours.entries()) {
      it(`${kind}: ${behaviour.name}`, async () => {
        const id = `outcome-${kind}-${String(index)}`;
        const run = await startParked(kind === 'completion' ? steps : failsAfterSignal, id);
        await using engine = run.engine;
        const arming = behaviour.arm(run, id, kind);
        const announced = countTerminalEvents(engine);

        await engine.signal(id, 'go', 'x');
        const outcome = behaviour.outcome(kind);

        // 1. The in-flight result() settles.
        expectOutcome(await settlementOf(run.result), outcome, kind, false);

        // 2. A result() requested afterwards, on a fresh handle, settles too.
        const lateHandle = new WorkflowHandle(id, getInternals(engine).engine);
        const abandoned = behaviour.leavesRunning?.(kind) === true;
        const late = await settlementOf(lateHandle.result());
        expectOutcome(late, outcome, kind, !abandoned);

        // 3. The record is terminal, or is the ruled abandon.
        const record = decode((await run.refusing.base.get(KEYS.workflow(id)))!) as WorkflowState;
        if (abandoned) {
          expect(record.status).toBe('running');
          expect(abandonedExecutionAttemptCount(getInternals(engine))).toBe(1);
        } else {
          expect(['completed', 'failed']).toContain(record.status);
        }

        // 4. Nothing another writer changed is overwritten.
        const othersBytes = arming.othersBytes();
        if (othersBytes !== undefined) {
          expect(await run.refusing.base.get(KEYS.workflow(id))).toEqual(othersBytes);
        }
        if (arming.keepsTheChange !== undefined) expect(arming.keepsTheChange(record)).toBe(true);
        if (behaviour.terminalWrites !== undefined) {
          expect(run.refusing.attemptsMatching(terminalPut(id, kind))).toHaveLength(
            behaviour.terminalWrites,
          );
        }

        // 5. Nothing the engine held for the run is left behind.
        const internals = getInternals(engine);
        expect(internals.resultResolvers.has(id)).toBe(false);
        if (!abandoned) expect(internals.checkpoints.has(id)).toBe(false);

        // 6. The run is announced at most once.
        expect(announced()).toBeLessThanOrEqual(1);
      });
    }
  }
});

/** Counts the completed and failed events `engine` dispatches from now on. */
function countTerminalEvents(engine: EventTarget): () => number {
  let count = 0;
  engine.addEventListener(WorkflowCompletedEvent.type, () => (count += 1));
  engine.addEventListener(WorkflowFailedEvent.type, () => (count += 1));
  return () => count;
}

describe('a run nobody asked the result of', () => {
  it.each([
    ['the default ownership', undefined],
    ["ownership: 'workflow-lease'", 'workflow-lease'],
  ] as const)(
    'is announced as failed exactly once when its completion is refused, under %s',
    async (_name, ownership) => {
      const id = `unobserved-${ownership ?? 'none'}`;
      const run = await startParkedUnobserved(
        steps,
        id,
        ownership === undefined ? {} : { ownership },
      );
      await using engine = run.engine;
      const failures: unknown[] = [];
      const failed = Promise.withResolvers<void>();
      engine.addEventListener(WorkflowFailedEvent.type, (event) => {
        failures.push(event);
        failed.resolve();
      });
      run.refusing.refuse({ matches: terminalPut(id, 'completion') });

      await engine.signal(id, 'go', 'x');
      // No result() is ever asked for, so the run is watched only through its events. A second
      // announcement would follow the first within the same terminal path, so one macrotask after
      // the first lets it land; disposing first would end the path early (it drops the claim
      // registry a workflow-lease announcement needs) and hide it.
      await failed.promise;
      // load-proof: negative window: asserts a second announcement does not follow the first; load can only delay one, never create it
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(failures).toHaveLength(1);
    },
  );
});

describe('whether the engine still holds a run', () => {
  it('needs an attempt to exist, so a released run recorded before execution tokens is not held', async () => {
    const id = 'pre-token-holds';
    const run = await startParkedUnobserved(steps, id);
    await using engine = run.engine;
    const internals = getInternals(engine);
    // A run from before execution tokens: no token on the run, and none on the attempt that holds it.
    beginExecutionAttempt(internals, id, undefined);
    const preToken = captureTerminatedRun(internals, id);
    expect(preToken.workflowExecutionToken).toBeUndefined();
    expect(engineHoldsRun(internals, id, preToken)).toBe(true);

    // Released, the engine reads no token at all, which must not pass for the run's missing one.
    retireExecutionAttempt(internals, id);
    expect(engineHoldsRun(internals, id, preToken)).toBe(false);

    // Launched again, the generation shares the run's missing token and is still not the run.
    beginExecutionAttempt(internals, id, undefined);
    expect(engineHoldsRun(internals, id, preToken)).toBe(false);
    retireExecutionAttempt(internals, id);
  });
});

describe('a result() first asked for while the engine is ending the run', () => {
  it('settles from the record another writer left, though it was not registered when the run ended', async () => {
    const id = 'asked-during-the-window';
    const run = await startParkedUnobserved(steps, id);
    await using engine = run.engine;
    // Wrapped, so awaiting it hands back the result() promise rather than its outcome.
    const asked = Promise.withResolvers<{ readonly result: Promise<unknown> }>();
    const other = otherWriterChanges(run as Run, id, (record) => {
      record.status = 'completed';
      record.result = ANOTHER_WRITERS_RESULT;
    });
    run.refusing.refuse({
      matches: terminalPut(id, 'completion'),
      times: 1,
      before: async () => {
        // The first result() for the run arrives after the terminal message was taken up, while
        // the record still says running; then another writer ends the run.
        const result = new WorkflowHandle(id, getInternals(engine).engine).result();
        void result.catch(() => {});
        asked.resolve({ result });
        await other.before();
      },
    });

    await engine.signal(id, 'go', 'x');
    const { result } = await asked.promise;

    expect(await settlementOf(result)).toEqual({ kind: 'value', value: ANOTHER_WRITERS_RESULT });
    expect(getInternals(engine).resultResolvers.has(id)).toBe(false);
  });
});

describe('a run settled from an unstamped record, under the default ownership', () => {
  it('announces the run this engine held, since nothing stamps a terminal write here', async () => {
    const id = 'unstamped-record';
    const run = await startParked(steps, id);
    await using engine = run.engine;
    const completions: unknown[] = [];
    engine.addEventListener(WorkflowCompletedEvent.type, (event) => completions.push(event));
    const other = otherWriterChanges(run, id, (record) => {
      record.status = 'completed';
      record.result = ANOTHER_WRITERS_RESULT;
    });
    run.refusing.refuse({ matches: terminalPut(id, 'completion'), times: 1, before: other.before });

    await engine.signal(id, 'go', 'x');

    expect(await settlementOf(run.result)).toEqual({
      kind: 'value',
      value: ANOTHER_WRITERS_RESULT,
    });
    expect(completions).toHaveLength(1);
  });
});

describe("a run settled from a record another writer left, under ownership: 'workflow-lease'", () => {
  /** Another writer ends the run with a completed record, which `committedBy` may stamp. */
  async function settledFromLookAlike(
    id: string,
    committedBy: (own: string) => string,
    ending: 'completed' | 'failed' | 'cancelled' = 'completed',
  ) {
    const run = await startParked(steps, id, { ownership: 'workflow-lease' });
    const internals = getInternals(run.engine);
    const registry = internals.workflowClaimRegistry!;
    const completions: unknown[] = [];
    const failures: unknown[] = [];
    run.engine.addEventListener(WorkflowCompletedEvent.type, (event) => completions.push(event));
    run.engine.addEventListener(WorkflowFailedEvent.type, (event) => failures.push(event));
    expect(registry.currentEpoch(id)).not.toBeNull();
    const other = otherWriterChanges(run, id, (record) => {
      record.status = ending;
      record.result = ANOTHER_WRITERS_RESULT;
      record.error = 'ended elsewhere';
      record.terminalCommittedBy = committedBy(registry.engineId);
    });
    run.refusing.refuse({ matches: terminalPut(id, 'completion'), times: 1, before: other.before });
    await run.engine.signal(id, 'go', 'x');
    const settlement = await settlementOf(run.result);
    return { run, internals, registry, completions, failures, settlement, bytes: other.bytes() };
  }

  it('releases the ownership claim and what the run held, and announces its own write', async () => {
    const id = 'own-stamp';
    const { run, internals, registry, completions, settlement, bytes } = await settledFromLookAlike(
      id,
      (own) => own,
    );
    await using engine = run.engine;

    expect(settlement).toEqual({ kind: 'value', value: ANOTHER_WRITERS_RESULT });
    expect(registry.currentEpoch(id)).toBeNull();
    expect(internals.checkpoints.has(id)).toBe(false);
    expect(completions).toHaveLength(1);
    expect(await run.refusing.base.get(KEYS.workflow(id))).toEqual(bytes ?? null);
    expect(engine).toBeDefined();
  });

  it('announces nothing for a run another engine ended, and still releases the claim', async () => {
    const id = 'other-stamp';
    const { run, internals, registry, completions, settlement } = await settledFromLookAlike(
      id,
      () => 'another-engine',
    );
    await using engine = run.engine;

    expect(settlement).toEqual({ kind: 'value', value: ANOTHER_WRITERS_RESULT });
    expect(registry.currentEpoch(id)).toBeNull();
    expect(internals.checkpoints.has(id)).toBe(false);
    expect(completions).toEqual([]);
    expect(engine).toBeDefined();
  });
});

describe("a run another writer ended otherwise, under ownership: 'workflow-lease'", () => {
  it('announces a failed record this engine wrote as a failure', async () => {
    const id = 'own-failed-record';
    const run = await startParked(steps, id, { ownership: 'workflow-lease' });
    await using engine = run.engine;
    const internals = getInternals(engine);
    const failures: unknown[] = [];
    engine.addEventListener(WorkflowFailedEvent.type, (event) => failures.push(event));
    const other = otherWriterChanges(run, id, (record) => {
      record.status = 'failed';
      record.error = 'ended elsewhere';
      record.terminalCommittedBy = internals.workflowClaimRegistry!.engineId;
    });
    run.refusing.refuse({ matches: terminalPut(id, 'completion'), times: 1, before: other.before });

    await engine.signal(id, 'go', 'x');

    expect(await settlementOf(run.result)).toMatchObject({
      kind: 'rejection',
      error: { message: 'ended elsewhere' },
    });
    expect(failures).toHaveLength(1);
  });

  it('announces nothing for a cancelled record, which the cancel announced', async () => {
    const id = 'own-cancelled-record';
    const run = await startParked(steps, id, { ownership: 'workflow-lease' });
    await using engine = run.engine;
    const internals = getInternals(engine);
    const events: unknown[] = [];
    engine.addEventListener(WorkflowCompletedEvent.type, (event) => events.push(event));
    engine.addEventListener(WorkflowFailedEvent.type, (event) => events.push(event));
    const other = otherWriterChanges(run, id, (record) => {
      record.status = 'cancelled';
      record.terminalCommittedBy = internals.workflowClaimRegistry!.engineId;
    });
    run.refusing.refuse({ matches: terminalPut(id, 'completion'), times: 1, before: other.before });

    await engine.signal(id, 'go', 'x');

    expect(await settlementOf(run.result)).toMatchObject({
      kind: 'rejection',
      error: { message: 'Workflow cancelled' },
    });
    expect(events).toEqual([]);
  });
});

describe('the exits that need the engine in a particular state', () => {
  it('rejects the waiter itself when the engine holds no attempt for the run to abandon', async () => {
    const id = 'no-attempt';
    const run = await startParked(failsAfterSignal, id);
    await using engine = run.engine;
    const internals = getInternals(engine);
    const waiter = internals.resultResolvers.get(id)!;
    // The run as it stood when the engine held no attempt for it, so there is nothing to mark.
    const captured = { ...captureTerminatedRun(internals, id), attempt: undefined };
    retireExecutionAttempt(internals, id);

    await endRunAfterFailedWrite(
      internals,
      id,
      { createTerminationCallbacks: () => ({}) as TerminationCallbacks },
      new Error('the failure write failed'),
      'failure',
      captured,
    );

    const settlement = await settlementOf(run.result);
    expect(settlement).toMatchObject({ kind: 'rejection' });
    const error = (settlement as { error: unknown }).error;
    expect(error).toBeInstanceOf(CheckpointCommitFailedError);
    // An error no code classified carries no count, so the message states none rather than a wrong one.
    expect((error as CheckpointCommitFailedError).message).toBe(
      `Workflow "${id}" failure write was not committed.`,
    );
    expect(internals.resultResolvers.get(id)).not.toBe(waiter);
    expect(internals.resultResolvers.has(id)).toBe(false);
  });

  it('settles the waiter from the record when failing the run finds it already ended', async () => {
    const id = 'failing-finds-it-ended';
    const run = await startParked(steps, id);
    await using engine = run.engine;
    const internals = getInternals(engine);
    const captured = captureTerminatedRun(internals, id);
    // The stored-record check reads the run still running. Before the failure write reads it,
    // another writer ends it, so failing the run writes nothing and settles nothing itself.
    const base = run.refusing.base;
    const read = base.get.bind(base);
    let reads = 0;
    base.get = async (key: string) => {
      if (key === KEYS.workflow(id) && ++reads === 2) {
        const record = decode((await read(key))!) as WorkflowState;
        record.status = 'completed';
        record.result = ANOTHER_WRITERS_RESULT;
        await base.put(key, encode(record));
      }
      return read(key);
    };

    await endRunAfterFailedWrite(
      internals,
      id,
      { createTerminationCallbacks: () => createTerminationCallbacks(engine) },
      new Error('the completion write failed'),
      'completion',
      captured,
    );

    expect(await settlementOf(run.result)).toEqual({
      kind: 'value',
      value: ANOTHER_WRITERS_RESULT,
    });
    expect(internals.resultResolvers.has(id)).toBe(false);
  });

  it('releases what the run held when failing it finds the record already ended and nobody waits', async () => {
    const id = 'unobserved-ended-elsewhere';
    const run = await startParkedUnobserved(steps, id);
    await using engine = run.engine;
    const internals = getInternals(engine);
    const captured = captureTerminatedRun(internals, id);
    expect(captured.waiter).toBeUndefined();
    // As in the waiter case above: the stored-record check reads the run still running, then another
    // writer ends it before the failure write reads it, so failing the run writes nothing.
    const base = run.refusing.base;
    const read = base.get.bind(base);
    let reads = 0;
    base.get = async (key: string) => {
      if (key === KEYS.workflow(id) && ++reads === 2) {
        const record = decode((await read(key))!) as WorkflowState;
        record.status = 'completed';
        record.result = ANOTHER_WRITERS_RESULT;
        await base.put(key, encode(record));
      }
      return read(key);
    };

    await endRunAfterFailedWrite(
      internals,
      id,
      { createTerminationCallbacks: () => createTerminationCallbacks(engine) },
      new Error('the completion write failed'),
      'completion',
      captured,
    );

    expect(internals.checkpoints.has(id)).toBe(false);
    expect(currentExecutionAttempt(internals, id)).toBeUndefined();
  });

  it('leaves a waiter bound to another run alone, though the run being ended captured none', async () => {
    const id = 'another-runs-waiter';
    const run = await startParked(steps, id);
    await using engine = run.engine;
    const internals = getInternals(engine);
    const registered = internals.resultResolvers.get(id)!;
    const captured = { ...captureTerminatedRun(internals, id), waiter: undefined };
    // The waiter now registered belongs to a replacement run, under another token.
    registered.workflowExecutionToken = 'a-replacement-run';
    const record = decode((await run.refusing.base.get(KEYS.workflow(id)))!) as WorkflowState;
    record.status = 'completed';
    record.result = ANOTHER_WRITERS_RESULT;
    await run.refusing.base.put(KEYS.workflow(id), encode(record));

    const outcome = await settleRunFromStoredRecord(
      internals,
      id,
      createTerminationCallbacks(engine),
      captured,
    );

    expect(outcome).toBe('settled');
    expect(internals.resultResolvers.get(id)).toBe(registered);
    registered.workflowExecutionToken = captured.workflowExecutionToken;
  });

  it('announces nothing for an unstamped record of a run this engine did not hold', async () => {
    const id = 'unheld-unstamped';
    const run = await startParked(steps, id);
    await using engine = run.engine;
    const internals = getInternals(engine);
    const captured = { ...captureTerminatedRun(internals, id), attempt: undefined };
    const completions: unknown[] = [];
    engine.addEventListener(WorkflowCompletedEvent.type, (event) => completions.push(event));
    const record = decode((await run.refusing.base.get(KEYS.workflow(id)))!) as WorkflowState;
    record.status = 'completed';
    record.result = ANOTHER_WRITERS_RESULT;
    await run.refusing.base.put(KEYS.workflow(id), encode(record));

    await settleRunFromStoredRecord(internals, id, createTerminationCallbacks(engine), captured);

    expect(await settlementOf(run.result)).toEqual({
      kind: 'value',
      value: ANOTHER_WRITERS_RESULT,
    });
    expect(completions).toEqual([]);
  });

  it('leaves a waiter a terminated run is holding back for its in-flight activity', async () => {
    const id = 'held-for-activity';
    const run = await startParked(steps, id);
    await using engine = run.engine;
    const internals = getInternals(engine);
    const waiter = internals.resultResolvers.get(id)!;
    const captured = captureTerminatedRun(internals, id);
    internals.pendingTerminalSettlements.add({
      workflowId: id,
      workflowExecutionToken: captured.workflowExecutionToken,
      terminalError: new Error('held'),
      turn: Promise.resolve(),
      waiter,
    } as never);

    const outcome = await settleRunFromStoredRecord(
      internals,
      id,
      {} as TerminationCallbacks,
      captured,
    );

    expect(outcome).toBe('open');
    expect(internals.resultResolvers.get(id)).toBe(waiter);
    internals.pendingTerminalSettlements.clear();
  });
});
