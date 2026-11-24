import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";

import { KEYS } from '../../storage/keys.ts';
import { settleInlineLaunches } from '../../testing/inline-launch-settle.test-support.ts';
import { decode } from '../codec.ts';
import { Engine } from '../engine.ts';
import type { ReviewRequest } from '../review/index.ts';
import { activity } from '../types.ts';
import { workflow } from '../types/workflow-function.ts';
import type { WorkflowLogsResult } from '../workflow-log-codec.ts';
import { createWorkflowLogStore, type WorkflowLogStore } from '../workflow-log-store.ts';

/**
 * COR-1811 review round 1. A run that is parked (a signal, a human review, a timer) keeps its
 * persisted `ctx.log` lines, and a line logged before the park is stored once, however the run
 * resumes.
 */

const DAY = 24 * 60 * 60 * 1000;
const WINDOW = 7 * DAY;

const noop = activity({ name: 'noop', execute: async (input: string) => input });

function sequencedMessagesOf(result: WorkflowLogsResult): Array<[number, string]> {
  return result.lines.map((line) => [line.sequence, line.message]);
}

function messagesOf(result: WorkflowLogsResult): string[] {
  return result.lines.map((line) => line.message);
}

function createEngine(
  storage: MemoryStorage,
  logs: WorkflowLogStore,
  extra: { getNow?: () => number } = {},
): Engine {
  return new Engine({ storage, onLog: logs.sink, workflowLogs: logs, ...extra });
}

/** A workflow that logs before and after a signal wait, with a committed step in front. */
function signalWorkflow(name: string) {
  return workflow({ name })
    .activities({ noop })
    .execute(async function* (ctx) {
      ctx.log?.info('before step');
      yield* ctx.run('noop', 'x');
      ctx.log?.info('before wait');
      const value = yield* ctx.waitForSignal<string>('go');
      ctx.log?.info('after wait');
      return value;
    });
}

describe('retention never touches a run that is still active', () => {
  it('keeps the lines of a run parked past the window, and never reuses a sequence', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const logs = createWorkflowLogStore(storage, { getNow: () => now });
    await using engine = createEngine(storage, logs);
    engine.register(signalWorkflow('parked-retention'));
    const handle = await engine.start('parked-retention', null, { id: 'run-parked' });
    await settleInlineLaunches();
    const before = sequencedMessagesOf(await engine.getLogs('run-parked'));
    expect(before).toEqual([
      [0, 'before step'],
      [1, 'before wait'],
    ]);

    now += 8 * DAY;
    expect(await logs.prune({ olderThan: WINDOW })).toEqual({ runs: 0 });
    const afterPrune = await engine.getLogs('run-parked');
    expect(sequencedMessagesOf(afterPrune)).toEqual(before);
    expect(afterPrune.dropped).toBe(0);

    await engine.signal('run-parked', 'go', 'done');
    expect(await handle.result()).toBe('done');
    const finished = await engine.getLogs('run-parked');
    // The line logged after the wait continues the sequence: nothing was reused.
    expect(sequencedMessagesOf(finished)).toEqual([...before, [2, 'after wait']]);
    expect(finished.dropped).toBe(0);
  });

  it('prunes a finished run past the window, and a later line never reuses a sequence', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const logs = createWorkflowLogStore(storage, { getNow: () => now });
    await using engine = createEngine(storage, logs);
    engine.register(signalWorkflow('finished-retention'));
    const handle = await engine.start('finished-retention', null, { id: 'run-finished' });
    await settleInlineLaunches();
    await engine.signal('run-finished', 'go', 'done');
    await handle.result();
    expect(messagesOf(await engine.getLogs('run-finished'))).toEqual([
      'before step',
      'before wait',
      'after wait',
    ]);

    now += 8 * DAY;
    expect(await logs.prune({ olderThan: WINDOW })).toEqual({ runs: 1 });
    const pruned = await engine.getLogs('run-finished');
    expect(pruned.lines).toEqual([]);
    // The removed lines are counted, not forgotten.
    expect(pruned.dropped).toBe(3);

    // A second pass finds nothing left to remove.
    expect(await logs.prune({ olderThan: WINDOW })).toEqual({ runs: 0 });

    // The run record still exists, so its counter must: a later line continues the sequence.
    logs.sink({
      level: 'info',
      message: 'late',
      workflowId: 'run-finished',
      workflowType: 'finished-retention',
      timestamp: now,
      step: 3,
    });
    const late = await engine.getLogs('run-finished');
    expect(sequencedMessagesOf(late)).toEqual([[3, 'late']]);
    expect(late.dropped).toBe(3);
  });

  it('keeps the lines of a run that is parked on a human review past the window', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const logs = createWorkflowLogStore(storage, { getNow: () => now });
    await using engine = createEngine(storage, logs);
    engine.register(
      workflow({ name: 'review-retention' }).execute(async function* (ctx) {
        ctx.log?.info('asking');
        yield* ctx.review({ artifact: 'draft', reviewers: ['alice'] });
        return 'reviewed';
      }),
    );
    await engine.start('review-retention', null, { id: 'run-review-retention' });
    await settleInlineLaunches();

    now += 8 * DAY;
    expect(await logs.prune({ olderThan: WINDOW })).toEqual({ runs: 0 });
    expect(messagesOf(await engine.getLogs('run-review-retention'))).toEqual(['asking']);
  });
});

describe('a line logged before a park is stored once', () => {
  it('after a signal wait, in the same process', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage, createWorkflowLogStore(storage));
    engine.register(signalWorkflow('once-signal'));
    const handle = await engine.start('once-signal', null, { id: 'run-once-signal' });
    await settleInlineLaunches();
    await engine.signal('run-once-signal', 'go', 'done');
    expect(await handle.result()).toBe('done');

    expect(sequencedMessagesOf(await engine.getLogs('run-once-signal'))).toEqual([
      [0, 'before step'],
      [1, 'before wait'],
      [2, 'after wait'],
    ]);
  });

  it('after a signal wait, when the engine restarted while parked', async () => {
    const storage = new MemoryStorage();
    {
      await using first = createEngine(storage, createWorkflowLogStore(storage));
      first.register(signalWorkflow('once-recover'));
      await first.start('once-recover', null, { id: 'run-once-recover' });
      await settleInlineLaunches();
    }

    await using recovered = createEngine(storage, createWorkflowLogStore(storage));
    recovered.register(signalWorkflow('once-recover'));
    const [handle] = await recovered.recoverAll();
    await settleInlineLaunches();
    await recovered.signal('run-once-recover', 'go', 'done');
    expect(await handle!.result()).toBe('done');

    expect(sequencedMessagesOf(await recovered.getLogs('run-once-recover'))).toEqual([
      [0, 'before step'],
      [1, 'before wait'],
      [2, 'after wait'],
    ]);
  });

  it('after a signal wait that has no committed step in front of it', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage, createWorkflowLogStore(storage));
    engine.register(
      workflow({ name: 'once-first' }).execute(async function* (ctx) {
        ctx.log?.info('first line');
        ctx.log?.warn('second line');
        const value = yield* ctx.waitForSignal<string>('go');
        ctx.log?.info('after wait');
        return value;
      }),
    );
    const handle = await engine.start('once-first', null, { id: 'run-once-first' });
    await settleInlineLaunches();
    await engine.signal('run-once-first', 'go', 'done');
    await handle.result();

    expect(sequencedMessagesOf(await engine.getLogs('run-once-first'))).toEqual([
      [0, 'first line'],
      [1, 'second line'],
      [2, 'after wait'],
    ]);
  });

  it('after a human review', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage, createWorkflowLogStore(storage));
    engine.register(
      workflow({ name: 'once-review' }).execute(async function* (ctx) {
        ctx.log?.info('before review');
        const decision = yield* ctx.review({ artifact: 'draft', reviewers: ['alice'] });
        ctx.log?.info('after review');
        return decision.decision;
      }),
    );
    const handle = await engine.start('once-review', null, { id: 'run-once-review' });
    await settleInlineLaunches();
    const reviews: ReviewRequest[] = [];
    for await (const [, value] of storage.scan('review:')) {
      reviews.push(decode(value) as ReviewRequest);
    }
    expect(reviews).toHaveLength(1);
    await engine.submitReview(reviews[0]!.reviewId, {
      decision: 'approved',
      reviewer: 'alice',
      workflowId: 'run-once-review',
    });
    expect(await handle.result()).toBe('approved');

    expect(sequencedMessagesOf(await engine.getLogs('run-once-review'))).toEqual([
      [0, 'before review'],
      [1, 'after review'],
    ]);
  });

  it('after a human review, when the engine restarted while it was pending', async () => {
    const storage = new MemoryStorage();
    const build = (engine: Engine) =>
      engine.register(
        workflow({ name: 'once-review-recover' }).execute(async function* (ctx) {
          ctx.log?.info('before review');
          const decision = yield* ctx.review({ artifact: 'draft', reviewers: ['alice'] });
          ctx.log?.info('after review');
          return decision.decision;
        }),
      );
    const requested = async (): Promise<ReviewRequest[]> => {
      const found: ReviewRequest[] = [];
      for await (const [, value] of storage.scan('review:'))
        found.push(decode(value) as ReviewRequest);
      return found;
    };
    {
      await using first = createEngine(storage, createWorkflowLogStore(storage));
      build(first);
      await first.start('once-review-recover', null, { id: 'run-once-review-recover' });
      await settleInlineLaunches();
    }
    const firstRequests = await requested();
    const firstLife = new Set(firstRequests.map((review) => review.reviewId));

    await using recovered = createEngine(storage, createWorkflowLogStore(storage));
    build(recovered);
    const [handle] = await recovered.recoverAll();
    await settleInlineLaunches();
    // The recovered body asks again: answer the request this life made.
    const secondRequests = await requested();
    const reviews = secondRequests.filter((review) => !firstLife.has(review.reviewId));
    expect(reviews).toHaveLength(1);
    await recovered.submitReview(reviews[0]!.reviewId, {
      decision: 'approved',
      reviewer: 'alice',
      workflowId: 'run-once-review-recover',
    });
    expect(await handle!.result()).toBe('approved');

    expect(sequencedMessagesOf(await recovered.getLogs('run-once-review-recover'))).toEqual([
      [0, 'before review'],
      [1, 'after review'],
    ]);
  });

  it('after a timer wakeup', async () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    await using engine = createEngine(storage, createWorkflowLogStore(storage), {
      getNow: () => now,
    });
    engine.register(
      workflow({ name: 'once-sleep' }).execute(async function* (ctx) {
        ctx.log?.info('before sleep');
        yield* ctx.sleep('5s');
        ctx.log?.info('after sleep');
        return 'awake';
      }),
    );
    const handle = await engine.start('once-sleep', null, { id: 'run-once-sleep' });
    await settleInlineLaunches();
    now += 6_000;
    await engine.scheduler.tick(now);
    expect(await handle.result()).toBe('awake');

    expect(sequencedMessagesOf(await engine.getLogs('run-once-sleep'))).toEqual([
      [0, 'before sleep'],
      [1, 'after sleep'],
    ]);
  });

  it('after a wake that follows an engine restart', async () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    {
      await using first = createEngine(storage, createWorkflowLogStore(storage), {
        getNow: () => now,
      });
      first.register(
        workflow({ name: 'once-sleep-recover' }).execute(async function* (ctx) {
          ctx.log?.info('before sleep');
          yield* ctx.sleep('5s');
          ctx.log?.info('after sleep');
          return 'awake';
        }),
      );
      await first.start('once-sleep-recover', null, { id: 'run-once-sleep-recover' });
      await settleInlineLaunches();
    }

    await using recovered = createEngine(storage, createWorkflowLogStore(storage), {
      getNow: () => now,
    });
    recovered.register(
      workflow({ name: 'once-sleep-recover' }).execute(async function* (ctx) {
        ctx.log?.info('before sleep');
        yield* ctx.sleep('5s');
        ctx.log?.info('after sleep');
        return 'awake';
      }),
    );
    const [handle] = await recovered.recoverAll();
    await settleInlineLaunches();
    now += 6_000;
    await recovered.scheduler.tick(now);
    expect(await handle!.result()).toBe('awake');

    expect(sequencedMessagesOf(await recovered.getLogs('run-once-sleep-recover'))).toEqual([
      [0, 'before sleep'],
      [1, 'after sleep'],
    ]);
  });
});

describe('a run that never took a turn before it was recovered', () => {
  it('stores the lines it logs on its first turn, because no earlier execution logged them', async () => {
    const storage = new MemoryStorage();
    const build = (engine: Engine) =>
      engine.register(
        workflow({ name: 'first-turn-crash' })
          .activities({ noop })
          .execute(async function* (ctx) {
            ctx.log?.info('first line, before any durable step');
            yield* ctx.run('noop', 'x');
            ctx.log?.info('after step 0');
            yield* ctx.waitForSignal<string>('go');
            ctx.log?.info('after wait');
            return 'done';
          }),
      );
    {
      const logs = createWorkflowLogStore(storage);
      const first = createEngine(storage, logs);
      build(first);
      await first.start('first-turn-crash', null, { id: 'run-first-turn' });
      // A crash before the queued first turn ran: synchronous disposal discards the launch.
      first[Symbol.dispose]();
    }

    const emitted: Array<[string, boolean | undefined]> = [];
    const logs = createWorkflowLogStore(storage);
    await using recovered = new Engine({
      storage,
      onLog: (record) => {
        emitted.push([record.message, record.replayed]);
        logs.sink(record);
      },
      workflowLogs: logs,
    });
    build(recovered);
    await recovered.recoverAll();
    await settleInlineLaunches();

    // The first turn is the first time anything ran, so its first line is new work.
    expect(emitted.slice(0, 1)).toEqual([['first line, before any durable step', undefined]]);
    expect(messagesOf(await recovered.getLogs('run-first-turn'))).toEqual([
      'first line, before any durable step',
      'after step 0',
    ]);

    await recovered.signal('run-first-turn', 'go', 'x');
    await settleInlineLaunches();
    expect(messagesOf(await recovered.getLogs('run-first-turn'))).toEqual([
      'first line, before any durable step',
      'after step 0',
      'after wait',
    ]);
  });
});

/** Read a run's stored lines through a store of its own, as a process that restarted would. */
async function readLogs(storage: MemoryStorage, workflowId: string): Promise<WorkflowLogsResult> {
  return createWorkflowLogStore(storage).read(workflowId);
}

/**
 * A storage that dies at the moment a fork's checkpoint is committed: the commit lands, then every
 * later read and write never settles, as for a process killed inside `fork()`. `committedForkId`
 * resolves with the fork's id once that commit has landed.
 */
function crashAfterForkCommit(inner: MemoryStorage): {
  storage: MemoryStorage;
  committedForkId: Promise<string>;
} {
  const [prefix = '', suffix = ''] = KEYS.checkpoint('ID').split('ID');
  const checkpointKey = { prefix, suffix };
  let dead = false;
  let resolveForkId: (id: string) => void = () => undefined;
  const committedForkId = new Promise<string>((resolve) => (resolveForkId = resolve));
  const never = () => new Promise<never>(() => undefined);
  const storage = new Proxy(inner, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      if (property === 'scan') {
        return (...args: unknown[]) =>
          dead
            ? (async function* () {
                await never();
              })()
            : value.apply(target, args);
      }
      if (property !== 'batch' && property !== 'conditionalBatch') {
        return (...args: unknown[]) => (dead ? never() : value.apply(target, args));
      }
      return async (...args: unknown[]) => {
        if (dead) return never();
        const result: unknown = await value.apply(target, args);
        const operations = (property === 'batch' ? args[0] : args[1]) as Array<{
          type: string;
          key: string;
        }>;
        const forkCheckpoint = operations.find(
          (operation) =>
            operation.type === 'put' &&
            operation.key.startsWith(checkpointKey.prefix) &&
            operation.key.endsWith(checkpointKey.suffix) &&
            operation.key !== KEYS.checkpoint('run-source'),
        );
        if (forkCheckpoint !== undefined) {
          dead = true;
          resolveForkId(
            forkCheckpoint.key.slice(checkpointKey.prefix.length, -checkpointKey.suffix.length),
          );
          return never();
        }
        return result;
      };
    },
  });
  return { storage, committedForkId };
}

/**
 * COR-1924. A fork copies its source's checkpoint under the fork's own id, so the checkpoint's step
 * is above zero before the fork has run. The step is not evidence that this run's own execution took
 * a turn, so a fork recovered before its first turn stores its lines.
 */
describe('a fork that was recovered before its first turn', () => {
  const buildForkWorkflow = (engine: Engine) =>
    engine.register(
      workflow({ name: 'fork-first-turn-crash' })
        .activities({ noop })
        .execute(async function* (ctx) {
          ctx.log?.info('before step');
          yield* ctx.run('noop', 'x');
          ctx.log?.info('before wait');
          yield* ctx.waitForSignal<string>('go');
          ctx.log?.info('after wait');
          return 'done';
        }),
    );

  async function parkSource(storage: MemoryStorage): Promise<void> {
    await using source = createEngine(storage, createWorkflowLogStore(storage));
    buildForkWorkflow(source);
    await source.start('fork-first-turn-crash', null, { id: 'run-source' });
    await settleInlineLaunches();
    expect(messagesOf(await source.getLogs('run-source'))).toEqual(['before step', 'before wait']);
  }

  it('stores the lines of its first turn, because only the source logged them before', async () => {
    const storage = new MemoryStorage();
    await parkSource(storage);
    const crash = crashAfterForkCommit(storage);
    const first = createEngine(crash.storage, createWorkflowLogStore(crash.storage));
    buildForkWorkflow(first);
    // The process dies inside `fork()`, after its commit and before the fork's first turn.
    void first.fork('run-source').catch(() => undefined);
    const forkId = await crash.committedForkId;
    first[Symbol.dispose]();
    expect(messagesOf(await readLogs(storage, forkId))).toEqual([]);

    const emitted: Array<[string, boolean | undefined]> = [];
    const logs = createWorkflowLogStore(storage);
    await using recovered = new Engine({
      storage,
      onLog: (record) => {
        if (record.workflowId === forkId) emitted.push([record.message, record.replayed]);
        logs.sink(record);
      },
      workflowLogs: logs,
    });
    buildForkWorkflow(recovered);
    await recovered.recoverAll();
    await settleInlineLaunches();

    expect(emitted).toEqual([['before wait', undefined]]);
    expect(messagesOf(await recovered.getLogs(forkId))).toEqual(['before wait']);
    // The source keeps its own lines, and the fork's recovery does not touch them.
    expect(messagesOf(await recovered.getLogs('run-source'))).toEqual([
      'before step',
      'before wait',
    ]);

    await recovered.signal(forkId, 'go', 'x');
    await settleInlineLaunches();
    expect(messagesOf(await recovered.getLogs(forkId))).toEqual(['before wait', 'after wait']);
  });

  it('still marks the lines a fork logged before its own crash as replayed', async () => {
    const storage = new MemoryStorage();
    await parkSource(storage);
    let forkId = '';
    {
      const first = createEngine(storage, createWorkflowLogStore(storage));
      buildForkWorkflow(first);
      const fork = await first.fork('run-source');
      forkId = fork.id;
      await settleInlineLaunches();
      expect(messagesOf(await first.getLogs(forkId))).toEqual(['before wait']);
      first[Symbol.dispose]();
    }

    const emitted: Array<[string, boolean | undefined]> = [];
    const logs = createWorkflowLogStore(storage);
    await using recovered = new Engine({
      storage,
      onLog: (record) => {
        if (record.workflowId === forkId) emitted.push([record.message, record.replayed]);
        logs.sink(record);
      },
      workflowLogs: logs,
    });
    buildForkWorkflow(recovered);
    await recovered.recoverAll();
    await settleInlineLaunches();

    expect(emitted).toEqual([['before wait', true]]);
    await recovered.signal(forkId, 'go', 'x');
    await settleInlineLaunches();
    expect(messagesOf(await recovered.getLogs(forkId))).toEqual(['before wait', 'after wait']);
  });
});

describe('the engine keeps the key family of a run it purges', () => {
  it('still removes the counter of a run when it is purged', async () => {
    const storage = new MemoryStorage();
    const logs = createWorkflowLogStore(storage);
    await using engine = createEngine(storage, logs);
    engine.register(signalWorkflow('purge-after-prune'));
    const handle = await engine.start('purge-after-prune', null, { id: 'run-purge-after-prune' });
    await settleInlineLaunches();
    await engine.signal('run-purge-after-prune', 'go', 'done');
    await handle.result();

    await engine.purge({ type: 'purge-after-prune' });

    expect(await storage.get(KEYS.workflowLogCounter('run-purge-after-prune'))).toBeNull();
  });
});
