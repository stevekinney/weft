import { describe, expect, it } from 'bun:test';

import { rejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { UndeclaredWorkflowMessageError } from './engine/declared-messages.ts';
import { ActivityResolutionError } from './engine/errors.ts';
import { ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING, Engine } from './engine/index.ts';
import { activity } from './types/activity.ts';
import { query, signal, update } from './types/message-handles.ts';
import { WorkflowBuilderError } from './types/workflow-builder-runtime.ts';
import { createWorkflowFactory } from './workflow-factory.ts';

const greet = activity({ name: 'greet', execute: async (name: string) => `Hello, ${name}` });
const audit = activity({ name: 'audit', execute: async () => 'audited' });
const approve = signal<{ approverId: string }>('approve');

describe('createWorkflowFactory() — shared entries', () => {
  it('declares shared activities as .uses() entries and shares the message maps', () => {
    const { workflow } = createWorkflowFactory({
      activities: { greet },
      signals: { approve },
      updates: { check: update<{ id: string }, { ok: boolean }>('check') },
      queries: { progress: query<void, number>('progress') },
    });

    const first = workflow({ name: 'first' }).execute(async function* () {
      return 1;
    });
    const second = workflow({ name: 'second' }).execute(async function* () {
      return 2;
    });

    for (const built of [first, second]) {
      expect(built.activities).toEqual({});
      expect(Object.keys(built.uses ?? {})).toEqual(['greet']);
      expect(built.uses?.['greet']).toEqual({ name: 'greet' });
      expect(Object.keys(built.signals)).toEqual(['approve']);
      expect(Object.keys(built.updates)).toEqual(['check']);
      expect(Object.keys(built.queries)).toEqual(['progress']);
    }
    // Each workflow freezes its own copy, so one cannot reach another's.
    expect(first.uses?.['greet']).not.toBe(second.uses?.['greet']);
    expect(Object.isFrozen(first.uses?.['greet'])).toBe(true);
  });

  it('exposes the shared activity definitions, frozen', () => {
    const factory = createWorkflowFactory({ activities: { greet } });
    expect(factory.activities).toEqual({ greet });
    expect(factory.activities.greet).toBe(greet);
    expect(Object.isFrozen(factory.activities)).toBe(true);
  });

  it('merges a workflow’s own entries onto the shared ones', () => {
    const { workflow } = createWorkflowFactory({
      activities: { greet },
      signals: { approve },
      updates: { check: update<void, boolean>('check') },
      queries: { progress: query<void, number>('progress') },
    });

    const built = workflow({ name: 'merged' })
      .activities({ shout: async (text: string) => text.toUpperCase() })
      .uses({ audit })
      .signals({ reject: signal<{ reason: string }>('reject') })
      .updates({ rename: update<string, boolean>('rename') })
      .queries({ status: query<void, string>('status') })
      .execute(async function* () {
        return 0;
      });

    expect(Object.keys(built.activities)).toEqual(['shout']);
    expect(Object.keys(built.uses ?? {})).toEqual(['greet', 'audit']);
    expect(Object.keys(built.signals)).toEqual(['approve', 'reject']);
    expect(Object.keys(built.updates)).toEqual(['check', 'rename']);
    expect(Object.keys(built.queries)).toEqual(['progress', 'status']);
  });

  it('builds plain workflows when given no entries', () => {
    const { workflow } = createWorkflowFactory({});
    const built = workflow({ name: 'plain' })
      .activities({ ping: async () => 'pong' })
      .execute(async function* () {
        return 0;
      });
    expect(Object.keys(built.activities)).toEqual(['ping']);
    expect(built).not.toHaveProperty('uses');
    expect(built.signals).toEqual({});
  });

  it('does not see later mutation of the maps it was given', () => {
    const signals: Record<string, typeof approve> = { approve };
    const activities: Record<string, typeof greet | typeof audit> = { greet };
    const { workflow } = createWorkflowFactory({ activities, signals });
    signals['late'] = signal<{ approverId: string }>('late');
    activities['audit'] = audit;
    const built = workflow({ name: 'snapshot' }).execute(async function* () {
      return 0;
    });
    expect(Object.keys(built.signals)).toEqual(['approve']);
    expect(Object.keys(built.uses ?? {})).toEqual(['greet']);
  });

  it('snapshots each shared activity schema at factory creation', () => {
    const inputSchema = {
      '~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) },
      title: 'before',
    };
    const described = activity({
      name: 'described',
      inputSchema: inputSchema as never,
      execute: async (value: string) => value,
    });
    const { workflow } = createWorkflowFactory({ activities: { described } });
    inputSchema.title = 'after';
    const built = workflow({ name: 'described-later' }).execute(async function* () {
      return 0;
    });
    expect(built.uses?.['described']?.inputSchema).toMatchObject({ title: 'before' });
  });

  it('keeps a __proto__ message key as an own entry', () => {
    const signals = Object.fromEntries([['__proto__', signal('__proto__')]]);
    const { workflow } = createWorkflowFactory({ signals });
    const built = workflow({ name: 'proto' }).execute(async function* () {
      return 0;
    });
    expect(Object.keys(built.signals)).toEqual(['__proto__']);
  });

  it('snapshots each shared message definition, not only the maps', () => {
    const definition = { name: 'approve' };
    const { workflow } = createWorkflowFactory({ signals: { approve: definition } });
    const first = workflow({ name: 'first' }).execute(async function* () {
      return 0;
    });
    definition.name = 'reject';
    const second = workflow({ name: 'second' }).execute(async function* () {
      return 0;
    });
    expect(first.signals['approve']?.name).toBe('approve');
    expect(second.signals['approve']?.name).toBe('approve');
  });
});

describe('createWorkflowFactory() — conflicts and validation', () => {
  const { workflow } = createWorkflowFactory({
    activities: { greet },
    signals: { approve },
    updates: { check: update<void, boolean>('check') },
    queries: { progress: query<void, number>('progress') },
  });

  // The type layer rejects these too; the casts reach the runtime check that
  // untyped callers hit.
  type Untyped = Record<string, (map: object) => unknown>;
  const cases: Array<[method: string, map: object, name: string]> = [
    ['activities', { greet: async () => 'again' }, 'greet'],
    ['uses', { greet }, 'greet'],
    ['signals', { approve }, 'approve'],
    ['updates', { check: update<void, boolean>('check') }, 'check'],
    ['queries', { progress: query<void, number>('progress') }, 'progress'],
  ];

  for (const [method, map, name] of cases) {
    it(`rejects .${method}() redeclaring a shared name`, () => {
      const builder = workflow({ name: 'conflict' }) as unknown as Untyped;
      const error = (() => {
        try {
          builder[method]!(map);
        } catch (thrown) {
          return thrown;
        }
        return undefined;
      })();
      expect(error).toBeInstanceOf(WorkflowBuilderError);
      expect((error as Error).message).toContain(
        `.${method}() declares "${name}", which the workflow factory already declares`,
      );
    });
  }

  it('rejects a local message under another key with a shared runtime name', () => {
    const builder = workflow({ name: 'alias' }) as unknown as Untyped;
    expect(() => builder['signals']!({ localApprove: signal('approve') })).toThrow(
      '.signals() declares "localApprove" with runtime name "approve", which the workflow factory already declares',
    );
    expect(() =>
      (workflow({ name: 'alias' }) as unknown as Untyped)['queries']!({
        localProgress: query<void, number>('progress'),
      }),
    ).toThrow(WorkflowBuilderError);
  });

  it('rejects a local key that is a shared runtime name, and the reverse', () => {
    const { workflow: aliased } = createWorkflowFactory({
      signals: { factoryAlias: signal<{ a: string }>('approve') },
    });
    const keyClash = aliased({ name: 'cross' }) as unknown as Untyped;
    expect(() => keyClash['signals']!({ approve: signal<{ b: number }>('local') })).toThrow(
      '.signals() declares "approve", which the workflow factory already declares',
    );
    const nameClash = aliased({ name: 'cross' }) as unknown as Untyped;
    expect(() => nameClash['signals']!({ other: signal('factoryAlias') })).toThrow(
      '.signals() declares "other" with runtime name "factoryAlias", which the workflow factory already declares',
    );
  });

  it('rejects shared message maps whose entries occupy the same name', () => {
    expect(() =>
      createWorkflowFactory({ signals: { first: signal('second'), second: signal('third') } }),
    ).toThrow('signals entry "second" occupies the name "second"');
    expect(() =>
      createWorkflowFactory({ queries: { first: query('shared'), second: query('shared') } }),
    ).toThrow(WorkflowBuilderError);
  });

  it('validates shared activities like .uses() does', () => {
    expect(() => createWorkflowFactory({ activities: { salute: greet } as never })).toThrow(
      /\.uses\(\): entry "salute" must be an activity definition named "salute"/,
    );
    expect(() =>
      createWorkflowFactory({ activities: { greet: async () => 'bare' } as never }),
    ).toThrow(WorkflowBuilderError);
  });

  it('validates the workflow name like workflow() does', () => {
    expect(() => workflow({ name: 'bad.name' })).toThrow(/workflow name "bad\.name"/);
    expect(() => workflow({ name: '' })).toThrow(
      'workflow() requires an options object with a name.',
    );
  });
});

describe('createWorkflowFactory() — on an engine', () => {
  const { workflow, createEngine } = createWorkflowFactory({
    activities: { greet },
    signals: { approve },
  });

  const welcome = workflow({ name: 'welcome' })
    .activities({ shout: async (text: string) => text.toUpperCase() })
    .execute(async function* (ctx, name: string) {
      const greeting = yield* ctx.run('greet', name);
      const { approverId } = yield* ctx.waitForSignal('approve');
      return { greeting: yield* ctx.run('shout', greeting), approverId };
    });
  const farewell = workflow({ name: 'farewell' }).execute(async function* (ctx, name: string) {
    return yield* ctx.run('greet', name);
  });

  it('registers the workflows and the shared activities in one call, and runs them', async () => {
    await using engine = await createEngine({ workflows: { welcome, farewell }, recover: false });

    // Shared activities are engine-provided; workflow-scoped ones stay scoped.
    expect(engine.listActivityDefinitions().map((entry) => entry.name)).toEqual(['greet']);
    expect(engine.listWorkflowActivityDefinitions('welcome').map((entry) => entry.name)).toEqual([
      'shout',
    ]);
    expect(Object.keys(engine.getWorkflowDefinition('farewell')?.uses ?? {})).toEqual(['greet']);
    expect(Object.keys(engine.getWorkflowDefinition('farewell')?.signals ?? {})).toEqual([
      'approve',
    ]);

    const welcomeHandle = await engine.start('welcome', 'Ada');
    await engine.signal(welcomeHandle.id, approve, { approverId: 'user-1' });
    expect(await welcomeHandle.result()).toEqual({
      greeting: 'HELLO, ADA',
      approverId: 'user-1',
    });

    const farewellHandle = await engine.start('farewell', 'Grace');
    expect(await farewellHandle.result()).toBe('Hello, Grace');
  });

  it('closes the shared message sets for every workflow it builds', async () => {
    const parked = workflow({ name: 'parked' }).execute(async function* (ctx) {
      return (yield* ctx.waitForSignal('approve')).approverId;
    });
    await using engine = await createEngine({ workflows: { parked }, recover: false });
    const handle = await engine.start('parked', undefined);
    await engine[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](handle.id);

    const error = await rejectionOf(handle.signal('reject', 'nope'));
    expect(error).toBeInstanceOf(UndeclaredWorkflowMessageError);
    expect(error).toMatchObject({ messageName: 'reject', declaredNames: ['approve'] });

    await handle.signal(approve, { approverId: 'user-2' });
    expect(await handle.result()).toBe('user-2');
  });

  it('registers extra engine-provided activities a workflow adds with .uses()', async () => {
    const audited = workflow({ name: 'audited' })
      .uses({ audit })
      .execute(async function* (ctx, name: string) {
        return `${yield* ctx.run('greet', name)} ${yield* ctx.run('audit')}`;
      });
    await using engine = await createEngine({
      workflows: { audited },
      activities: { audit, greet },
      recover: false,
    });
    const handle = await engine.start('audited', 'Ada');
    expect(await handle.result()).toBe('Hello, Ada audited');
  });

  it('refuses to create an engine missing an activity a workflow uses', async () => {
    const audited = workflow({ name: 'audited' })
      .uses({ audit })
      .execute(async function* (ctx) {
        return yield* ctx.run('audit');
      });
    const error = await rejectionOf(createEngine({ workflows: { audited }, recover: false }));
    expect(error).toBeInstanceOf(ActivityResolutionError);
    expect(error).toMatchObject({ workflowType: 'audited', activityName: 'audit' });
  });

  it('refuses a different activity under a name the factory provides', async () => {
    const impostor = activity({ name: 'greet', execute: async () => 'not the shared one' });
    const error = await rejectionOf(
      createEngine({ workflows: { farewell }, activities: { greet: impostor }, recover: false }),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain(
      'activity "greet" is already provided by the workflow factory',
    );
  });

  it('fails the run clearly when an engine created without the companion lacks a shared activity', async () => {
    await using engine = await Engine.create({ workflows: { farewell }, recover: false });
    const handle = await engine.start('farewell', 'Grace');
    const error = await rejectionOf(handle.result());
    expect((error as Error).message).toContain(
      'No activity registered with name "greet" for workflow type "farewell"',
    );
  });
});
