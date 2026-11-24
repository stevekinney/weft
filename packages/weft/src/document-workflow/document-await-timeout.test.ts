/**
 * COR-2240: an `await-signal` step may carry a `timeout`. A signal before it continues as before;
 * when it passes with no signal the run continues with `{ timedOut: true }` as `previous`, so a
 * `branch` can escalate. A race branch's sleep is an in-process timer (see
 * `executeSleepSubOperation`) that the engine's own manual clock (`getNow` and `scheduler.tick`)
 * never fires, so fake timers are the only clock the race primitive honors. AC1's "manual clock" is
 * therefore Bun's fake timers, installed before the engine is built, and no test here waits on a
 * wall-clock timer. A "signal first" row never advances the clock.
 */
import { afterEach, describe, expect, it, jest } from 'bun:test';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import {
  advanceTimersByTime,
  restoreRealTimers,
  useFakeTimers,
} from "../../test-support/embedded/testing/src/fake-timers.ts";
import { throwingRejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { waitUntil } from "../../test-support/embedded/testing/src/wait-until.ts";

import { Engine } from '../core/engine/index.ts';
import {
  validateWorkflowDocument,
  workflowDocumentVersion,
  type DocumentWorkflowHost,
} from './document.ts';
import { registerWorkflowDocuments } from './register.ts';

const seen: { handler: string; previous: unknown; signal: unknown }[] = [];

const host: DocumentWorkflowHost = {
  activities: {
    after: ({ previous, signal }) => {
      seen.push({ handler: 'after', previous, signal });
      return { after: true, previous, signal };
    },
    escalate: ({ previous, signal }) => {
      seen.push({ handler: 'escalate', previous, signal });
      return { escalated: true };
    },
    prepare: () => ({ prepared: true }),
  },
  triggerKinds: { manual: () => undefined },
  isRejection: (payload) =>
    typeof payload === 'object' && payload !== null && Reflect.get(payload, 'rejected') === true,
};

const manual = { kind: 'manual' };
const HOUR = 60 * 60 * 1000;

afterEach(() => {
  restoreRealTimers();
});

/** Wait until run `id` has parked on signal `name`. */
async function parkedOn(engine: Engine, id: string, name = 'go'): Promise<void> {
  // `waitUntil` takes real event-loop turns, which the engine needs under fake timers.
  await waitUntil(async () => {
    const state = await engine.get(id);
    return state?.waitingForSignals?.includes(name) === true;
  });
}

describe('the await-signal timeout field', () => {
  const accepted: readonly [string, string | number][] = [
    ['a number of milliseconds', 50],
    ['a zero timeout', 0],
    ['a duration string', '30s'],
  ];
  for (const [name, timeout] of accepted) {
    it(`accepts ${name}`, () => {
      const document = validateWorkflowDocument(
        {
          name: 'timeout-ok',
          trigger: manual,
          steps: [{ kind: 'await-signal', signal: 'go', timeout }],
        },
        host,
      );
      expect(document.steps[0]).toEqual({ kind: 'await-signal', signal: 'go', timeout });
    });
  }

  const refused: readonly [string, unknown][] = [
    ['a negative number', -1],
    ['a string that is no duration', 'soon'],
    ['a boolean', true],
    ['null', null],
  ];
  for (const [name, timeout] of refused) {
    it(`refuses ${name}`, () => {
      expect(() =>
        validateWorkflowDocument(
          {
            name: 'timeout-bad',
            trigger: manual,
            steps: [{ kind: 'await-signal', signal: 'go', timeout }],
          },
          host,
        ),
      ).toThrow('steps[0].timeout');
    });
  }

  it('keeps the version of a document that has no timeout', async () => {
    // Pinned before the field existed: a document without `timeout` is the document it always was.
    expect(
      await workflowDocumentVersion(
        validateWorkflowDocument(
          {
            name: 'await-hash',
            trigger: manual,
            steps: [
              { kind: 'await-signal', signal: 'go' },
              { kind: 'activity', handler: 'after' },
            ],
          },
          host,
        ),
      ),
    ).toBe('sha256:0b68bedf9181c35d3da3df726bd0e1efc1470437bac5550ac2dbe54ab614f1e6');
  });

  it('gives a document with a timeout another version', async () => {
    const steps = (timeout?: number) => [
      { kind: 'await-signal', signal: 'go', ...(timeout === undefined ? {} : { timeout }) },
    ];
    const plain = await workflowDocumentVersion(
      validateWorkflowDocument({ name: 'v', trigger: manual, steps: steps() }, host),
    );
    const timed = await workflowDocumentVersion(
      validateWorkflowDocument({ name: 'v', trigger: manual, steps: steps(10) }, host),
    );
    expect(timed).not.toBe(plain);
  });
});

type Row = {
  readonly name: string;
  readonly timeout: number | string;
  /** The payload to signal, or `undefined` to let the timeout pass. */
  readonly signal: unknown;
  readonly outcome: 'continues-with-signal' | 'continues-timed-out' | 'rejected';
};

const rows: readonly Row[] = [
  {
    name: 'a signal before the timeout',
    timeout: '1h',
    signal: { ok: 1 },
    outcome: 'continues-with-signal',
  },
  {
    name: 'a null signal before the timeout',
    timeout: '1h',
    signal: null,
    outcome: 'continues-with-signal',
  },
  {
    name: 'no signal before the timeout',
    timeout: '1h',
    signal: undefined,
    outcome: 'continues-timed-out',
  },
  {
    name: 'a zero timeout and no signal',
    timeout: 0,
    signal: undefined,
    outcome: 'continues-timed-out',
  },
  {
    name: 'a rejection before the timeout',
    timeout: '1h',
    signal: { rejected: true },
    outcome: 'rejected',
  },
];

describe('running an await-signal step with a timeout', () => {
  for (const [index, row] of rows.entries()) {
    it(`for ${row.name}`, async () => {
      seen.length = 0;
      const name = `timeout-row-${String(index)}`;
      useFakeTimers(0);
      await using engine = new Engine({ storage: new MemoryStorage() });
      await registerWorkflowDocuments(engine, host, {
        active: [
          {
            name,
            trigger: manual,
            steps: [
              { kind: 'activity', handler: 'prepare' },
              { kind: 'await-signal', signal: 'go', timeout: row.timeout },
              { kind: 'activity', handler: 'after' },
            ],
          },
        ],
      });
      const run = await engine.start(name, null, { id: `${name}-run` });
      if (row.signal !== undefined) {
        await parkedOn(engine, run.id);
        await run.signal('go', row.signal);
      } else {
        // The timeout passes: a wait of zero needs no park, any other waits for its hour.
        if (row.timeout !== 0) await parkedOn(engine, run.id);
        await advanceTimersByTime(row.timeout === 0 ? 0 : HOUR);
      }

      if (row.outcome === 'rejected') {
        expect(await throwingRejectionOf(run.result())).toThrow('review-rejected');
        expect(seen).toEqual([]);
        return;
      }
      const expected =
        row.outcome === 'continues-with-signal'
          ? { previous: { prepared: true }, signal: row.signal }
          : { previous: { timedOut: true }, signal: undefined };
      expect(await run.result()).toEqual({ after: true, ...expected });
      expect(seen).toEqual([{ handler: 'after', ...expected }]);
    });
  }

  it('lets a branch escalate on the timed-out marker, and not on a signal', async () => {
    const document = {
      name: 'timeout-branch',
      trigger: manual,
      steps: [
        { kind: 'await-signal', signal: 'go', timeout: '1h' },
        {
          kind: 'branch',
          on: 'timedOut',
          cases: { true: [{ kind: 'activity', handler: 'escalate' }] },
          otherwise: [{ kind: 'activity', handler: 'after' }],
        },
      ],
    };
    seen.length = 0;
    useFakeTimers(0);
    await using engine = new Engine({ storage: new MemoryStorage() });
    await registerWorkflowDocuments(engine, host, { active: [document] });
    const run = await engine.start('timeout-branch', null, { id: 'timeout-branch-run' });
    await parkedOn(engine, run.id);
    await advanceTimersByTime(HOUR);
    expect(await run.result()).toEqual({ escalated: true });
    expect(seen.map((entry) => entry.handler)).toEqual(['escalate']);
  });

  it('ends with the marker, or the signal, when the wait is the last step', async () => {
    const document = {
      name: 'timeout-last',
      trigger: manual,
      steps: [{ kind: 'await-signal', signal: 'go', timeout: '1h' }],
    };
    useFakeTimers(0);
    await using engine = new Engine({ storage: new MemoryStorage() });
    await registerWorkflowDocuments(engine, host, { active: [document] });
    const timedOut = await engine.start('timeout-last', null, { id: 'timeout-last-a' });
    await parkedOn(engine, timedOut.id);
    await advanceTimersByTime(HOUR);
    expect(await timedOut.result()).toEqual({ timedOut: true });
  });

  it('ends with the signal`s payload when the signal comes first and the wait is the last step', async () => {
    const document = {
      name: 'timeout-last-signal',
      trigger: manual,
      steps: [{ kind: 'await-signal', signal: 'go', timeout: '1h' }],
    };
    useFakeTimers(0);
    await using engine = new Engine({ storage: new MemoryStorage() });
    await registerWorkflowDocuments(engine, host, { active: [document] });
    const run = await engine.start('timeout-last-signal', null, { id: 'timeout-last-signal-run' });
    await parkedOn(engine, run.id);
    await run.signal('go', { ok: 1 });
    expect(await run.result()).toEqual({ ok: 1 });
  });

  it('does not take the timeout path for a signal sent with no payload', async () => {
    seen.length = 0;
    const document = {
      name: 'timeout-bare-signal',
      trigger: manual,
      steps: [
        { kind: 'activity', handler: 'prepare' },
        { kind: 'await-signal', signal: 'go', timeout: '1h' },
        { kind: 'activity', handler: 'after' },
      ],
    };
    useFakeTimers(0);
    await using engine = new Engine({ storage: new MemoryStorage() });
    await registerWorkflowDocuments(engine, host, { active: [document] });
    const run = await engine.start('timeout-bare-signal', null, { id: 'timeout-bare-signal-run' });
    await parkedOn(engine, run.id);
    await run.signal('go');
    // `previous` is still the activity's result, not the timed-out marker.
    expect(await run.result()).toEqual({
      after: true,
      previous: { prepared: true },
      signal: undefined,
    });
  });

  it('resumes a parked wait after a restart and still times out', async () => {
    seen.length = 0;
    const storage = new MemoryStorage();
    const document = {
      name: 'timeout-restart',
      trigger: manual,
      steps: [
        { kind: 'await-signal', signal: 'go', timeout: '1h' },
        { kind: 'activity', handler: 'after' },
      ],
    };
    useFakeTimers(0);
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, host, { active: [document] });
      await original.start('timeout-restart', null, { id: 'timeout-restart-run' });
      await parkedOn(original, 'timeout-restart-run');
    }
    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, host, { active: [document] });
    const [handle] = await restarted.recoverAll();
    await parkedOn(restarted, 'timeout-restart-run');
    await advanceTimersByTime(HOUR);
    expect(await handle!.result()).toEqual({
      after: true,
      previous: { timedOut: true },
      signal: undefined,
    });
  });

  it('T13: times out at once when the deadline passed while the process was down', async () => {
    seen.length = 0;
    const storage = new MemoryStorage();
    const document = {
      name: 'timeout-down',
      trigger: manual,
      steps: [
        { kind: 'await-signal', signal: 'go', timeout: '1h' },
        { kind: 'activity', handler: 'after' },
      ],
    };
    useFakeTimers(0);
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, host, { active: [document] });
      await original.start('timeout-down', null, { id: 'timeout-down-run' });
      await parkedOn(original, 'timeout-down-run');
    }
    // Two hours pass with no process: the deadline came and went.
    jest.setSystemTime(2 * HOUR);
    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, host, { active: [document] });
    const [handle] = await restarted.recoverAll();
    await advanceTimersByTime(0);
    expect(await handle!.result()).toEqual({
      after: true,
      previous: { timedOut: true },
      signal: undefined,
    });
  });

  it('T10: buffers a signal that arrives after the timeout for the next wait on that name', async () => {
    const document = {
      name: 'timeout-late',
      trigger: manual,
      steps: [
        { kind: 'await-signal', signal: 'go', timeout: '1h' },
        { kind: 'await-signal', signal: 'gate' },
        { kind: 'await-signal', signal: 'go' },
      ],
    };
    useFakeTimers(0);
    await using engine = new Engine({ storage: new MemoryStorage() });
    await registerWorkflowDocuments(engine, host, { active: [document] });
    const run = await engine.start('timeout-late', null, { id: 'timeout-late-run' });
    await parkedOn(engine, run.id);
    await advanceTimersByTime(HOUR);
    await parkedOn(engine, run.id, 'gate');

    await run.signal('go', 'late-payload');
    await run.signal('gate', 'open');

    // The late signal is not lost: the later wait on the same name takes it at once.
    expect(await run.result()).toBe('late-payload');
  });

  it('T17: ends a cancelled run, and one that exceeds its execution timeout, at a timed wait', async () => {
    seen.length = 0;
    const document = {
      name: 'timeout-ends',
      trigger: manual,
      steps: [
        { kind: 'await-signal', signal: 'go', timeout: '1h' },
        { kind: 'activity', handler: 'after' },
      ],
    };
    useFakeTimers(0);
    let now = 1_000;
    await using engine = new Engine({ storage: new MemoryStorage(), getNow: () => now });
    await registerWorkflowDocuments(engine, host, { active: [document] });

    const cancelled = await engine.start('timeout-ends', null, { id: 'timeout-ends-cancel' });
    await parkedOn(engine, cancelled.id);
    await cancelled.cancel();
    const afterCancel = await engine.get(cancelled.id);
    expect(afterCancel?.status).toBe('cancelled');

    const limited = await engine.start('timeout-ends', null, {
      id: 'timeout-ends-limit',
      executionTimeout: 5_000,
    });
    await parkedOn(engine, limited.id);
    now = 6_001;
    await engine.scheduler.tick(now);
    expect(await throwingRejectionOf(limited.result())).toThrow('exceeded execution timeout');

    // The timeout that would have fired is no longer a way back: neither run continues.
    await advanceTimersByTime(2 * HOUR);
    const cancelledAfter = await engine.get(cancelled.id);
    const limitedAfter = await engine.get(limited.id);
    expect(cancelledAfter?.status).toBe('cancelled');
    expect(limitedAfter?.status).toBe('timed-out');
    expect(seen).toEqual([]);
  });
});
