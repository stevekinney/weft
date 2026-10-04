/**
 * A checkpoint commit that loses its compare-and-swap race abandons the execution attempt that
 * began the commit, and only that attempt.
 *
 * The loss reaches the engine late: the commit awaits a classification read before it rejects
 * with `WorkflowCheckpointConflictError`, and the error names the generation by its execution
 * token. The same engine can suspend and resume that generation inside the read, which starts a
 * new attempt that carries the very same token, so a token alone cannot tell the attempt that lost
 * from the healthy one that replaced it. `persistCheckpointAbandoningOnConflict` therefore binds
 * the abandonment to the attempt the engine held when the persist began, the way
 * `staleFailureGuard` binds a terminal failure to the attempt it began under.
 *
 * Each cell drives the production wrapper with a persist whose rejection the test releases by
 * hand, which is the window the classification read opens in `throwCheckpointCommitLoss`.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS, type Storage } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  createDeferred,
  waitForCondition,
  waitForever,
  yieldToEventLoop,
} from '../../testing/fake-timers.test-support.ts';
import { decode, encode } from '../codec/api.ts';
import { workflow, type Checkpoint } from '../types.ts';
import { persistCheckpointForDataOperation } from './callback-checkpoint-persistence.ts';
import { persistCheckpointForEngine } from './callback-creators.ts';
import { adoptLaunchCheckpoint } from './checkpoint-commit-snapshots.ts';
import { persistCheckpointAbandoningOnConflict } from './checkpoint-conflict-abandon.ts';
import { WorkflowCheckpointConflictError } from './checkpoint-conflict-error.ts';
import {
  collectConflictWarnings,
  interceptConflictWarnings,
  parkedOnSignal,
  rejectionOrPending,
  tokenOf,
  WRITE_METHODS,
  writeOperations,
} from './checkpoint-conflict.test-support.ts';
import {
  abandonedExecutionAttemptCount,
  currentExecutionAttempt,
  isGenerationAbandoned,
  isHeldGenerationAbandoned,
} from './execution-attempts.ts';
import { Engine } from './index.ts';
import { getInternals, type EngineInternals } from './internals.ts';

/** Which generation the run under test holds: one with an execution token, or one from before them. */
const GENERATIONS = [
  { label: 'token-bearing generation', preToken: false },
  { label: 'pre-token generation', preToken: true },
] as const;

/**
 * Start a persist through the production wrapper for `workflowId`, with the rejection released by
 * the returned `loseWith`, which also waits one event-loop turn so an operator warning the loss
 * would emit has been delivered. The wrapper's own result is swallowed here: the caller's view of
 * the rejection is not what these cells are about.
 */
function persistInFlight(internals: EngineInternals, workflowId: string) {
  const loss = createDeferred();
  const persisted = persistCheckpointAbandoningOnConflict(
    internals,
    workflowId,
    () => loss.promise,
  );
  const settled = persisted.catch(() => {});
  return {
    loseWith: async (error: unknown): Promise<void> => {
      loss.reject(error);
      await settled;
      await yieldToEventLoop();
    },
  };
}

/** Start a run parked on its signal, and make it a pre-token run when `preToken` is set. */
async function startParkedRun(id: string, preToken: boolean) {
  const storage = new MemoryStorage();
  const engine = await Engine.create({
    storage,
    recover: false,
    workflows: { [id]: parkedOnSignal(id) },
  });
  const internals = getInternals(engine);
  const handle = await engine.start(id, null, { id });
  await waitForCondition(() => internals.parkedInlineWorkflows.has(id), {
    label: `${id} parked on its signal`,
  });
  const token = tokenOf(internals, id);
  if (preToken) {
    // A run recovered from before tokens existed: stored without one, and launched by this
    // engine through its launch path with a checkpoint that has none.
    for (const key of [KEYS.workflow(id), KEYS.checkpoint(id)]) {
      const record = { ...(decode((await storage.get(key))!) as Record<string, unknown>) };
      delete record['workflowExecutionToken'];
      await storage.put(key, encode(record));
    }
    const legacyCheckpoint = { ...internals.checkpoints.get(id)! };
    delete legacyCheckpoint.workflowExecutionToken;
    adoptLaunchCheckpoint(internals, id, legacyCheckpoint);
  }
  return {
    engine,
    internals,
    handle,
    token: preToken ? undefined : token,
    attempt: currentExecutionAttempt(internals, id),
  };
}

interceptConflictWarnings();

describe('a late checkpoint conflict binds to the attempt that began the commit', () => {
  for (const { label, preToken } of GENERATIONS) {
    describe(label, () => {
      it('leaves a relaunched attempt of the same generation healthy', async () => {
        const id = `relaunched-${String(preToken)}`;
        const run = await startParkedRun(id, preToken);
        const warning = collectConflictWarnings();
        try {
          const commit = persistInFlight(run.internals, id);

          // The classification read is still pending when this engine suspends the run and
          // resumes the very same generation, which begins a new attempt with the same token.
          await run.engine.suspend(id);
          const resumed = await run.engine.resume(id);
          const relaunched = currentExecutionAttempt(run.internals, id);
          expect(relaunched).not.toBe(run.attempt);
          expect(relaunched?.workflowExecutionToken).toBe(run.token);
          const pending = resumed.result();
          expect(await rejectionOrPending(pending)).toBe('pending');

          await commit.loseWith(
            new WorkflowCheckpointConflictError(id, { workflowExecutionToken: run.token }),
          );

          expect(isHeldGenerationAbandoned(run.internals, id)).toBe(false);
          expect(isGenerationAbandoned(run.internals, id, run.token)).toBe(false);
          expect(abandonedExecutionAttemptCount(run.internals)).toBe(0);
          expect(currentExecutionAttempt(run.internals, id)).toBe(relaunched);
          expect(await rejectionOrPending(pending)).toBe('pending');
          expect(run.internals.resultResolvers.has(id)).toBe(true);
          expect(warning.warnings).toEqual([]);
        } finally {
          warning.stop();
          await run.engine[Symbol.asyncDispose]();
        }
      });

      it('still abandons the attempt the commit began under while it is the current one', async () => {
        const id = `current-${String(preToken)}`;
        const run = await startParkedRun(id, preToken);
        const warning = collectConflictWarnings();
        try {
          const pending = run.handle.result();
          // The rejection this cell expects lands before the assertion reads it.
          void pending.catch(() => {});
          const commit = persistInFlight(run.internals, id);

          await commit.loseWith(
            new WorkflowCheckpointConflictError(id, { workflowExecutionToken: run.token }),
          );

          expect(await rejectionOrPending(pending)).toBeInstanceOf(WorkflowCheckpointConflictError);
          await warning.received;
          expect(warning.warnings.map((warned) => warned.workflowId)).toEqual([id]);
          expect(isGenerationAbandoned(run.internals, id, run.token)).toBe(true);
          expect(abandonedExecutionAttemptCount(run.internals)).toBe(1);
        } finally {
          warning.stop();
          await run.engine[Symbol.asyncDispose]();
        }
      });

      it('still abandons the attempt a suspension kept when the commit began before it', async () => {
        const id = `suspended-${String(preToken)}`;
        const run = await startParkedRun(id, preToken);
        const warning = collectConflictWarnings();
        try {
          const pending = run.handle.result();
          // The rejection this cell expects lands before the assertion reads it.
          void pending.catch(() => {});
          const commit = persistInFlight(run.internals, id);

          await run.engine.suspend(id);
          expect(currentExecutionAttempt(run.internals, id)).toBe(run.attempt);

          await commit.loseWith(
            new WorkflowCheckpointConflictError(id, { workflowExecutionToken: run.token }),
          );

          expect(await rejectionOrPending(pending)).toBeInstanceOf(WorkflowCheckpointConflictError);
          await warning.received;
          expect(warning.warnings.map((warned) => warned.workflowId)).toEqual([id]);
          expect(isGenerationAbandoned(run.internals, id, run.token)).toBe(true);
          expect(currentExecutionAttempt(run.internals, id)).toBe(run.attempt);
        } finally {
          warning.stop();
          await run.engine[Symbol.asyncDispose]();
        }
      });

      it('leaves an attempt launched after a commit that began with none healthy', async () => {
        const id = `launched-later-${String(preToken)}`;
        await using engine = new Engine({ storage: new MemoryStorage() });
        const internals = getInternals(engine);
        const token = preToken ? undefined : 'generation-1';
        const warning = collectConflictWarnings();
        try {
          // The persist begins while this engine holds no attempt for the id, so the commit it
          // issues cannot belong to a generation this engine launched.
          expect(currentExecutionAttempt(internals, id)).toBeUndefined();
          const commit = persistInFlight(internals, id);
          adoptLaunchCheckpoint(internals, id, { workflowExecutionToken: token } as Checkpoint);

          await commit.loseWith(
            new WorkflowCheckpointConflictError(id, { workflowExecutionToken: token }),
          );

          expect(isHeldGenerationAbandoned(internals, id)).toBe(false);
          expect(abandonedExecutionAttemptCount(internals)).toBe(0);
          expect(warning.warnings).toEqual([]);
        } finally {
          warning.stop();
        }
      });
    });
  }
});

/**
 * Wrap `base` so the first checkpoint write for `workflowId` once `armed` lands behind a checkpoint
 * another writer just stored (the same checkpoint plus a field the loser does not know, so it still
 * decodes and a later resume can launch it), then hold the classification read that follows the
 * lost compare-and-swap until the test releases it.
 */
function losingStorageHoldingClassification(
  base: Storage,
  workflowId: string,
  armed: { value: boolean },
) {
  const checkpointKey = KEYS.checkpoint(workflowId);
  const reachedClassification = createDeferred();
  const releaseClassification = createDeferred();
  const state = { injected: false, held: false };
  const storage = new Proxy(base, {
    get(target, property) {
      const original: unknown = Reflect.get(target, property, target);
      if (typeof original !== 'function') return original;
      const name = String(property);
      if (name === 'get') {
        return async (key: string) => {
          if (state.injected && key === checkpointKey && !state.held) {
            state.held = true;
            reachedClassification.resolve();
            await releaseClassification.promise;
          }
          return original.call(target, key);
        };
      }
      if (!WRITE_METHODS.includes(name)) return original.bind(target);
      return async (...argumentsList: unknown[]) => {
        const writesCheckpoint =
          writeOperations(name, argumentsList)?.some(
            (operation) => operation.type === 'put' && operation.key === checkpointKey,
          ) === true;
        if (armed.value && !state.injected && writesCheckpoint) {
          state.injected = true;
          const stored = decode((await target.get(checkpointKey))!) as Record<string, unknown>;
          await target.put(checkpointKey, encode({ ...stored, advancedByAnotherWriter: true }));
        }
        return original.apply(target, argumentsList);
      };
    },
  });
  return {
    storage,
    reachedClassification: reachedClassification.promise,
    releaseClassification: () => releaseClassification.resolve(),
  };
}

const checkpointOperation = {
  type: 'archive',
  operationId: 'archive-op',
  key: 'snapshot',
  data: { hello: 'world' },
} as const;

/**
 * The two engine entry points into a checkpoint persist, each of which must hand the wrapper the
 * workflow it persists for. A wrapper handed any other id would capture and compare the wrong
 * attempt, and a late loss would again be judged by its token alone.
 */
describe('the production persist entry points capture the attempt they persist for', () => {
  it.each([
    ['engine checkpoint message', persistCheckpointForEngine],
    ['data operation', persistCheckpointForDataOperation],
  ] as const)(
    '%s: a loss reported after a relaunch leaves the relaunch healthy',
    async (_name, persist) => {
      const id = 'entry-point-relaunched';
      const armed = { value: false };
      const hold = losingStorageHoldingClassification(new MemoryStorage(), id, armed);
      const firstOutcome = createDeferred<{ outcome: Promise<unknown> }>();
      let launches = 0;
      const definition = workflow({ name: id }).execute(async function* (context) {
        launches += 1;
        if (launches === 1) {
          // The first launch persists once and never moves again: its commit loses, and its
          // rejection is released only after this engine suspended and resumed the run.
          armed.value = true;
          const outcome = persist(engine, context.workflowId, checkpointOperation).then(
            () => 'committed' as const,
            (error: unknown) => error,
          );
          firstOutcome.resolve({ outcome });
          await outcome;
          await waitForever();
        }
        return yield* context.waitForSignal<string>('go');
      });
      const engine = await Engine.create({
        storage: hold.storage,
        recover: false,
        workflows: { [id]: definition },
      });
      const internals = getInternals(engine);
      const warning = collectConflictWarnings();
      try {
        void engine.start(id, null, { id }).catch(() => {});
        const { outcome } = await firstOutcome.promise;
        await hold.reachedClassification;
        const attempt = currentExecutionAttempt(internals, id);
        const token = attempt?.workflowExecutionToken;
        expect(token).toBeDefined();

        await engine.suspend(id);
        const resumed = await engine.resume(id);
        await waitForCondition(() => internals.parkedInlineWorkflows.has(id), {
          label: `${id} parked on its signal after the relaunch`,
        });
        const relaunched = currentExecutionAttempt(internals, id);
        expect(relaunched).not.toBe(attempt);
        expect(relaunched?.workflowExecutionToken).toBe(token);
        const pending = resumed.result();
        expect(await rejectionOrPending(pending)).toBe('pending');

        hold.releaseClassification();
        expect(await outcome).toBeInstanceOf(WorkflowCheckpointConflictError);
        await yieldToEventLoop();

        expect(isHeldGenerationAbandoned(internals, id)).toBe(false);
        expect(currentExecutionAttempt(internals, id)).toBe(relaunched);
        expect(await rejectionOrPending(pending)).toBe('pending');
        expect(warning.warnings).toEqual([]);
      } finally {
        warning.stop();
        await engine[Symbol.asyncDispose]();
      }
    },
  );
});
