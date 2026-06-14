/**
 * Phase 3 runtime tests for the engine + workflow-builder integration:
 *   - registering a builder workflow populates the per-workflow ActivityRegistry
 *   - same-reference re-registration is a no-op; same-name-different-ref throws
 *   - per-workflow activity isolation (workflow A's `formatGreeting` is not
 *     resolvable from workflow B's dispatch path)
 *   - `engine.registerWorkflows({...})` accepts a map and validates key=name
 *   - `ActivityResolutionError` shape on a true miss
 *   - `PersistedDataIncompatibleError` on a storage written with an older
 *     schema version
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  CURRENT_PERSISTED_DATA_SCHEMA_VERSION,
  PERSISTED_DATA_SCHEMA_VERSION_KEY,
} from '../persisted-data-incompatible-error.ts';
import { workflow } from '../types/workflow-function.ts';
import { ActivityResolutionError, Engine, PersistedDataIncompatibleError } from './index.ts';
import { getInternals } from './internals.ts';

// Engines created in this test file are tracked here so `afterEach` disposes
// them, mirroring the project's `engine[Symbol.dispose]()` discipline. Without
// this, background timers and pending micro-tasks would leak between tests and
// surface as non-deterministic flakes under parallel execution.
const engines: Disposable[] = [];

function track<TEngine extends Disposable>(engine: TEngine): TEngine {
  engines.push(engine);
  return engine;
}

afterEach(() => {
  while (engines.length > 0) {
    const engine = engines.pop();
    engine?.[Symbol.dispose]();
  }
});

describe('engine + workflow-builder integration', () => {
  it('register(builderWorkflow) populates the per-workflow ActivityRegistry', () => {
    const welcome = workflow({ name: 'welcome' })
      .activities({
        formatGreeting: async (input: { name: string }) => `Hello, ${input.name}!`,
      })
      .execute(async function* (ctx, input: { name: string }) {
        return yield* ctx.run('formatGreeting', input);
      });

    const engine = track(new Engine());
    engine.register(welcome);

    const perWorkflow = getInternals(engine).activityRegistriesByWorkflow.get('welcome');
    expect(perWorkflow).toBeDefined();
    expect(perWorkflow?.has('formatGreeting')).toBe(true);
    // Global registry stays empty for this transitional period — Phase 6
    // removes the global path entirely.
    expect(getInternals(engine).activityRegistry.has('formatGreeting')).toBe(false);
  });

  it('register(workflow) is idempotent for the same definition reference', () => {
    const welcome = workflow({ name: 'welcome' })
      .activities({ ping: async () => 'pong' })
      .execute(async function* () {
        return 'ok';
      });

    const engine = track(new Engine());
    engine.register(welcome);
    // Second call with the SAME object reference is a no-op. No throw.
    expect(() => engine.register(welcome)).not.toThrow();
  });

  it('register(workflow) throws when re-registering a different definition under the same name', () => {
    const welcomeA = workflow({ name: 'welcome' })
      .activities({ ping: async () => 'pong-a' })
      .execute(async function* () {
        return 'a';
      });
    const welcomeB = workflow({ name: 'welcome' })
      .activities({ ping: async () => 'pong-b' })
      .execute(async function* () {
        return 'b';
      });

    const engine = track(new Engine());
    engine.register(welcomeA);
    expect(() => engine.register(welcomeB)).toThrow(
      'Workflow "welcome" is already registered with a different definition',
    );
  });

  it('per-workflow activity registries are isolated by workflow type', async () => {
    const greeter = workflow({ name: 'greeter' })
      .activities({ work: async () => 'greeter-result' })
      .execute(async function* (ctx) {
        return yield* ctx.run('work');
      });
    const farewell = workflow({ name: 'farewell' })
      .activities({ work: async () => 'farewell-result' })
      .execute(async function* (ctx) {
        return yield* ctx.run('work');
      });

    const engine = track(new Engine());
    engine.register(greeter);
    engine.register(farewell);

    const greeterHandle = await engine.start('greeter', undefined);
    const farewellHandle = await engine.start('farewell', undefined);

    expect(await greeterHandle.result()).toBe('greeter-result');
    expect(await farewellHandle.result()).toBe('farewell-result');
  });

  it('ActivityResolutionError surfaces when neither the per-workflow nor global registry knows the name', async () => {
    const broken = workflow({ name: 'broken' })
      .activities({ realActivity: async () => 'ok' })
      .execute(async function* (ctx) {
        // Reference an activity name the workflow's registry does not carry.
        return yield* ctx.run('unknownActivity' as never, undefined as never);
      });

    const engine = track(new Engine());
    engine.register(broken);
    const handle = await engine.start('broken', undefined);

    // The engine rethrows activity failures as plain `Error` after serializing
    // them through the failure pipeline, so we assert on the message which
    // carries the bounded {workflowType, activityName} context. Direct
    // construction in another test pins the structured fields on the class
    // itself.
    await expect(handle.result()).rejects.toThrow(
      'No activity registered with name "unknownActivity" for workflow type "broken"',
    );
  });

  it('ActivityResolutionError carries structured workflowType/activityName fields', () => {
    const error = new ActivityResolutionError('greeter', 'formatGreeting');
    expect(error).toBeInstanceOf(ActivityResolutionError);
    expect(error.name).toBe('ActivityResolutionError');
    expect(error.code).toBe('ActivityResolutionError');
    expect(error.workflowType).toBe('greeter');
    expect(error.activityName).toBe('formatGreeting');
  });

  it('registerWorkflows({ key }) widens the engine and validates key=name', () => {
    const welcome = workflow({ name: 'welcome' })
      .activities({ ping: async () => 'pong' })
      .execute(async function* () {
        return 'ok';
      });

    const engine = track(new Engine());
    const widened = engine.registerWorkflows({ welcome });
    expect(widened.getWorkflowDefinition('welcome')).toBeDefined();

    // Key/name disagreement throws synchronously.
    const renamedWelcome = workflow({ name: 'welcome' })
      .activities({ ping: async () => 'pong' })
      .execute(async function* () {
        return 'ok';
      });
    const engine2 = track(new Engine());
    expect(() => engine2.registerWorkflows({ wrong: renamedWelcome })).toThrow(
      /key "wrong" does not match definition name "welcome"/,
    );
  });

  it('searchAttributes from the builder are wired onto the workflow registration', async () => {
    const tracked = workflow({ name: 'tracked' })
      .searchAttributes({ customerId: { type: 'string' } })
      .execute(async function* (ctx, input: { customerId: string }) {
        // Confirms the schema is enforced — setting an unknown attribute on a
        // schema-bound workflow throws. The dual check is that this call,
        // which uses a registered attribute name, does NOT throw.
        ctx.setAttribute('customerId', input.customerId);
        yield* ctx.run(async () => 'noop', undefined);
        return input.customerId;
      });

    const engine = track(new Engine());
    engine.register(tracked);

    const definition = engine.getWorkflowDefinition('tracked');
    expect(definition?.searchAttributes).toEqual({ customerId: { type: 'string' } });

    const handle = await engine.start('tracked', { customerId: 'cust_42' });
    expect(await handle.result()).toBe('cust_42');
  });

  it('hot-add after start: registerWorkflows is callable post-construction', async () => {
    const a = workflow({ name: 'a' })
      .activities({ work: async () => 'a' })
      .execute(async function* (ctx) {
        return yield* ctx.run('work');
      });
    const b = workflow({ name: 'b' })
      .activities({ work: async () => 'b' })
      .execute(async function* (ctx) {
        return yield* ctx.run('work');
      });

    const engine = track(new Engine());
    engine.register(a);
    const handleA = await engine.start('a', undefined);
    expect(await handleA.result()).toBe('a');

    engine.register(b);
    const handleB = await engine.start('b', undefined);
    expect(await handleB.result()).toBe('b');
  });
});

describe('persisted data schema gate', () => {
  it('Engine.create stamps a fresh storage with the current schema version', async () => {
    const storage = new MemoryStorage();
    await using engine = await Engine.create({ storage });
    const stored = await storage.get(PERSISTED_DATA_SCHEMA_VERSION_KEY);
    expect(stored).not.toBeNull();
    const value = stored ? new TextDecoder().decode(stored) : '';
    expect(Number.parseInt(value, 10)).toBe(CURRENT_PERSISTED_DATA_SCHEMA_VERSION);
    void engine;
  });

  it('Engine.create rejects storage stamped with an older schema version', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      PERSISTED_DATA_SCHEMA_VERSION_KEY,
      new TextEncoder().encode(String(CURRENT_PERSISTED_DATA_SCHEMA_VERSION - 1)),
    );

    let caught: unknown;
    try {
      await Engine.create({ storage });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PersistedDataIncompatibleError);
    const error = caught as PersistedDataIncompatibleError;
    expect(error.foundVersion).toBe(CURRENT_PERSISTED_DATA_SCHEMA_VERSION - 1);
    expect(error.expectedVersion).toBe(CURRENT_PERSISTED_DATA_SCHEMA_VERSION);
  });

  it('Engine.create rejects storage stamped with an unparseable schema version', async () => {
    const storage = new MemoryStorage();
    await storage.put(PERSISTED_DATA_SCHEMA_VERSION_KEY, new TextEncoder().encode('not-a-number'));

    let caught: unknown;
    try {
      await Engine.create({ storage });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PersistedDataIncompatibleError);
    expect((caught as PersistedDataIncompatibleError).foundVersion).toBeNull();
  });

  it('Engine.create rejects storage stamped with an unsafe integer schema version', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      PERSISTED_DATA_SCHEMA_VERSION_KEY,
      new TextEncoder().encode(String(Number.MAX_SAFE_INTEGER + 1)),
    );

    let caught: unknown;
    try {
      await Engine.create({ storage });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PersistedDataIncompatibleError);
    expect((caught as PersistedDataIncompatibleError).foundVersion).toBeNull();
  });

  it('Engine.create rejects unstamped user data when no schema version sentinel exists', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEYS.workflow('unstamped-workflow'), new Uint8Array());

    let caught: unknown;
    try {
      await Engine.create({ storage });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PersistedDataIncompatibleError);
    expect((caught as PersistedDataIncompatibleError).foundVersion).toBeNull();
  });

  it('Engine.create rejects storage stamped with a future schema version', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      PERSISTED_DATA_SCHEMA_VERSION_KEY,
      new TextEncoder().encode(String(CURRENT_PERSISTED_DATA_SCHEMA_VERSION + 1)),
    );

    let caught: unknown;
    try {
      await Engine.create({ storage });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PersistedDataIncompatibleError);
    expect((caught as PersistedDataIncompatibleError).foundVersion).toBe(
      CURRENT_PERSISTED_DATA_SCHEMA_VERSION + 1,
    );
  });
});
