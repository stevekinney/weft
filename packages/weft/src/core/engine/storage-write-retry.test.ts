/**
 * COR-1626: a storage write the engine needs is retried in process, a bounded number of times,
 * and a run whose write storage keeps refusing ends visibly instead of staying `running` with
 * `result()` pending until the next boot.
 *
 * Each run parks on a signal first and the refusals start after it has parked, so what is refused
 * is the write a step makes, not the run's creation. The waits between attempts are shortened
 * through `storageWriteRetryDelaysForTesting`; the attempts are counted at the storage.
 */
import { describe, expect, it } from 'bun:test';

import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../../storage/keys.ts';
import { yieldToPortableEventLoop } from '../../testing/event-loop.ts';
import { Engine } from '../engine.ts';
import { WorkflowFailedEvent } from '../events.ts';
import { CheckpointCommitFailedError } from './checkpoint-commit-failed-error.ts';
import { WorkflowCheckpointConflictError } from './checkpoint-conflict-error.ts';
import { abandonedExecutionAttemptCount } from './execution-attempts.ts';
import { WorkflowHandle } from './handles.ts';
import { getInternals } from './internals.ts';
import { EngineDeposedError } from './lease-errors.ts';
import {
  putsCheckpoint,
  putsWorkflowStatus,
  touchesEventLog,
} from './storage-write-refusal.test-support.ts';
import {
  ATTEMPTS,
  failsAfterSignal,
  readState,
  type Run,
  startParked,
  statusOf,
  steps,
} from './storage-write-retry.test-support.ts';
import { STORAGE_WRITE_RETRY_DELAYS_MS } from './termination/terminal-fence.ts';

describe('the retry bound', () => {
  it('waits 50, 100, 200 and 400 ms between five attempts by default', () => {
    expect(STORAGE_WRITE_RETRY_DELAYS_MS).toEqual([50, 100, 200, 400]);
  });
});

describe('a transient refusal', () => {
  it('is absorbed: the step commits on the third attempt and the run completes', async () => {
    const run = await startParked(steps, 'transient');
    await using engine = run.engine;
    const failures: unknown[] = [];
    engine.addEventListener(WorkflowFailedEvent.type, (event) => failures.push(event));
    run.refusing.refuse({ matches: putsCheckpoint('transient'), times: 2 });

    await engine.signal('transient', 'go', 'x');

    expect(await run.result).toBe('x:a:b');
    expect(failures).toEqual([]);
    const batches = run.refusing.attemptsMatching(putsCheckpoint('transient'));
    expect(batches.slice(0, 3).map((attempt) => attempt.outcome)).toEqual([
      'refused',
      'refused',
      'passed',
    ]);
    // The same batch each time: the retries resend what the first attempt built.
    const sentBytes = batches.slice(0, 3).map((attempt) => {
      const put = attempt.operations.find(
        (operation) => operation.type === 'put' && operation.key === KEYS.checkpoint('transient'),
      );
      return put?.type === 'put' ? [...put.value].join(',') : undefined;
    });
    expect(new Set(sentBytes).size).toBe(1);
  });
});

describe('a persistent refusal of the checkpoint batch', () => {
  for (const [label, matches] of [
    ['the checkpoint record', putsCheckpoint('persistent-checkpoint')],
    ['the event log', touchesEventLog('persistent-checkpoint')],
  ] as const) {
    it(`ends the run as a system failure when ${label} is refused (${String(ATTEMPTS)} attempts)`, async () => {
      const run = await startParked(steps, 'persistent-checkpoint');
      await using engine = run.engine;
      run.refusing.refuse({ matches });

      await engine.signal('persistent-checkpoint', 'go', 'x');
      const reason = await rejectionOf(run.result);

      expect(reason).toBeInstanceOf(CheckpointCommitFailedError);
      expect((reason as CheckpointCommitFailedError).write).toBe('checkpoint');
      expect((reason as CheckpointCommitFailedError).attempts).toBe(ATTEMPTS);
      expect(run.refusing.attemptsMatching(matches)).toHaveLength(ATTEMPTS);
      const state = await readState(run.refusing, 'persistent-checkpoint');
      expect(state.status).toBe('failed');
      expect(state.failureCategory).toBe('system');
    });
  }
});

describe('a refused completion write', () => {
  it('ends the run as a system failure and writes the failure', async () => {
    const run = await startParked(steps, 'refused-completion');
    await using engine = run.engine;
    run.refusing.refuse({ matches: putsWorkflowStatus('refused-completion', 'completed') });

    await engine.signal('refused-completion', 'go', 'x');
    const reason = await rejectionOf(run.result);

    expect(reason).toBeInstanceOf(CheckpointCommitFailedError);
    expect((reason as CheckpointCommitFailedError).write).toBe('completion');
    expect(
      run.refusing.attemptsMatching(putsWorkflowStatus('refused-completion', 'completed')),
    ).toHaveLength(ATTEMPTS);
    const state = await readState(run.refusing, 'refused-completion');
    expect(state.status).toBe('failed');
    expect(state.failureCategory).toBe('system');
  });
});

describe('a refused failure write', () => {
  async function refuseEverything(workflowId: string): Promise<Run> {
    const run = await startParked(steps, workflowId);
    run.refusing.refuse({ matches: putsCheckpoint(workflowId) });
    run.refusing.refuse({ matches: putsWorkflowStatus(workflowId, 'any') });
    await run.engine.signal(workflowId, 'go', 'x');
    return run;
  }

  it('abandons the run: result() rejects, the record stays running, and a new engine recovers it', async () => {
    const run = await refuseEverything('refused-failure');
    await using engine = run.engine;

    const reason = await rejectionOf(run.result);

    expect(reason).toBeInstanceOf(CheckpointCommitFailedError);
    expect(run.refusing.attemptsMatching(putsCheckpoint('refused-failure'))).toHaveLength(ATTEMPTS);
    expect(
      run.refusing.attemptsMatching(putsWorkflowStatus('refused-failure', 'failed')),
    ).toHaveLength(ATTEMPTS);
    expect(await statusOf(run.refusing, 'refused-failure')).toBe('running');
    expect(abandonedExecutionAttemptCount(getInternals(engine))).toBe(1);

    // The refusals are lifted and a new engine over the same storage recovers the run from its
    // last committed checkpoint. The signal the failed step had consumed was never committed as
    // consumed, so the recovered run takes it and completes.
    run.refusing.disarm();
    await using recovering = new Engine({ storage: run.refusing.storage });
    recovering.register(steps);
    await recovering.recoverAll();
    expect(await recovering.getHandle('refused-failure').result()).toBe('x:a:b');
  });

  it('rejects a result() requested after the abandon with the same error, not a conflict', async () => {
    const run = await refuseEverything('late-result');
    await using engine = run.engine;
    await rejectionOf(run.result);

    const lateHandle = new WorkflowHandle('late-result', getInternals(engine).engine);
    const late = await rejectionOf(lateHandle.result());

    expect(late).toBeInstanceOf(CheckpointCommitFailedError);
    expect(late).not.toBeInstanceOf(WorkflowCheckpointConflictError);
  });

  it('does not retry a failure write that fails for any reason but a refusal, and leaves the run to the next boot', async () => {
    const run = await startParked(steps, 'deposed-failure');
    await using engine = run.engine;
    run.refusing.refuse({ matches: putsCheckpoint('deposed-failure') });
    // The failure write throws a deposition, which is not a refusal: attempted once, never retried.
    run.refusing.refuse({
      matches: putsWorkflowStatus('deposed-failure', 'failed'),
      error: () => new EngineDeposedError(),
    });

    await engine.signal('deposed-failure', 'go', 'x');
    await run.refusing.whenAttempts(1, putsWorkflowStatus('deposed-failure', 'failed'));
    // load-proof: negative window: asserts the deposed engine makes no second failed-status write; load can only delay a write, never create one
    await yieldToPortableEventLoop();

    expect(
      run.refusing.attemptsMatching(putsWorkflowStatus('deposed-failure', 'failed')),
    ).toHaveLength(1);
    expect(await statusOf(run.refusing, 'deposed-failure')).toBe('running');
    expect(abandonedExecutionAttemptCount(getInternals(engine))).toBe(0);
  });

  it('abandons a run whose own failure is refused: a failed message is not retried as a checkpoint', async () => {
    const run = await startParked(failsAfterSignal, 'refused-body-failure');
    await using engine = run.engine;
    run.refusing.refuse({ matches: putsWorkflowStatus('refused-body-failure', 'failed') });

    await engine.signal('refused-body-failure', 'go', 'x');
    const reason = await rejectionOf(run.result);

    expect(reason).toBeInstanceOf(CheckpointCommitFailedError);
    expect((reason as CheckpointCommitFailedError).write).toBe('failure');
    expect(
      run.refusing.attemptsMatching(putsWorkflowStatus('refused-body-failure', 'failed')),
    ).toHaveLength(ATTEMPTS);
    expect(await statusOf(run.refusing, 'refused-body-failure')).toBe('running');
  });
});

describe('a write that landed but reported failure', () => {
  it('is not mistaken for a conflict when it is the checkpoint batch', async () => {
    const run = await startParked(steps, 'landed-checkpoint');
    await using engine = run.engine;
    run.refusing.refuse({
      matches: putsCheckpoint('landed-checkpoint'),
      mode: 'land-then-throw',
      times: 1,
    });

    await engine.signal('landed-checkpoint', 'go', 'x');

    expect(await run.result).toBe('x:a:b');
    expect(await statusOf(run.refusing, 'landed-checkpoint')).toBe('completed');
    expect(abandonedExecutionAttemptCount(getInternals(engine))).toBe(0);
  });

  it('is not mistaken for a conflict when it is the completion write', async () => {
    const run = await startParked(steps, 'landed-completion');
    await using engine = run.engine;
    run.refusing.refuse({
      matches: putsWorkflowStatus('landed-completion', 'completed'),
      mode: 'land-then-throw',
      times: 1,
    });

    await engine.signal('landed-completion', 'go', 'x');

    expect(await run.result).toBe('x:a:b');
    expect(await statusOf(run.refusing, 'landed-completion')).toBe('completed');
  });

  it('is not mistaken for a conflict when it is the failure write', async () => {
    const run = await startParked(failsAfterSignal, 'landed-failure');
    await using engine = run.engine;
    run.refusing.refuse({
      matches: putsWorkflowStatus('landed-failure', 'failed'),
      mode: 'land-then-throw',
      times: 1,
    });

    await engine.signal('landed-failure', 'go', 'x');

    const reason = await rejectionOf(run.result);
    expect(reason).toBeInstanceOf(Error);
    expect((reason as Error).message).toBe('the workflow body failed');
    const state = await readState(run.refusing, 'landed-failure');
    expect(state.status).toBe('failed');
    expect(state.error).toBe('the workflow body failed');
  });
});
