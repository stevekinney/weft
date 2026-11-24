/**
 * COR-2536: `engine.previewFork` (what a fork would keep and run again) and `engine.compare` (a fork
 * and its source aligned step by step).
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../../storage/keys.ts';
import { startAndSettle } from '../../testing/run-observation.test-support.ts';
import { decode, encode } from '../codec.ts';
import type { WorkflowContext, WorkflowState, WorkflowTimelineEntry } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { CompareRequiresForkError } from './compare-fork.ts';
import { WorkflowNotFoundError } from './errors.ts';
import { CompareWindowError } from './fork-timeline-alignment.ts';
import { Engine } from './index.ts';

const STEP_NAMES = ['alpha', 'bravo', 'charlie', 'delta', 'echo'] as const;

/** The error a promise rejected with. */
async function errorOf(promise: Promise<unknown>): Promise<Error> {
  const rejection = await rejectionOf(promise);
  if (!(rejection instanceof Error))
    throw new Error('Expected the promise to reject with an error');
  return rejection;
}

async function storeContents(storage: MemoryStorage): Promise<[string, string][]> {
  const entries: [string, string][] = [];
  for await (const [key, value] of storage.scan('')) {
    entries.push([key, Buffer.from(value).toString('base64')]);
  }
  return entries.toSorted(([left], [right]) => (left < right ? -1 : 1));
}

/** An engine holding a finished five-step run, `five`, whose steps are named activities. */
async function engineWithFiveSteps() {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  const executed: string[] = [];
  const activities = Object.fromEntries(
    STEP_NAMES.map((name) => [
      name,
      activity({
        name,
        execute: async (input?: unknown) => {
          executed.push(name);
          return `${name}:${JSON.stringify(input)}`;
        },
      }),
    ]),
  );
  engine.register(
    workflow({ name: 'five' })
      .activities(activities)
      .execute(async function* (ctx: WorkflowContext) {
        const results: string[] = [];
        for (const name of STEP_NAMES) {
          results.push(String(yield* ctx.run(activities[name] as never, { step: name })));
        }
        return results.join('|');
      }),
  );
  await startAndSettle(engine, 'five', null, 'five');
  executed.length = 0;
  return { engine, storage, executed };
}

describe('engine.previewFork', () => {
  it('answers the kept and rerun steps of a fork from step 3 and writes nothing', async () => {
    const { engine, storage, executed } = await engineWithFiveSteps();
    await using _engine = engine;
    const before = await storeContents(storage);

    const preview = await engine.previewFork('five', { fromStep: 3 });

    expect(preview).toMatchObject({
      dryRun: true,
      workflowId: 'five',
      forkPoint: 3,
      revisionWouldChange: false,
    });
    expect(preview.keptSteps.map((step) => [step.index, step.label])).toEqual([
      [0, 'alpha'],
      [1, 'bravo'],
    ]);
    expect(preview.rerunSteps.map((step) => [step.index, step.label])).toEqual([
      [2, 'charlie'],
      [3, 'delta'],
      [4, 'echo'],
    ]);
    expect(preview.keptSteps[0]).toMatchObject({ operationType: 'activity', status: 'completed' });
    expect(await storeContents(storage)).toEqual(before);
    expect(executed).toEqual([]);

    // The real fork does what the preview said: the rerun steps run, the kept ones do not.
    const fork = await engine.fork('five', { fromStep: 3 });
    await fork.result();
    expect(executed).toEqual(['charlie', 'delta', 'echo']);
  });

  it('forks from the latest checkpoint when no step is given', async () => {
    const { engine } = await engineWithFiveSteps();
    await using _engine = engine;

    const preview = await engine.previewFork('five');

    expect(preview.forkPoint).toBe(5);
    expect(preview.keptSteps).toHaveLength(4);
    expect(preview.rerunSteps.map((step) => step.label)).toEqual(['echo']);
  });

  it('is refused as the fork would be: an unknown run, an unknown step, an uninstalled revision', async () => {
    const { engine } = await engineWithFiveSteps();
    await using _engine = engine;

    const unknownRun = await errorOf(engine.previewFork('nothing'));
    expect(unknownRun.message).toContain('not found');
    const unknownStep = await errorOf(engine.previewFork('five', { fromStep: 99 }));
    expect(unknownStep.message).toContain('Checkpoint not found at step 99');
    const uninstalled = await errorOf(
      engine.previewFork('five', { revision: 'sha256:not-installed' }),
    );
    expect(uninstalled.name).toBe('WorkflowRevisionUnavailableError');
  });
});

describe('engine.compare', () => {
  it('aligns a fork with its source: shared steps before the fork point, each run on its own after', async () => {
    const { engine } = await engineWithFiveSteps();
    await using _engine = engine;
    const fork = await engine.fork('five', { fromStep: 3 });
    await fork.result();

    const comparison = await engine.compare(fork.id);

    expect(comparison).toMatchObject({
      workflowId: fork.id,
      sourceWorkflowId: 'five',
      forkPoint: 3,
    });
    expect(comparison.nextCursor).toBeUndefined();
    expect(comparison.steps.map((step) => [step.index, step.shared])).toEqual([
      [0, true],
      [1, true],
      [2, false],
      [3, false],
      [4, false],
    ]);
    const [alpha, , charlie] = comparison.steps;
    // A shared step carries the source's entry on both sides.
    expect(alpha?.source).toEqual({
      operationType: 'activity',
      label: 'alpha',
      status: 'completed',
      input: '{"step":"alpha"}',
      output: '"alpha:{\\"step\\":\\"alpha\\"}"',
    });
    expect(alpha?.fork).toEqual(alpha?.source);
    // A step after it has each run's own entry.
    expect(charlie?.source).toMatchObject({ label: 'charlie', status: 'completed' });
    expect(charlie?.fork).toMatchObject({
      operationType: 'activity',
      label: 'charlie',
      status: 'completed',
      input: '{"step":"charlie"}',
      output: '"charlie:{\\"step\\":\\"charlie\\"}"',
    });
  });

  it('leaves a side absent for a step the run has no entry for', async () => {
    const { engine } = await engineWithFiveSteps();
    await using _engine = engine;
    // A fork parked on a signal has not reached the steps after the one it waits on.
    engine.register(
      workflow({ name: 'gated' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.run(async () => 'first');
        yield* ctx.waitForSignal('go');
        return yield* ctx.run(async () => 'last');
      }),
    );
    const source = await engine.start('gated', null, { id: 'gated-source' });
    await engine.signal('gated-source', 'go', 'now');
    await source.result();
    const fork = await engine.fork('gated-source', { fromStep: 2 });

    const comparison = await engine.compare(fork.id);

    const unreached = comparison.steps.filter((step) => step.fork === undefined);
    for (const step of unreached) expect(step.shared).toBe(false);
    expect(comparison.steps.some((step) => step.source !== undefined)).toBe(true);
  });

  it('answers a fault with remediation for a run that is not a fork', async () => {
    const { engine } = await engineWithFiveSteps();
    await using _engine = engine;

    const refusal = await errorOf(engine.compare('five'));

    expect(refusal).toBeInstanceOf(CompareRequiresForkError);
    expect((refusal as CompareRequiresForkError).code).toBe('CompareRequiresForkError');
    expect((refusal as CompareRequiresForkError).remediation).toContain('weft.workflows.fork');
    expect(refusal.message).toContain((refusal as CompareRequiresForkError).remediation);
  });

  it('answers not-found for an unknown fork and for a fork whose source is gone', async () => {
    const { engine } = await engineWithFiveSteps();
    await using _engine = engine;
    expect(await rejectionOf(engine.compare('never-started'))).toBeInstanceOf(
      WorkflowNotFoundError,
    );

    const fork = await engine.fork('five', { fromStep: 3 });
    await fork.result();
    expect(await engine.purgeById('five')).toBe(true);

    const refusal = await errorOf(engine.compare(fork.id));
    expect(refusal).toBeInstanceOf(WorkflowNotFoundError);
    expect(refusal.message).toContain('five');
  });

  it('answers not-found for a fork whose source id now holds a replacement run', async () => {
    const { engine } = await engineWithFiveSteps();
    await using _engine = engine;
    const fork = await engine.fork('five', { fromStep: 3 });
    await fork.result();
    const forkState = await engine.get(fork.id);
    expect(forkState?.forkedFrom?.workflowExecutionToken).toBeString();
    const replacement = await engine.start('five', null, {
      id: 'five',
      onTerminalConflict: 'start-new',
    });
    await replacement.result();

    const refusal = await errorOf(engine.compare(fork.id));

    expect(refusal).toBeInstanceOf(WorkflowNotFoundError);
    expect(refusal.message).toContain('five');
  });

  it('keeps the steps a source fork inherited from its own parent, in a fork of a fork', async () => {
    const { engine } = await engineWithFiveSteps();
    await using _engine = engine;
    const first = await engine.fork('five', { fromStep: 3 });
    await first.result();
    const second = await engine.fork(first.id);
    await second.result();

    const comparison = await engine.compare(second.id);
    const preview = await engine.previewFork(first.id);

    // The first fork runs steps 2 to 4 itself and holds 0 and 1 from `five`, so the second fork's
    // source has all five steps, and the two before the first fork's point are not lost.
    expect(comparison.steps.map((step) => step.index)).toEqual([0, 1, 2, 3, 4]);
    expect(comparison.steps[0]).toMatchObject({ shared: true, source: { label: 'alpha' } });
    expect(comparison.steps[1]).toMatchObject({ shared: true, source: { label: 'bravo' } });
    expect(
      [...preview.keptSteps, ...preview.rerunSteps].map((step) => [step.index, step.label]),
    ).toEqual([
      [0, 'alpha'],
      [1, 'bravo'],
      [2, 'charlie'],
      [3, 'delta'],
      [4, 'echo'],
    ]);
  });

  it('still compares a fork recorded before its lineage named the source run', async () => {
    const { engine, storage } = await engineWithFiveSteps();
    await using _engine = engine;
    const fork = await engine.fork('five', { fromStep: 3 });
    await fork.result();
    const stored = decode((await storage.get(KEYS.workflow(fork.id)))!) as WorkflowState;
    expect(stored.forkedFrom?.workflowExecutionToken).toBeString();
    delete stored.forkedFrom?.workflowExecutionToken;
    await storage.put(KEYS.workflow(fork.id), encode(stored));

    const comparison = await engine.compare(fork.id);

    expect(comparison).toMatchObject({ workflowId: fork.id, sourceWorkflowId: 'five' });
  });

  it('pages a 250-step comparison by step, 100 to a page, with a cursor', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    engine.register(
      workflow({ name: 'long' }).execute(async function* (ctx: WorkflowContext) {
        for (let index = 0; index < 250; index += 1) {
          yield* ctx.run(async () => index);
        }
        return 'done';
      }),
    );
    await startAndSettle(engine, 'long', null, 'long');
    // Checkpoint history is pruned, so a long run can only be forked from its recent checkpoints:
    // the latest one, which keeps 249 of the 250 steps.
    const fork = await engine.fork('long');
    await fork.result();

    const first = await engine.compare(fork.id);
    expect(first.steps).toHaveLength(100);
    expect(first.steps[0]?.index).toBe(0);
    expect(first.steps.at(-1)?.index).toBe(99);
    expect(first.nextCursor).toBeString();

    const second = await engine.compare(fork.id, { cursor: first.nextCursor as string });
    expect(second.steps).toHaveLength(100);
    expect(second.steps[0]?.index).toBe(100);
    expect(second.steps.at(-1)?.index).toBe(199);
    expect(second.nextCursor).toBeString();

    const third = await engine.compare(fork.id, { cursor: second.nextCursor as string });
    expect(third.steps).toHaveLength(50);
    expect(third.steps.at(-1)?.index).toBe(249);
    expect(third.nextCursor).toBeUndefined();

    // Steps before the fork point are shared, and a page does not leak into the next.
    const all = [...first.steps, ...second.steps, ...third.steps];
    expect(new Set(all.map((step) => step.index)).size).toBe(250);
    expect(all.filter((step) => step.shared).length).toBe(249);
    expect(all.every((step) => step.source !== undefined && step.fork !== undefined)).toBe(true);
  });

  it('takes the page size from limit, and refuses a limit or cursor it cannot use', async () => {
    const { engine } = await engineWithFiveSteps();
    await using _engine = engine;
    const fork = await engine.fork('five', { fromStep: 3 });
    await fork.result();

    const page = await engine.compare(fork.id, { limit: 2 });
    expect(page.steps.map((step) => step.index)).toEqual([0, 1]);
    expect(page.nextCursor).toBe('step:1');

    for (const limit of [0, -1, 1.5, 1001]) {
      expect(await rejectionOf(engine.compare(fork.id, { limit }))).toBeInstanceOf(
        CompareWindowError,
      );
    }
    for (const cursor of ['', 'step:', 'step:-1', 'page:2', 'step:1;drop']) {
      expect(await rejectionOf(engine.compare(fork.id, { cursor }))).toBeInstanceOf(
        CompareWindowError,
      );
    }
  });

  it('redacts a payload field the way the timeline read does', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    engine.register(
      workflow({ name: 'login' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.run(async (credentials: unknown) => credentials, {
          user: 'ada',
          password: 'hunter2',
        });
        yield* ctx.run(async () => 'second');
        return 'ok';
      }),
    );
    await startAndSettle(engine, 'login', null, 'login');
    // A record written by an engine that stored the field unredacted: the timeline read redacts it
    // anyway, and compare reads the timeline.
    const key = KEYS.timeline('login', 1);
    const stored = decode((await storage.get(key)) as Uint8Array) as WorkflowTimelineEntry;
    await storage.put(
      key,
      encode({ ...stored, inputSummary: '{"user":"ada","password":"hunter2"}' }),
    );
    const timeline = await engine.getTimeline('login');
    expect(timeline[0]?.inputSummary).not.toContain('hunter2');
    const fork = await engine.fork('login', { fromStep: 2 });
    await fork.result();

    const comparison = await engine.compare(fork.id);

    const [first] = comparison.steps;
    expect(first?.shared).toBe(true);
    for (const side of [first?.source, first?.fork]) {
      expect(side?.input).toContain('[REDACTED]');
      expect(side?.input).toContain('ada');
      expect(side?.input).not.toContain('hunter2');
    }
    expect(JSON.stringify(comparison)).not.toContain('hunter2');
  });
});
