/**
 * COR-2238: a rejected review ends the run as `failed` with the code `review-rejected`. The outcome
 * matrix is the table below; every row is a payload a wait receives crossed with whether the host
 * recognises a rejection. Weft only asks the host's `isRejection`: what a rejection looks like is
 * the host's to say.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { waitForCondition } from "../../test-support/embedded/testing/src/fake-timers.ts";
import { throwingRejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { waitUntil } from "../../test-support/embedded/testing/src/wait-until.ts";

import { Engine } from '../core/engine/index.ts';
import { WorkflowDocumentReviewRejectedError } from './document-errors.ts';
import type { DocumentWorkflowHost } from './document.ts';
import { registerWorkflowDocuments } from './register.ts';

const ran: string[] = [];

const rejects = (payload: unknown): boolean =>
  typeof payload === 'object' && payload !== null && Reflect.get(payload, 'rejected') === true;

const activities: DocumentWorkflowHost['activities'] = {
  after: ({ signal }) => {
    ran.push('after');
    return { after: true, signal };
  },
  items: () => ({ items: [1, 2] }),
};

const hostWithHook: DocumentWorkflowHost = {
  activities,
  triggerKinds: { manual: () => undefined },
  isRejection: rejects,
};
const hostWithoutHook: DocumentWorkflowHost = {
  activities,
  triggerKinds: { manual: () => undefined },
};

const document = (name: string, review: readonly Record<string, unknown>[] = []) => ({
  name,
  trigger: { kind: 'manual' },
  steps: [
    { kind: 'await-signal', signal: 'decision' },
    ...review,
    { kind: 'activity', handler: 'after' },
  ],
});

async function waitForParked(engine: Engine, id: string): Promise<void> {
  await waitForCondition(
    async () => {
      const timeline = await engine.getTimeline(id);
      return timeline.some((entry) => entry.operationType === 'wait-signal');
    },
    { label: `${id} parked on its signal` },
  );
}

type Row = {
  readonly name: string;
  readonly host: DocumentWorkflowHost;
  readonly payload: unknown;
  readonly outcome: 'continues' | 'rejected';
};

const rows: readonly Row[] = [
  { name: 'approval payload', host: hostWithHook, payload: { note: 'ok' }, outcome: 'continues' },
  { name: 'null payload', host: hostWithHook, payload: null, outcome: 'continues' },
  { name: 'string payload', host: hostWithHook, payload: 'rejected', outcome: 'continues' },
  {
    name: 'a denial the host does not call a rejection',
    host: hostWithHook,
    payload: { denied: true, reason: 'change it' },
    outcome: 'continues',
  },
  {
    name: 'a flag set to false',
    host: hostWithHook,
    payload: { rejected: false },
    outcome: 'continues',
  },
  {
    name: 'a rejection payload',
    host: hostWithHook,
    payload: { rejected: true, reason: 'no' },
    outcome: 'rejected',
  },
  {
    name: 'a rejection payload on a host with no hook',
    host: hostWithoutHook,
    payload: { rejected: true, reason: 'no' },
    outcome: 'continues',
  },
];

describe('a rejected review (COR-2238)', () => {
  // Matrix row R6 (a crash after the rejection payload was checkpointed but before the run settled)
  // has its own tests below, "a crash after the rejection was read". `runAwaitSignal` asks
  // `isRejection` of the value the wait returned and throws on the same line, before the generator
  // yields another operation, so no later step is requested on the live run, and a replay of the
  // payload reaches the same line.
  for (const [index, row] of rows.entries()) {
    it(`${row.outcome === 'rejected' ? 'fails the run' : 'continues'} for ${row.name}`, async () => {
      ran.length = 0;
      const name = `rejection-row-${String(index)}`;
      await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
      await registerWorkflowDocuments(engine, row.host, { active: [document(name)] });
      const run = await engine.start(name, null, { id: `${name}-run` });
      await run.signal('decision', row.payload);

      if (row.outcome === 'continues') {
        expect(await run.result()).toEqual({ after: true, signal: row.payload });
        expect(ran).toEqual(['after']);
        const finished = await engine.get(run.id);
        expect(finished?.status).toBe('completed');
        return;
      }
      expect(await throwingRejectionOf(run.result())).toThrow('review-rejected');
      expect(ran).toEqual([]);
      const state = await engine.get(run.id);
      expect(state?.status).toBe('failed');
      expect(state?.error).toBe('review-rejected');
      expect(
        state?.errorStack?.startsWith('WorkflowDocumentReviewRejectedError: review-rejected'),
      ).toBe(true);
    });
  }

  it('carries the code and the reason on the error', () => {
    const error = new WorkflowDocumentReviewRejectedError();
    expect(error.code).toBe('review-rejected');
    expect(error.message).toBe('review-rejected');
  });

  it('runs no later step in a nested branch when the rejection arrives there', async () => {
    ran.length = 0;
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, hostWithHook, {
      active: [
        {
          name: 'rejection-nested',
          trigger: { kind: 'manual' },
          steps: [
            {
              kind: 'branch',
              on: 'missing',
              cases: { x: [{ kind: 'activity', handler: 'after' }] },
              otherwise: [{ kind: 'await-signal', signal: 'decision' }],
            },
            { kind: 'activity', handler: 'after' },
          ],
        },
      ],
    });
    const run = await engine.start('rejection-nested', null, { id: 'rejection-nested-run' });
    await run.signal('decision', { rejected: true });
    expect(await throwingRejectionOf(run.result())).toThrow('review-rejected');
    expect(ran).toEqual([]);
    const finished = await engine.get(run.id);
    expect(finished?.status).toBe('failed');
  });

  it('fails the run for a rejection at the last step, with nothing after it to stop', async () => {
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, hostWithHook, {
      active: [
        {
          name: 'rejection-last',
          trigger: { kind: 'manual' },
          steps: [{ kind: 'await-signal', signal: 'decision' }],
        },
      ],
    });
    const run = await engine.start('rejection-last', null, { id: 'rejection-last-run' });
    await run.signal('decision', { rejected: true });
    expect(await throwingRejectionOf(run.result())).toThrow('review-rejected');
    const state = await engine.get(run.id);
    expect(state?.status).toBe('failed');
  });

  it('runs no later iteration of a map that waits when an iteration is rejected', async () => {
    ran.length = 0;
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, hostWithHook, {
      active: [
        {
          name: 'rejection-map',
          trigger: { kind: 'manual' },
          steps: [
            { kind: 'activity', handler: 'items' },
            {
              kind: 'map',
              over: 'items',
              steps: [
                { kind: 'await-signal', signal: 'decision' },
                { kind: 'activity', handler: 'after' },
              ],
            },
          ],
        },
      ],
    });
    const run = await engine.start('rejection-map', null, { id: 'rejection-map-run' });
    await waitForParked(engine, run.id);
    await run.signal('decision', { rejected: true });
    expect(await throwingRejectionOf(run.result())).toThrow('review-rejected');
    expect(ran).toEqual([]);
    const state = await engine.get(run.id);
    expect(state?.status).toBe('failed');
  });

  it('fails the run for a rejection in a parallel branch once its sibling has settled', async () => {
    ran.length = 0;
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, hostWithHook, {
      active: [
        {
          name: 'rejection-parallel',
          trigger: { kind: 'manual' },
          steps: [
            {
              kind: 'parallel',
              branches: {
                review: [
                  { kind: 'await-signal', signal: 'decision' },
                  { kind: 'activity', handler: 'after' },
                ],
                other: [{ kind: 'await-signal', signal: 'other' }],
              },
            },
            { kind: 'activity', handler: 'after' },
          ],
        },
      ],
    });
    const run = await engine.start('rejection-parallel', null, { id: 'rejection-parallel-run' });
    await waitForCondition(
      async () => {
        const current = await engine.get(run.id);
        return (current?.waitingForSignals ?? []).length === 2;
      },
      { label: 'both branches to wait' },
    );
    await run.signal('decision', { rejected: true });
    await run.signal('other', 'done');
    expect(await throwingRejectionOf(run.result())).toThrow('review-rejected');
    expect(ran).toEqual([]);
    const state = await engine.get(run.id);
    expect(state?.status).toBe('failed');
    expect(
      state?.errorStack?.startsWith('WorkflowDocumentReviewRejectedError: review-rejected'),
    ).toBe(true);
  });

  it('keeps a rejection in a parallel branch across a restart once a sibling has committed (matrix row D14)', async () => {
    // The rejected branch's wait took `decision`, and the sibling's later commit lands that consume:
    // the branch's progress must be in that commit, or a restart shows the review again.
    ran.length = 0;
    const storage = new MemoryStorage();
    const id = 'rejection-parallel-restart-run';
    const definition = {
      name: 'rejection-parallel-restart',
      trigger: { kind: 'manual' },
      steps: [
        {
          kind: 'parallel',
          branches: {
            review: [
              { kind: 'await-signal', signal: 'decision' },
              { kind: 'activity', handler: 'after' },
            ],
            other: [{ kind: 'await-signal', signal: 'other' }],
            third: [{ kind: 'await-signal', signal: 'third' }],
          },
        },
        { kind: 'activity', handler: 'after' },
      ],
    };
    const waiting = async (engine: Engine): Promise<string[]> => {
      const state = await engine.get(id);
      return (state?.waitingForSignals ?? []).toSorted();
    };
    const isWaitingOn = async (engine: Engine, name: string) => {
      const names = await waiting(engine);
      return names.includes(name);
    };
    const statusOf = async (engine: Engine) => {
      const state = await engine.get(id);
      return state?.status;
    };
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, hostWithHook, { active: [definition] });
      const run = await original.start(definition.name, null, { id });
      await waitUntil(
        async () =>
          (await isWaitingOn(original, 'decision')) &&
          (await isWaitingOn(original, 'other')) &&
          (await isWaitingOn(original, 'third')),
        { message: 'every branch to wait' },
      );
      await run.signal('decision', { rejected: true, reason: 'no' });
      await waitUntil(async () => !(await isWaitingOn(original, 'decision')), {
        message: 'the review to take its decision',
      });
      await run.signal('other', 'done');
      await waitUntil(async () => !(await isWaitingOn(original, 'other')), {
        message: 'the sibling to take its signal',
      });
      // The sibling's step settles in a commit: wait until the decision's consume is durable.
      await waitUntil(async () => (await storage.count(`sig:${id}:decision:`)) === 0, {
        message: 'the decision to be consumed durably',
      });
    }
    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, hostWithHook, { active: [definition] });
    const [handle] = await restarted.recoverAll();
    await waitUntil(async () => isWaitingOn(restarted, 'third'), {
      message: 'the last branch to wait again',
    });
    expect(await waiting(restarted)).toEqual(['third']);
    await handle!.signal('third', 'done');
    // The review is not shown again: the run settles once its last branch has its signal.
    await waitUntil(async () => (await statusOf(restarted)) !== 'running', {
      message: 'the run to settle once its last branch takes its signal',
    });
    expect(await throwingRejectionOf(handle!.result())).toThrow('review-rejected');
    expect(ran).toEqual([]);
    expect(await statusOf(restarted)).toBe('failed');
  });

  it('recovers a run at a rejected wait to the same end after a restart', async () => {
    ran.length = 0;
    const storage = new MemoryStorage();
    const name = 'rejection-restart';
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, hostWithHook, { active: [document(name)] });
      await original.start(name, null, { id: `${name}-run` });
      await waitForParked(original, `${name}-run`);
    }
    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, hostWithHook, { active: [document(name)] });
    // The decision is durable before the run is recovered: the instance consumes it on replay.
    await restarted.signal(`${name}-run`, 'decision', { rejected: true, reason: 'no' });
    const [handle] = await restarted.recoverAll();
    expect(await throwingRejectionOf(handle!.result())).toThrow('review-rejected');
    expect(ran).toEqual([]);
    const state = await restarted.get(`${name}-run`);
    expect(state?.status).toBe('failed');
    expect(state?.error).toBe('review-rejected');
  });

  describe('a crash after the rejection was read (matrix row R6, COR-2418)', () => {
    /**
     * A store that stops writing the moment the host reads a rejection: the next `allowance` writes
     * go through and every one after is refused, which freezes the durable state at that point as
     * a crash would. `armed` is set by the host's `isRejection`, the one place the run is known to
     * have read the rejection payload.
     */
    class CrashingStorage extends MemoryStorage {
      armed = false;
      allowance = 0;
      admitted = 0;
      refused = 0;

      #admit(): void {
        if (!this.armed) return;
        if (this.admitted < this.allowance) {
          this.admitted += 1;
          return;
        }
        this.refused += 1;
        throw new Error('the process died');
      }

      override async put(...parameters: Parameters<MemoryStorage['put']>) {
        this.#admit();
        return super.put(...parameters);
      }

      override async delete(...parameters: Parameters<MemoryStorage['delete']>) {
        this.#admit();
        return super.delete(...parameters);
      }

      override async batch(...parameters: Parameters<MemoryStorage['batch']>) {
        this.#admit();
        return super.batch(...parameters);
      }

      override async conditionalBatch(
        ...parameters: Parameters<MemoryStorage['conditionalBatch']>
      ) {
        this.#admit();
        return super.conditionalBatch(...parameters);
      }
    }

    /**
     * Where the crash falls, in writes the run gets through after it read the rejection. The
     * rejection's payload commits in the same write as the failure it causes, so there is no state
     * between "payload checkpointed" and "run failed": a crash before that write leaves the run
     * `running` with the decision still buffered, and one after it leaves it `failed`.
     */
    const crashPoints: readonly {
      readonly name: string;
      readonly writesBeforeCrash: number;
      readonly durableStatus: 'running' | 'failed';
    }[] = [
      { name: 'before the write that settles it', writesBeforeCrash: 0, durableStatus: 'running' },
      { name: 'after the write that settles it', writesBeforeCrash: 1, durableStatus: 'failed' },
    ];

    for (const point of crashPoints) {
      it(`fails the run as rejected with no later step started, for a crash ${point.name}`, async () => {
        ran.length = 0;
        const storage = new CrashingStorage();
        storage.allowance = point.writesBeforeCrash;
        const name = `rejection-crash-${String(point.writesBeforeCrash)}`;
        const id = `${name}-run`;
        const document_ = document(name);
        const crashingHost: DocumentWorkflowHost = {
          ...hostWithHook,
          isRejection: (payload) => {
            const rejection = rejects(payload);
            if (rejection) storage.armed = true;
            return rejection;
          },
        };
        {
          await using crashed = new Engine({ storage });
          await registerWorkflowDocuments(crashed, crashingHost, { active: [document_] });
          await crashed.start(name, null, { id });
          await waitForParked(crashed, id);
          await crashed.signal(id, 'decision', { rejected: true, reason: 'no' });
          // The run read the rejection, and every write after the allowed ones was refused.
          await waitUntil(async () => storage.refused > 0);
        }
        // What is durable now is what a crash left. The run never started a later step.
        storage.armed = false;
        await using recovered = new Engine({ storage });
        await registerWorkflowDocuments(recovered, hostWithHook, { active: [document_] });
        const before = await recovered.get(id);
        expect(before?.status).toBe(point.durableStatus);
        const handles = await recovered.recoverAll();
        const handle = handles.find((candidate) => candidate.id === id);
        if (point.durableStatus === 'running') {
          // The decision is still buffered: recovery consumes it and fails the run as rejected.
          expect(await throwingRejectionOf(handle!.result())).toThrow('review-rejected');
        } else {
          expect(handle).toBeUndefined();
        }
        const after = await recovered.get(id);
        expect(after?.status).toBe('failed');
        expect(after?.error).toBe('review-rejected');
        expect(ran).toEqual([]);
      });
    }
  });

  it('still continues for an approval after a restart', async () => {
    ran.length = 0;
    const storage = new MemoryStorage();
    const name = 'approval-restart';
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, hostWithHook, { active: [document(name)] });
      await original.start(name, null, { id: `${name}-run` });
      await waitForParked(original, `${name}-run`);
    }
    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, hostWithHook, { active: [document(name)] });
    const [handle] = await restarted.recoverAll();
    await handle!.signal('decision', { note: 'ok' });
    expect(await handle!.result()).toEqual({ after: true, signal: { note: 'ok' } });
    expect(ran).toEqual(['after']);
  });
});
