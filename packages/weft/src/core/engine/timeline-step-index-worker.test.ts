/**
 * COR-1988, worker execution. The worker counts durable steps (`replayState.nextStepIndex`) and
 * reports the step it is parked on as `pendingStepIndex` on every `checkpoint` message, because the
 * host numbers checkpoints and cannot recover that count. A timeline entry carries it as
 * `stepIndex`, the value a `ctx.log` line's `step` carries.
 *
 * Worker mode runs activities, signal waits and `getVersion` only: `ctx.all`, `ctx.runAll`,
 * `ctx.speculate`, `ctx.memo` and session state need the inline context, so those cases are
 * covered by `timeline-step-index.test.ts`. The host does not retry a worker's activity either: a
 * worker body that wants a retry yields the activity again, which is a step of its own.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { waitUntil } from "../../../test-support/embedded/testing/src/wait-until.ts";

import { Engine, ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING } from '../engine.ts';
import { activity } from '../types/activity.ts';
import { workflow } from '../types/workflow-function.ts';
import { createWorkflowLogStore } from '../workflow-log-store.ts';

const workerUrl = new URL('../../workers/test-timeline-step-worker.ts', import.meta.url);

let flakyFailuresLeft = 0;
const noop = activity({ name: 'noop', execute: async (input: string) => input });
const flaky = activity({
  name: 'flaky',
  execute: async (_input: null) => {
    if (flakyFailuresLeft > 0) {
      flakyFailuresLeft -= 1;
      throw new Error('flaky failure');
    }
    return 'ok';
  },
});

const engines: Engine[] = [];

function createWorkerEngine(storage = new MemoryStorage()): Engine {
  const logs = createWorkflowLogStore(storage);
  const engine = new Engine({
    storage,
    onLog: logs.sink,
    workflowLogs: logs,
    workflowExecutionMode: 'worker',
    workerExecution: { workerUrl, poolSize: 1, workflowTurnTimeoutMs: 30_000 },
  });
  // The bodies run in the worker; the host only needs the names and activities.
  for (const name of ['step-basic', 'step-signal-resume', 'step-retry', 'step-version']) {
    engine.register(
      workflow({ name })
        .activities({ noop, flaky })
        .execute(async function* () {
          return undefined;
        }),
    );
  }
  engines.push(engine);
  return engine;
}

/**
 * The timeline as `[operationType, stepIndex]` pairs, with back-to-back entries that agree on both
 * collapsed: a signal wait is recorded again each time the run is relaunched to wait on it, which
 * is not under test, but a repeat that disagrees about its `stepIndex` is.
 */
async function entriesOf(engine: Engine, id: string): Promise<Array<[string, number | undefined]>> {
  const pairs: Array<[string, number | undefined]> = [];
  for (const entry of await engine.getTimeline(id)) {
    const previous = pairs.at(-1);
    if (
      previous !== undefined &&
      previous[0] === 'wait-signal' &&
      previous[0] === entry.operationType &&
      previous[1] === entry.stepIndex
    ) {
      continue;
    }
    pairs.push([entry.operationType, entry.stepIndex]);
  }
  return pairs;
}

async function linesOf(engine: Engine, id: string): Promise<Array<[string, number | null]>> {
  const { lines } = await engine.getLogs(id);
  return lines.map((line) => [line.message, line.step]);
}

async function finish(engine: Engine, id: string): Promise<void> {
  await waitUntil(
    async () => {
      const state = await engine.get(id);
      return state?.status === 'completed';
    },
    { message: `${id} completes` },
  );
}

describe('timeline entry stepIndex in worker execution', () => {
  afterEach(async () => {
    await Promise.all(engines.splice(0).map(async (engine) => engine.shutdown()));
    flakyFailuresLeft = 0;
  });

  it('matches the step of the line logged in front of its operation', async () => {
    const engine = createWorkerEngine();
    const handle = await engine.start('step-basic', null, { id: 'basic-1' });
    await handle.result();

    const timeline = await engine.getTimeline('basic-1');
    const { lines } = await engine.getLogs('basic-1');
    expect(lines[0]?.step).toBe(0);
    expect(timeline[0]?.stepIndex).toBe(lines[0]?.step ?? -1);
    expect(await entriesOf(engine, 'basic-1')).toEqual([['activity', 0]]);
    expect(await linesOf(engine, 'basic-1')).toEqual([
      ['before-activity', 0],
      ['after-activity', 1],
    ]);
  });

  it('survives a signal resume', async () => {
    const engine = createWorkerEngine();
    const handle = await engine.start('step-signal-resume', null, { id: 'resume-1' });
    await engine[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING]('resume-1');
    await engine.signal('resume-1', 'go', 'v');
    await handle.result();

    expect(await entriesOf(engine, 'resume-1')).toEqual([
      ['activity', 0],
      ['activity', 1],
      ['wait-signal', 2],
      ['activity', 3],
    ]);
    expect(await linesOf(engine, 'resume-1')).toEqual([
      ['before-first', 0],
      ['before-second', 1],
      ['before-wait', 2],
      ['after-wait', 3],
      ['end', 4],
    ]);
  });

  it('survives a recovered run that resumes from a parked signal wait', async () => {
    const storage = new MemoryStorage();
    const first = createWorkerEngine(storage);
    await first.start('step-signal-resume', null, { id: 'recover-1' });
    await first[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING]('recover-1');
    first[Symbol.dispose]();

    const recovered = createWorkerEngine(storage);
    await recovered.recoverAll();
    await recovered[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING]('recover-1');
    await recovered.signal('recover-1', 'go', 'v');
    await finish(recovered, 'recover-1');

    expect(await entriesOf(recovered, 'recover-1')).toEqual([
      ['activity', 0],
      ['activity', 1],
      ['wait-signal', 2],
      ['activity', 3],
    ]);
    expect(await linesOf(recovered, 'recover-1')).toEqual([
      ['before-first', 0],
      ['before-second', 1],
      ['before-wait', 2],
      ['after-wait', 3],
      ['end', 4],
    ]);
  });

  it('gives a retry the next step, because a worker body retries by yielding the activity again', async () => {
    flakyFailuresLeft = 1;
    const engine = createWorkerEngine();
    const handle = await engine.start('step-retry', null, { id: 'retry-1' });
    await handle.result();

    expect(await entriesOf(engine, 'retry-1')).toEqual([
      ['activity', 0],
      ['activity', 1],
      ['activity', 2],
    ]);
    expect(await linesOf(engine, 'retry-1')).toEqual([
      ['before-flaky', 0],
      ['retrying', 1],
      ['after-flaky', 2],
    ]);
  });

  it('counts a step that writes no checkpoint, so the step count parts from the checkpoint count', async () => {
    const engine = createWorkerEngine();
    const handle = await engine.start('step-version', null, { id: 'version-1' });
    await handle.result();

    expect(await entriesOf(engine, 'version-1')).toEqual([
      ['get-version', 0],
      ['activity', 2],
    ]);
    expect(await linesOf(engine, 'version-1')).toEqual([
      ['before-pin', 0],
      ['before-repeat', 1],
      ['before-activity', 2],
      ['end', 3],
    ]);
  });

  it('gives a fork the step index of the lines it logs', async () => {
    const engine = createWorkerEngine();
    await engine.start('step-signal-resume', null, { id: 'source' });
    await engine[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING]('source');
    const fork = await engine.fork('source');
    await engine[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](fork.id);
    await engine.signal(fork.id, 'go', 'v');
    await fork.result();

    // The fork replays the source's two activities from their results and parks on the same wait.
    expect(await entriesOf(engine, fork.id)).toEqual([
      ['wait-signal', 2],
      ['activity', 3],
    ]);
    expect(await linesOf(engine, fork.id)).toEqual([
      ['before-wait', 2],
      ['after-wait', 3],
      ['end', 4],
    ]);
  });
});
