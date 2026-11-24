/**
 * COR-2067's pinned lifecycle contract for document steps, held by a timed `await-signal` (a race
 * of the wait against a sleep) and by a `parallel` step's branches: each records the same
 * `step-started`, `signal-waiting`, `signal-received` and `step-completed` events as a plain
 * top-level wait. A timeout that wins records `step-completed` and no `signal-received`. The
 * timeout's own sleep stays silent. Each shape is the document's last step, which completes through
 * the terminal path, and then a step with another step after it, which completes through the
 * checkpoint path.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import {
  advanceTimersByTime,
  restoreRealTimers,
  useFakeTimers,
} from "../../test-support/embedded/testing/src/fake-timers.ts";
import { waitUntil } from "../../test-support/embedded/testing/src/wait-until.ts";

import { Engine } from '../core/engine/index.ts';
import type { DocumentWorkflowHost } from './document.ts';
import { registerWorkflowDocuments } from './register.ts';

const host: DocumentWorkflowHost = {
  activities: {
    after: () => 'after',
    send: () => 'sent',
    list: () => ({ items: ['x', 'y'] }),
    matrix: () => ({ rows: [{ cells: [1, 2] }, { cells: [3] }] }),
    echo: ({ previous }) => previous,
  },
  triggerKinds: { manual: () => undefined },
};

const manual = { kind: 'manual' };
const document = (name: string, steps: readonly unknown[]) => ({ name, trigger: manual, steps });
const after = { kind: 'activity', handler: 'after' };

const HOUR = 60 * 60 * 1000;

afterEach(() => {
  restoreRealTimers();
});

async function isWaiting(engine: Engine, id: string): Promise<boolean> {
  const state = await engine.get(id);
  return state?.waitingForSignals?.includes('go') === true;
}

/**
 * What a test does to a parked run: send `signal`, or let the timeout of its timed wait pass
 * (`elapse`). Fake timers are the only clock the race primitive honors, so a test that lets a
 * timeout pass installs them before its engine is built and advances them an hour; none waits on
 * a wall-clock timer.
 */
type How = { signal?: unknown; elapse?: boolean };

/** The run's `file-workflow:` events as `{ type, data }`, once it has finished. */
async function lifecycleOf(
  name: string,
  steps: readonly unknown[],
  how: How = {},
): Promise<{ type: string; data: Record<string, unknown> }[]> {
  if (how.elapse === true) useFakeTimers(0);
  await using engine = new Engine({ storage: new MemoryStorage() });
  await registerWorkflowDocuments(engine, host, { active: [document(name, steps)] });
  const run = await engine.start(name, null, { id: `${name}-run` });
  if ('signal' in how || how.elapse === true) {
    await waitUntil(() => isWaiting(engine, run.id));
    if (how.elapse === true) await advanceTimersByTime(HOUR);
    else await run.signal('go', how.signal);
  }
  await run.result();
  const events = await engine.getEvents(run.id);
  return events
    .filter((event) => event.type.startsWith('file-workflow:'))
    .map(({ type, data }) => ({ type, data }));
}

/** The same, with a restart while the run is parked, and the signal (if any) sent after it. */
async function lifecycleAcrossRestart(
  name: string,
  steps: readonly unknown[],
  how: How = {},
): Promise<{ type: string; data: Record<string, unknown> }[]> {
  const storage = new MemoryStorage();
  if (how.elapse === true) useFakeTimers(0);
  {
    await using original = new Engine({ storage });
    await registerWorkflowDocuments(original, host, { active: [document(name, steps)] });
    await original.start(name, null, { id: `${name}-run` });
    await waitUntil(() => isWaiting(original, `${name}-run`));
  }
  await using restarted = new Engine({ storage });
  await registerWorkflowDocuments(restarted, host, { active: [document(name, steps)] });
  const [run] = await restarted.recoverAll();
  if (how.elapse === true) {
    await waitUntil(() => isWaiting(restarted, `${name}-run`));
    await advanceTimersByTime(HOUR);
  }
  if ('signal' in how) await run!.signal('go', how.signal);
  await run!.result();
  const events = await restarted.getEvents(run!.id);
  return events
    .filter((event) => event.type.startsWith('file-workflow:'))
    .map(({ type, data }) => ({ type, data }));
}

const plainWaitEvents = (
  step: number,
  extra: readonly { type: string; data: Record<string, unknown> }[] = [],
) => [
  { type: 'file-workflow:step-started', data: { step, kind: 'await-signal' } },
  { type: 'file-workflow:signal-waiting', data: { step, signal: 'go' } },
  { type: 'file-workflow:signal-received', data: { step, signal: 'go' } },
  { type: 'file-workflow:step-completed', data: { step, kind: 'await-signal' } },
  ...extra,
];
const terminal = { type: 'file-workflow:run-terminal', data: { status: 'completed' } };

describe('lifecycle history of a timed await-signal', () => {
  const timed = { kind: 'await-signal', signal: 'go', timeout: '1h' };
  const plain = { kind: 'await-signal', signal: 'go' };

  it('records a plain wait`s events for a signal that arrives, as the last step', async () => {
    const expected = await lifecycleOf('plain-last', [plain], { signal: 'yes' });
    expect(expected).toEqual(plainWaitEvents(0, [terminal]));
    expect(await lifecycleOf('timed-last', [timed], { signal: 'yes' })).toEqual(expected);
  });

  it('records a plain wait`s events for a signal that arrives, before a later step', async () => {
    const expected = await lifecycleOf('plain-middle', [plain, after], { signal: 'yes' });
    expect(await lifecycleOf('timed-middle', [timed, after], { signal: 'yes' })).toEqual(expected);
    expect(expected.slice(0, 4)).toEqual(plainWaitEvents(0));
  });

  it('records step-completed and no signal-received when the timeout wins, as the last step', async () => {
    expect(
      await lifecycleOf('timeout-last', [{ kind: 'await-signal', signal: 'go', timeout: '1h' }], {
        elapse: true,
      }),
    ).toEqual([
      { type: 'file-workflow:step-started', data: { step: 0, kind: 'await-signal' } },
      { type: 'file-workflow:signal-waiting', data: { step: 0, signal: 'go' } },
      { type: 'file-workflow:step-completed', data: { step: 0, kind: 'await-signal' } },
      terminal,
    ]);
  });

  it('records step-completed and no signal-received when the timeout wins, before a later step', async () => {
    const events = await lifecycleOf(
      'timeout-middle',
      [after, { kind: 'await-signal', signal: 'go', timeout: '1h' }, after],
      { elapse: true },
    );
    expect(events.filter((event) => event.data['step'] === 1)).toEqual([
      { type: 'file-workflow:step-started', data: { step: 1, kind: 'await-signal' } },
      { type: 'file-workflow:signal-waiting', data: { step: 1, signal: 'go' } },
      { type: 'file-workflow:step-completed', data: { step: 1, kind: 'await-signal' } },
    ]);
    expect(events.map((event) => event.type)).not.toContain('file-workflow:signal-received');
  });

  it('records the same events when a restart comes between the park and the signal', async () => {
    const plainAfterRestart = await lifecycleAcrossRestart('plain-restart', [plain], {
      signal: 'yes',
    });
    expect(plainAfterRestart).toEqual(plainWaitEvents(0, [terminal]));
    expect(await lifecycleAcrossRestart('timed-restart', [timed], { signal: 'yes' })).toEqual(
      plainAfterRestart,
    );
  });

  it('records step-completed and no signal-received when the timeout wins after a restart', async () => {
    expect(
      await lifecycleAcrossRestart(
        'timeout-restart',
        [{ kind: 'await-signal', signal: 'go', timeout: '1h' }],
        { elapse: true },
      ),
    ).toEqual([
      { type: 'file-workflow:step-started', data: { step: 0, kind: 'await-signal' } },
      { type: 'file-workflow:signal-waiting', data: { step: 0, signal: 'go' } },
      { type: 'file-workflow:step-completed', data: { step: 0, kind: 'await-signal' } },
      terminal,
    ]);
  });

  it('records no event of its own for the timeout sleep', async () => {
    const events = await lifecycleOf(
      'timeout-silent',
      [{ kind: 'await-signal', signal: 'go', timeout: '1h' }],
      { elapse: true },
    );
    expect(events.map((event) => event.data['kind'])).not.toContain('sleep');
  });
});

describe('lifecycle history of a wait or sleep in a parallel branch', () => {
  const wait = { kind: 'await-signal', signal: 'go' };
  const parallel = (branches: Record<string, unknown>) => ({ kind: 'parallel', branches });

  it('records a wait and a sleep branch, as the last step', async () => {
    // Each branch records its own steps as it settles them, so the order between two branches is
    // the order they settled in; what is pinned is each branch's own sequence and the end.
    const events = await lifecycleOf(
      'parallel-last',
      [parallel({ a: [{ kind: 'sleep', duration: 5 }], b: [wait] })],
      { signal: 'yes' },
    );
    expect(events.at(-1)).toEqual(terminal);
    const ofBranch = (address: string) =>
      events.filter((event) => event.data['stepAddress'] === address);
    expect(ofBranch('1#a')).toEqual([
      { type: 'file-workflow:step-started', data: { step: 1, stepAddress: '1#a', kind: 'sleep' } },
      {
        type: 'file-workflow:step-completed',
        data: { step: 1, stepAddress: '1#a', kind: 'sleep' },
      },
    ]);
    expect(ofBranch('2#b')).toEqual([
      {
        type: 'file-workflow:step-started',
        data: { step: 2, stepAddress: '2#b', kind: 'await-signal' },
      },
      {
        type: 'file-workflow:signal-waiting',
        data: { step: 2, stepAddress: '2#b', signal: 'go' },
      },
      {
        type: 'file-workflow:signal-received',
        data: { step: 2, stepAddress: '2#b', signal: 'go' },
      },
      {
        type: 'file-workflow:step-completed',
        data: { step: 2, stepAddress: '2#b', kind: 'await-signal' },
      },
    ]);
    expect(events).toHaveLength(7);
  });

  it('records the same events for a branch step with another step after it', async () => {
    const last = await lifecycleOf('parallel-end', [parallel({ a: [wait] })], { signal: 'yes' });
    const middle = await lifecycleOf('parallel-more', [parallel({ a: [wait] }), after], {
      signal: 'yes',
    });
    expect(middle.filter((event) => event.data['step'] === 1)).toEqual(
      last.filter((event) => event.data['step'] === 1),
    );
    expect(last.filter((event) => event.data['step'] === 1).map((event) => event.type)).toEqual([
      'file-workflow:step-started',
      'file-workflow:signal-waiting',
      'file-workflow:signal-received',
      'file-workflow:step-completed',
    ]);
  });

  it('records a branch wait`s completion when a restart comes between the park and the signal', async () => {
    const events = await lifecycleAcrossRestart(
      'parallel-restart-history',
      [parallel({ a: [wait] })],
      {
        signal: 'yes',
      },
    );
    expect(events.map((event) => event.type)).toEqual([
      'file-workflow:step-started',
      'file-workflow:signal-waiting',
      'file-workflow:signal-received',
      'file-workflow:step-completed',
      'file-workflow:run-terminal',
    ]);
  });

  it('records a timed wait in a branch like a top-level one, a signal first or the timeout first', async () => {
    const signalled = await lifecycleOf(
      'parallel-timed-signal',
      [parallel({ a: [{ kind: 'await-signal', signal: 'go', timeout: '1h' }] })],
      { signal: 'yes' },
    );
    expect(signalled).toEqual([
      {
        type: 'file-workflow:step-started',
        data: { step: 1, stepAddress: '1#a', kind: 'await-signal' },
      },
      { type: 'file-workflow:signal-waiting', data: { step: 1, stepAddress: '1#a', signal: 'go' } },
      {
        type: 'file-workflow:signal-received',
        data: { step: 1, stepAddress: '1#a', signal: 'go' },
      },
      {
        type: 'file-workflow:step-completed',
        data: { step: 1, stepAddress: '1#a', kind: 'await-signal' },
      },
      terminal,
    ]);
    const timedOut = await lifecycleOf(
      'parallel-timed-out',
      [parallel({ a: [{ kind: 'await-signal', signal: 'go', timeout: '1h' }] }), after],
      { elapse: true },
    );
    expect(timedOut.filter((event) => event.data['step'] === 1)).toEqual([
      {
        type: 'file-workflow:step-started',
        data: { step: 1, stepAddress: '1#a', kind: 'await-signal' },
      },
      { type: 'file-workflow:signal-waiting', data: { step: 1, stepAddress: '1#a', signal: 'go' } },
      {
        type: 'file-workflow:step-completed',
        data: { step: 1, stepAddress: '1#a', kind: 'await-signal' },
      },
    ]);
  });
});

/**
 * COR-2418: a step inside a nested coordinator (a `map` in a `parallel` branch, a `parallel` in a
 * `map`, a `map` in a `map`) records the lifecycle a top-level step does, at its own address. The
 * completions of those steps were never recorded: only their starts were.
 */
describe('lifecycle history of steps nested in a coordinator', () => {
  const echo = { kind: 'activity', handler: 'echo' };
  const list = { kind: 'activity', handler: 'list' };
  const matrix = { kind: 'activity', handler: 'matrix' };

  /** What a top-level activity step records, at `address`. */
  const activityEvents = (step: number, address: string, handler: string) => {
    const identity = address === String(step) ? { step } : { step, stepAddress: address };
    return [
      { type: 'file-workflow:step-started', data: { ...identity, kind: 'activity' } },
      { type: 'file-workflow:activity-started', data: { ...identity, handler } },
      { type: 'file-workflow:activity-completed', data: { ...identity, handler } },
      { type: 'file-workflow:step-completed', data: { ...identity, kind: 'activity' } },
    ];
  };

  type Row = {
    name: string;
    steps: readonly unknown[];
    /** Each nested `echo` step: its document step and its address. */
    nested: readonly (readonly [number, string])[];
  };
  const rows: readonly Row[] = [
    {
      name: 'a map in a parallel branch',
      steps: [
        {
          kind: 'parallel',
          branches: { a: [list, { kind: 'map', over: 'items', steps: [echo] }] },
        },
      ],
      nested: [
        [3, '3#a.0'],
        [3, '3#a.1'],
      ],
    },
    {
      name: 'a parallel in a map',
      steps: [
        list,
        {
          kind: 'map',
          over: 'items',
          steps: [{ kind: 'parallel', branches: { p: [echo], q: [echo] } }],
        },
      ],
      nested: [
        [3, '3#0.p'],
        [4, '4#0.q'],
        [3, '3#1.p'],
        [4, '4#1.q'],
      ],
    },
    {
      name: 'a map in a map',
      steps: [
        matrix,
        { kind: 'map', over: 'rows', steps: [{ kind: 'map', over: 'cells', steps: [echo] }] },
      ],
      nested: [
        [3, '3#0.0'],
        [3, '3#0.1'],
        [3, '3#1.0'],
      ],
    },
  ];

  const byAddress = <Event extends { data: Record<string, unknown> }>(
    events: Event[],
    address: string,
  ): Event[] => events.filter((event) => event.data['stepAddress'] === address);

  for (const row of rows) {
    it(`records every nested step of ${row.name} as a top-level step, on the terminal and the checkpoint path alike`, async () => {
      const terminalPath = await lifecycleOf(
        `nested-last-${row.name.replaceAll(' ', '-')}`,
        row.steps,
      );
      const checkpointPath = await lifecycleOf(`nested-more-${row.name.replaceAll(' ', '-')}`, [
        ...row.steps,
        after,
      ]);
      for (const [step, address] of row.nested) {
        const expected = activityEvents(step, address, 'echo');
        expect(byAddress(terminalPath, address)).toEqual(expected);
        // AC2: the checkpoint path records exactly what the terminal path does.
        expect(byAddress(checkpointPath, address)).toEqual(expected);
      }
    });
  }

  it('records a sleep nested in a map in a branch as a top-level sleep, with a step after it (matrix row H7)', async () => {
    const events = await lifecycleOf('nested-sleep', [
      {
        kind: 'parallel',
        branches: {
          a: [list, { kind: 'map', over: 'items', steps: [{ kind: 'sleep', duration: 1 }] }],
        },
      },
      after,
    ]);
    const sleeps = events.filter((event) => String(event.data['stepAddress']).includes('.'));
    for (const address of ['3#a.0', '3#a.1']) {
      expect(byAddress(sleeps, address).map((event) => event.type)).toEqual([
        'file-workflow:step-started',
        'file-workflow:step-completed',
      ]);
      expect(byAddress(sleeps, address).map((event) => event.data['kind'])).toEqual([
        'sleep',
        'sleep',
      ]);
    }
  });

  it('still loads the history of a run persisted before nested steps recorded their completions', async () => {
    // AC3: a fixture dumped on `main`, where the steps of a map in a parallel branch had a start
    // and no completion. The events are read back as they were written, and nothing is amended.
    const entries = (await Bun.file(
      new URL('./__fixtures__/legacy-parallel/legacy-nested-history.json', import.meta.url),
    ).json()) as [string, string][];
    const storage = new MemoryStorage();
    for (const [key, encoded] of entries) await storage.put(key, Buffer.from(encoded, 'base64'));
    await using engine = new Engine({ storage });
    const events = await engine.getEvents('legacy-nested-history-run');
    const fileEvents = events
      .filter((event) => event.type.startsWith('file-workflow:'))
      .map(({ type, data }) => ({ type, data }));
    const nested = ['4#a.0', '4#a.1'].flatMap((address) => byAddress(fileEvents, address));
    expect(nested.map((event) => event.type)).toEqual([
      'file-workflow:step-started',
      'file-workflow:activity-started',
      'file-workflow:step-started',
      'file-workflow:activity-started',
    ]);
    expect(fileEvents.at(-1)).toEqual({
      type: 'file-workflow:run-terminal',
      data: { status: 'completed' },
    });
    expect(fileEvents).toHaveLength(17);
    const state = await engine.get('legacy-nested-history-run');
    expect(state?.status).toBe('completed');
  });
});
