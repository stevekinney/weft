/**
 * COR-2246: `{ kind: 'workflow', workflow, input? }` starts a registered workflow as a child with
 * `ctx.startChild` and continues with its result. The document pins the child's version in
 * `workflowVersions`, as it pins an activity in `activityVersions`; a host that has no such child
 * refuses the document. A document never runs `compensate`, so a new document may not name an
 * activity that defines one, while a revision that is already registered is exempt.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { waitForCondition } from "../../test-support/embedded/testing/src/fake-timers.ts";
import { rejectionOf, throwingRejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";

import { Engine } from '../core/engine/index.ts';
import { workflow, type WorkflowContext } from '../core/types.ts';
import {
  documentChildWorkflowId,
  validateWorkflowDocument,
  WorkflowDocumentValidationError,
  workflowDocumentVersion,
  type DocumentActivityArgument,
  type DocumentWorkflowHost,
} from './document.ts';
import { registerWorkflowDocuments } from './register.ts';

const seen: unknown[] = [];
const admitted: string[] = [];

/** `child` completes with what it was started with; `waits` parks on `kid-go`; `boom` fails. */
const child = workflow({ name: 'child', version: '1' }).execute(async function* (
  _context: WorkflowContext,
  input: unknown,
) {
  yield* [];
  seen.push(input);
  return { echoed: input };
});
const waits = workflow({ name: 'waits', version: '1' }).execute(async function* (
  context: WorkflowContext,
  input: unknown,
) {
  seen.push(input);
  const payload = yield* context.waitForSignal('kid-go');
  return { woke: payload };
});
const boom = workflow({ name: 'boom', version: '1' }).execute(async function* () {
  yield* [];
  throw new Error('the child exploded');
});

const host: DocumentWorkflowHost = {
  activities: {
    seed: () => ({ seeded: true }),
    echo: ({ input, previous }) => ({ input, previous }),
    list: () => ({ items: ['a', 'b'] }),
    withCompensate: { execute: () => 'done', compensate: () => undefined },
  },
  triggerKinds: { manual: () => undefined },
  workflows: ['child', 'waits', 'boom'],
  workflowVersions: { child: '1', waits: '1', boom: '1' },
};

const manual = { kind: 'manual' };
const step = (workflowName: string, input?: unknown) => ({
  kind: 'workflow',
  workflow: workflowName,
  ...(input === undefined ? {} : { input }),
});
const doc = (name: string, steps: readonly unknown[], extra: Record<string, unknown> = {}) => ({
  name,
  trigger: manual,
  steps,
  ...extra,
});

function issuesOf(input: unknown, againstHost: DocumentWorkflowHost = host, options?: object) {
  try {
    validateWorkflowDocument(input, againstHost, options);
  } catch (error) {
    if (error instanceof WorkflowDocumentValidationError) return error.issues;
    throw error;
  }
  return [];
}

async function engineWith(againstHost: DocumentWorkflowHost = host, storage = new MemoryStorage()) {
  const engine = new Engine({ storage, backgroundTasks: 'manual' });
  engine.register(child);
  engine.register(waits);
  engine.register(boom);
  return { engine, storage, host: againstHost };
}

async function statusOf(engine: Engine, id: string): Promise<string | undefined> {
  const state = await engine.get(id);
  return state?.status;
}

async function isParkedOn(engine: Engine, id: string, name: string): Promise<boolean> {
  const state = await engine.get(id);
  return state?.waitingForSignals?.includes(name) === true;
}

/** The ids of the runs of `type`, in order. */
async function runsOfType(engine: Engine, type: string): Promise<string[]> {
  const page = await engine.list({ type });
  return page.items.map((item) => item.id).toSorted();
}

async function childrenStarted(engine: Engine, type: string, count: number): Promise<boolean> {
  const page = await engine.list({ type });
  return page.total === count;
}

describe('validating a workflow step (F1, F2, F5, F6, F15)', () => {
  const rows: readonly [string, unknown, string | undefined][] = [
    ['a registered child', step('child'), undefined],
    ['a registered child with an input', step('child', { a: 1 }), undefined],
    ['an unknown child', step('nobody'), 'steps[0].workflow'],
    ['a child with no name', { kind: 'workflow' }, 'steps[0].workflow'],
    ['an empty name', step(''), 'steps[0].workflow'],
    ['an unknown key', { ...step('child'), extra: 1 }, 'steps[0]'],
    [
      'an unknown child in a branch case',
      { kind: 'branch', on: 'x', cases: { y: [step('nobody')] } },
      'steps[0].cases.y[0].workflow',
    ],
    [
      'an unknown child in a map',
      { kind: 'map', over: 'items', steps: [step('nobody')] },
      'steps[0].steps[0].workflow',
    ],
    [
      'an unknown child in a parallel branch',
      { kind: 'parallel', branches: { a: [step('nobody')] } },
      'steps[0].branches.a[0].workflow',
    ],
  ];
  for (const [name, row, path] of rows) {
    it(`${path === undefined ? 'accepts' : 'refuses'} ${name}`, () => {
      const issues = issuesOf(doc('shape', [row]));
      if (path === undefined) expect(issues).toEqual([]);
      else expect(issues.map((issue) => issue.path)).toContain(path);
    });
  }

  it('says an unknown child is not registered', () => {
    expect(issuesOf(doc('shape', [step('nobody')]))).toEqual([
      { path: 'steps[0].workflow', message: 'workflow "nobody" is not registered' },
    ]);
  });

  it('refuses every child when the host has none', () => {
    const { workflows: _workflows, workflowVersions: _versions, ...without } = host;
    expect(issuesOf(doc('shape', [step('child')]), without).map((issue) => issue.path)).toEqual([
      'steps[0].workflow',
    ]);
  });
});

describe('pinning workflow versions (F8, F9, F10, F11)', () => {
  const steps = [step('child'), { kind: 'activity', handler: 'seed' }];

  it('validates a pin the host honors', () => {
    expect(issuesOf(doc('pinned', steps, { workflowVersions: { child: '1' } }))).toEqual([]);
  });

  it('refuses a pin for a child no step calls', () => {
    expect(issuesOf(doc('pinned', steps, { workflowVersions: { waits: '1' } }))).toEqual([
      { path: 'workflowVersions.waits', message: 'no step calls the workflow "waits"' },
    ]);
  });

  it('refuses a pin at another version, and a pin when the host has no version', () => {
    expect(issuesOf(doc('pinned', steps, { workflowVersions: { child: '2' } }))).toEqual([
      {
        path: 'workflowVersions.child',
        message: 'workflow "child" is pinned at version "2", but this host has version "1"',
      },
    ]);
    const { workflowVersions: _versions, ...unversioned } = host;
    expect(
      issuesOf(doc('pinned', steps, { workflowVersions: { child: '1' } }), unversioned),
    ).toEqual([
      {
        path: 'workflowVersions.child',
        message: 'workflow "child" is pinned at version "1", but this host has no version of it',
      },
    ]);
  });

  it('is another revision when pinned to another version, and a document with no pin keeps its version', async () => {
    const unpinned = await workflowDocumentVersion(
      validateWorkflowDocument(doc('pinned', steps), host),
    );
    const one = await workflowDocumentVersion(
      validateWorkflowDocument(doc('pinned', steps, { workflowVersions: { child: '1' } }), host),
    );
    const two = await workflowDocumentVersion(
      validateWorkflowDocument(doc('pinned', steps, { workflowVersions: { child: '2' } }), {
        ...host,
        workflowVersions: { child: '2' },
      }),
    );
    expect(new Set([unpinned, one, two]).size).toBe(3);
    expect(validateWorkflowDocument(doc('pinned', steps), host)).not.toHaveProperty(
      'workflowVersions',
    );
  });
});

describe('running a workflow step (G1, G2, G9)', () => {
  it('starts the child with the step input and continues with its result as previous (G1)', async () => {
    seen.length = 0;
    const { engine } = await engineWith();
    await using _engine = engine;
    await registerWorkflowDocuments(engine, host, {
      active: [
        doc('calls-child', [
          { kind: 'activity', handler: 'seed' },
          step('child', { n: 1 }),
          { kind: 'activity', handler: 'echo', input: 'after' },
        ]),
      ],
    });
    const run = await engine.start('calls-child', null, { id: 'calls-child-run' });
    expect(await run.result()).toEqual({
      input: 'after',
      previous: { echoed: { n: 1 } },
    });
    // G9: without a host rule the child receives exactly the step's input, and no trigger.
    expect(seen).toEqual([{ n: 1 }]);
  });

  it('gives the child the input the host builds from the trigger (G9)', async () => {
    seen.length = 0;
    const calls: unknown[] = [];
    const shaping: DocumentWorkflowHost = {
      ...host,
      childInput: (argument) => {
        calls.push(argument);
        return { wrapped: argument.input, from: argument.trigger as never };
      },
    };
    const { engine } = await engineWith(shaping);
    await using _engine = engine;
    await registerWorkflowDocuments(engine, shaping, {
      active: [doc('shaped-child', [step('child', { n: 2 })])],
    });
    const run = await engine.start('shaped-child', { who: 'me' }, { id: 'shaped-child-run' });
    expect(await run.result()).toEqual({
      echoed: { wrapped: { n: 2 }, from: { who: 'me' } },
    });
    expect(calls).toEqual([
      {
        workflow: 'child',
        workflowId: 'shaped-child-run',
        trigger: { who: 'me' },
        input: { n: 2 },
        step: 0,
        stepAddress: '0',
      },
    ]);
  });

  it('fails the run when the child fails (G2)', async () => {
    const { engine } = await engineWith();
    await using _engine = engine;
    await registerWorkflowDocuments(engine, host, {
      active: [
        doc('fails-with-child', [step('boom'), { kind: 'activity', handler: 'echo', input: 'x' }]),
      ],
    });
    const run = await engine.start('fails-with-child', null, { id: 'fails-with-child-run' });
    expect(await throwingRejectionOf(run.result())).toThrow('the child exploded');
    expect(await statusOf(engine, 'fails-with-child-run')).toBe('failed');
  });

  it('waits for a child that parks, and continues once it is signalled (G3)', async () => {
    const { engine } = await engineWith();
    await using _engine = engine;
    await registerWorkflowDocuments(engine, host, {
      active: [doc('waits-for-child', [step('waits')])],
    });
    const run = await engine.start('waits-for-child', null, { id: 'waits-for-child-run' });
    const kidId = documentChildWorkflowId('waits-for-child-run', '0');
    await waitForCondition(async () => isParkedOn(engine, kidId, 'kid-go'), {
      label: 'the child to park',
    });
    expect(await statusOf(engine, 'waits-for-child-run')).toBe('running');
    await engine.signal(kidId, 'kid-go', 'now');
    expect(await run.result()).toEqual({ woke: 'now' });
  });
});

describe('the edges of a child step (G5, G12, O12)', () => {
  it('leaves the child running when the parent is cancelled, as the default policy does (G5)', async () => {
    const { engine } = await engineWith();
    await using _engine = engine;
    await registerWorkflowDocuments(engine, host, {
      active: [doc('cancelled-parent', [step('waits')])],
    });
    await engine.start('cancelled-parent', null, { id: 'cancelled-parent-run' });
    const kidId = documentChildWorkflowId('cancelled-parent-run', '0');
    await waitForCondition(async () => isParkedOn(engine, kidId, 'kid-go'), {
      label: 'the child to park',
    });
    await engine.cancel('cancelled-parent-run');
    expect(await statusOf(engine, 'cancelled-parent-run')).toBe('cancelled');
    expect(await statusOf(engine, kidId)).toBe('running');
  });

  it('fails the step when the child type is not registered when the step runs (G12)', async () => {
    const engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await using _engine = engine;
    await registerWorkflowDocuments(engine, host, { active: [doc('no-child', [step('child')])] });
    const run = await engine.start('no-child', null, { id: 'no-child-run' });
    expect(await throwingRejectionOf(run.result())).toThrow('No workflow registered');
  });
});

describe('the id of a child (G6, G7, G8)', () => {
  it('derives from the instance and the step address, and fits an id', () => {
    const id = documentChildWorkflowId('some-run', '3');
    expect(id).toMatch(/^workflow-child-[0-9a-f]{32}$/);
    expect(documentChildWorkflowId('some-run', '3')).toBe(id);
    expect(documentChildWorkflowId('some-run', '4')).not.toBe(id);
    expect(documentChildWorkflowId('other-run', '3')).not.toBe(id);
    expect(documentChildWorkflowId('x'.repeat(128), '1#a.0').length).toBeLessThanOrEqual(128);
  });

  it('starts a distinct child for each iteration of a map (G7)', async () => {
    seen.length = 0;
    const { engine } = await engineWith();
    await using _engine = engine;
    await registerWorkflowDocuments(engine, host, {
      active: [
        doc('maps-children', [
          { kind: 'activity', handler: 'list' },
          { kind: 'map', over: 'items', steps: [step('child')] },
        ]),
      ],
    });
    const run = await engine.start('maps-children', null, { id: 'maps-children-run' });
    expect(await run.result()).toEqual([{ echoed: null }, { echoed: null }]);
    expect(await runsOfType(engine, 'child')).toEqual(
      [
        documentChildWorkflowId('maps-children-run', '2#0'),
        documentChildWorkflowId('maps-children-run', '2#1'),
      ].toSorted(),
    );
  });

  it('starts a distinct child for each branch of a parallel step', async () => {
    const { engine } = await engineWith();
    await using _engine = engine;
    await registerWorkflowDocuments(engine, host, {
      active: [
        doc('parallel-children', [
          {
            kind: 'parallel',
            branches: { left: [step('child', 'L')], right: [step('child', 'R')] },
          },
        ]),
      ],
    });
    const run = await engine.start('parallel-children', null, { id: 'parallel-children-run' });
    expect(await run.result()).toEqual({ left: { echoed: 'L' }, right: { echoed: 'R' } });
    expect(await runsOfType(engine, 'child')).toHaveLength(2);
  });

  it('starts one child for each instance of one document, with no collision (G8)', async () => {
    const { engine } = await engineWith();
    await using _engine = engine;
    await registerWorkflowDocuments(engine, host, {
      active: [doc('twice-children', [step('child', 'same')])],
    });
    const first = await engine.start('twice-children', null, { id: 'twice-one' });
    const second = await engine.start('twice-children', null, { id: 'twice-two' });
    expect(await first.result()).toEqual({ echoed: 'same' });
    expect(await second.result()).toEqual({ echoed: 'same' });
    expect(await runsOfType(engine, 'child')).toHaveLength(2);
  });
});

describe('a workflow step that is re-issued after a restart (G14, O15)', () => {
  it('re-attaches to the child it already started, in a parallel round, once per restart', async () => {
    const storage = new MemoryStorage();
    const document = doc('reissue-parallel', [
      {
        kind: 'parallel',
        branches: {
          kid: [step('waits', 'in-parallel')],
          gate: [{ kind: 'await-signal', signal: 'go' }],
        },
      },
    ]);
    const kidId = documentChildWorkflowId('reissue-parallel-run', '2#kid');
    {
      const { engine } = await engineWith(host, storage);
      await using _original = engine;
      await registerWorkflowDocuments(engine, host, { active: [document] });
      await engine.start('reissue-parallel', null, { id: 'reissue-parallel-run' });
      await waitForCondition(async () => isParkedOn(engine, kidId, 'kid-go'), {
        label: 'the child to start',
      });
    }
    for (const restart of [1, 2]) {
      const { engine } = await engineWith(host, storage);
      await using _restarted = engine;
      await registerWorkflowDocuments(engine, host, { active: [document] });
      await engine.recoverAll();
      await waitForCondition(async () => isParkedOn(engine, kidId, 'kid-go'), {
        label: `restart ${String(restart)}`,
      });
      expect(await statusOf(engine, 'reissue-parallel-run')).toBe('running');
      expect(await runsOfType(engine, 'waits')).toEqual([kidId]);
    }
    const { engine } = await engineWith(host, storage);
    await using _last = engine;
    await registerWorkflowDocuments(engine, host, { active: [document] });
    await engine.recoverAll();
    await engine.signal(kidId, 'kid-go', 'k');
    await engine.signal('reissue-parallel-run', 'go', 'g');
    const handle = await engine.getHandle('reissue-parallel-run');
    expect(await handle.result()).toEqual({ kid: { woke: 'k' }, gate: 'g' });
    expect(await runsOfType(engine, 'waits')).toEqual([kidId]);
  });

  it('continues with the result of a child that finished beside an open wait, and starts no second one (H4)', async () => {
    seen.length = 0;
    const storage = new MemoryStorage();
    const document = doc('reissue-finished', [
      {
        kind: 'parallel',
        branches: {
          kid: [step('child', 'once')],
          gate: [{ kind: 'await-signal', signal: 'go' }],
        },
      },
    ]);
    const kidId = documentChildWorkflowId('reissue-finished-run', '2#kid');
    {
      const { engine } = await engineWith(host, storage);
      await using _original = engine;
      await registerWorkflowDocuments(engine, host, { active: [document] });
      await engine.start('reissue-finished', null, { id: 'reissue-finished-run' });
      await waitForCondition(async () => (await statusOf(engine, kidId)) === 'completed', {
        label: 'the child to finish',
      });
    }
    for (const restart of [1, 2]) {
      const { engine } = await engineWith(host, storage);
      await using _restarted = engine;
      await registerWorkflowDocuments(engine, host, { active: [document] });
      await engine.recoverAll();
      await waitForCondition(async () => isParkedOn(engine, 'reissue-finished-run', 'go'), {
        label: `restart ${String(restart)}`,
      });
      expect(await runsOfType(engine, 'child')).toEqual([kidId]);
    }
    const { engine } = await engineWith(host, storage);
    await using _last = engine;
    await registerWorkflowDocuments(engine, host, { active: [document] });
    await engine.recoverAll();
    await engine.signal('reissue-finished-run', 'go', 'g');
    const handle = await engine.getHandle('reissue-finished-run');
    expect(await handle.result()).toEqual({ kid: { echoed: 'once' }, gate: 'g' });
    // The child ran once, before the first restart; no restart ran it again.
    expect(seen).toEqual(['once']);
  });

  it('re-attaches to the child of a map batch the same way', async () => {
    const storage = new MemoryStorage();
    const document = doc('reissue-map', [
      { kind: 'activity', handler: 'list' },
      { kind: 'map', over: 'items', steps: [step('waits')] },
    ]);
    {
      const { engine } = await engineWith(host, storage);
      await using _original = engine;
      await registerWorkflowDocuments(engine, host, { active: [document] });
      await engine.start('reissue-map', null, { id: 'reissue-map-run' });
      await waitForCondition(async () => childrenStarted(engine, 'waits', 2), {
        label: 'both children to start',
      });
    }
    const { engine } = await engineWith(host, storage);
    await using _restarted = engine;
    await registerWorkflowDocuments(engine, host, { active: [document] });
    await engine.recoverAll();
    const ids = [
      documentChildWorkflowId('reissue-map-run', '2#0'),
      documentChildWorkflowId('reissue-map-run', '2#1'),
    ];
    await waitForCondition(
      async () => {
        const parked = await Promise.all(ids.map((id) => isParkedOn(engine, id, 'kid-go')));
        return parked.every(Boolean);
      },
      { label: 'both children to wait again' },
    );
    expect(await runsOfType(engine, 'waits')).toEqual(ids.toSorted());
    for (const id of ids) await engine.signal(id, 'kid-go', id.length);
    const handle = await engine.getHandle('reissue-map-run');
    expect(await handle.result()).toHaveLength(2);
  });
});

describe('the admission of a child (O13)', () => {
  const admitting = (refuse: boolean): DocumentWorkflowHost => ({
    ...host,
    workflowAdmission: {
      execute: (argument: DocumentActivityArgument) => {
        admitted.push(`${argument.workflowId}@${argument.stepAddress ?? ''}`);
        if (refuse) throw new Error('authority revoked');
        return null;
      },
    },
  });

  it('runs before the child starts, and its result is not the previous result', async () => {
    admitted.length = 0;
    const admittingHost = admitting(false);
    const { engine } = await engineWith(admittingHost);
    await using _engine = engine;
    await registerWorkflowDocuments(engine, admittingHost, {
      active: [doc('admits', [{ kind: 'activity', handler: 'seed' }, step('child', 'in')])],
    });
    const run = await engine.start('admits', null, { id: 'admits-run' });
    expect(await run.result()).toEqual({ echoed: 'in' });
    expect(admitted).toEqual(['admits-run@1']);
  });

  it('refuses the step, and starts no child, when the check throws', async () => {
    admitted.length = 0;
    const refusing = admitting(true);
    const { engine } = await engineWith(refusing);
    await using _engine = engine;
    await registerWorkflowDocuments(engine, refusing, {
      active: [doc('refused', [step('child')])],
    });
    const run = await engine.start('refused', null, { id: 'refused-run' });
    expect(await throwingRejectionOf(run.result())).toThrow('authority revoked');
    expect(await runsOfType(engine, 'child')).toEqual([]);
  });

  it('adds nothing to a document with no workflow step, so its revision is unchanged', async () => {
    const plain = doc('plain', [{ kind: 'activity', handler: 'seed' }]);
    const withAdmission = admitting(false);
    const { engine: plainEngine } = await engineWith();
    await using _plain = plainEngine;
    const { engine: admittingEngine } = await engineWith(withAdmission);
    await using _admitting = admittingEngine;
    const [a] = await registerWorkflowDocuments(plainEngine, host, { active: [plain] });
    const [b] = await registerWorkflowDocuments(admittingEngine, withAdmission, {
      active: [plain],
    });
    expect(b?.revision).toBe(a?.revision);
  });
});

describe('refusing compensate (F12, F13, F14, I1)', () => {
  const calling = (handler: string) => doc('compensating', [{ kind: 'activity', handler }]);

  it('refuses an activity that defines compensate, at its handler (F12)', () => {
    expect(issuesOf(calling('withCompensate'))).toEqual([
      {
        path: 'steps[0].handler',
        message:
          'activity handler "withCompensate" defines "compensate", which a document never runs; remove it from the activity or call another',
      },
    ]);
  });

  it('refuses it nested in a branch, and when pinned like any other activity', () => {
    expect(
      issuesOf(
        doc('compensating', [
          {
            kind: 'branch',
            on: 'x',
            cases: { y: [{ kind: 'activity', handler: 'withCompensate' }] },
          },
        ]),
      ).map((issue) => issue.path),
    ).toEqual(['steps[0].cases.y[0].handler']);
  });

  it('accepts a bare function and a definition with no compensate (F13)', () => {
    expect(issuesOf(calling('seed'))).toEqual([]);
    expect(
      issuesOf(calling('plain'), {
        ...host,
        activities: { plain: { execute: () => 1, description: 'no compensate' } },
      }),
    ).toEqual([]);
  });

  it('accepts it for a revision that is already registered (I1, O14)', () => {
    expect(issuesOf(calling('withCompensate'), host, { allowCompensate: true })).toEqual([]);
  });

  it('refuses it in an active document and accepts it in a retained one', async () => {
    const { engine } = await engineWith();
    await using _engine = engine;
    const refusal = await rejectionOf(
      registerWorkflowDocuments(engine, host, { active: [calling('withCompensate')] }),
    );
    expect(refusal).toBeInstanceOf(WorkflowDocumentValidationError);
    const [retained] = await registerWorkflowDocuments(engine, host, {
      active: [],
      retained: [calling('withCompensate')],
    });
    expect(retained?.name).toBe('compensating');
  });
});
