import { describe, expect, it, mock, spyOn } from 'bun:test';
import { sleepForTesting, withTimeout } from '../testing/fake-timers.ts';

import type { ScanOptions, Storage as WeftStorage } from '../storage/interface.ts';
import { encodeStorageKeyComponent, KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { AtomicStateConflictEvent } from './atomic-state.ts';
import { decode, encode } from './codec.ts';
import type { Context, StreamReference } from './context.ts';
import { computeSemanticHash, EffectLog } from './effect-log/index.ts';
import {
  Engine,
  ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING,
  ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING,
  EngineCreateNameMismatchError,
  WorkflowHandle,
} from './engine.ts';
import {
  CheckpointSizeWarningEvent,
  CleanupWarningEvent,
  DevelopmentWarningEvent,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowStartedEvent,
  WorkflowTimedOutEvent,
} from './events.ts';
import { InlineExecutionStrategy } from './inline-execution-strategy.ts';
import type { ActivityInterceptor, WorkflowInterceptor } from './interceptor.ts';
import { ListFilterValidationError } from './list-filter-validation.ts';
import { tenantFromInputField } from './tenant.ts';
import { WorkflowTimeoutError } from './timeouts.ts';
import type {
  DefinitionSchema,
  TimerEntry,
  WorkerOutboundMessage,
  WorkflowContext,
  WorkflowState,
} from './types.ts';
import { activity, workflow as defineWorkflow } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await sleepForTesting(10);
}

async function findStoredTimerEntry(
  storage: MemoryStorage,
  predicate: (entry: TimerEntry) => boolean,
): Promise<TimerEntry> {
  for await (const [, encodedDeadlineKey] of storage.scan('timer-idx:')) {
    const deadlineKey = decode(encodedDeadlineKey);
    if (typeof deadlineKey !== 'string') {
      continue;
    }

    const encodedEntry = await storage.get(deadlineKey);
    if (encodedEntry === null) {
      continue;
    }

    const entry = decode(encodedEntry) as TimerEntry;
    if (predicate(entry)) {
      return entry;
    }
  }

  throw new Error('Expected to find a matching stored timer entry');
}

function makeDefinitionSchema<TOutput>(): DefinitionSchema<unknown, TOutput> {
  return {
    '~standard': {
      version: 1,
      vendor: 'weft-test',
      validate: (value) => ({ value: value as TOutput }),
    },
  };
}

class AttributeReadCountingStorage extends MemoryStorage {
  attributeReadCount = 0;

  override async get(key: string): Promise<Uint8Array | null> {
    if (key.startsWith('attr:')) {
      this.recordAttributeRead();
    }
    return this.getStoredValue(key);
  }

  protected recordAttributeRead(): void {
    this.attributeReadCount += 1;
  }

  protected async getStoredValue(key: string): Promise<Uint8Array | null> {
    return super.get(key);
  }
}

class ConcurrentAttributeReadCountingStorage extends AttributeReadCountingStorage {
  activeAttributeReadCount = 0;
  maxConcurrentAttributeReadCount = 0;

  override async get(key: string): Promise<Uint8Array | null> {
    if (!key.startsWith('attr:')) {
      return this.getStoredValue(key);
    }

    this.recordAttributeRead();
    this.activeAttributeReadCount += 1;
    this.maxConcurrentAttributeReadCount = Math.max(
      this.maxConcurrentAttributeReadCount,
      this.activeAttributeReadCount,
    );

    try {
      await sleepForTesting(1);
      return await this.getStoredValue(key);
    } finally {
      this.activeAttributeReadCount -= 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Engine', () => {
  it('wraps configured storage with compression support', () => {
    const engine = new Engine({ compression: { algorithm: 'gzip', threshold: 1 } });

    expect(engine.storage.constructor.name).toBe('CompressedStorage');

    engine[Symbol.dispose]();
  });

  it('rejects suspendOnLlmWait until the option has a runtime implementation', () => {
    expect(() => new Engine({ suspendOnLlmWait: true })).toThrow(
      'suspendOnLlmWait is not yet implemented',
    );
  });

  it('creates engine with no args and defaults to MemoryStorage', () => {
    const engine = new Engine();
    expect(engine).toBeInstanceOf(Engine);
    expect(engine).toBeInstanceOf(EventTarget);
    engine[Symbol.dispose]();
  });

  it('exposes the scheduler through the public getter', () => {
    const engine = new Engine();

    expect(engine.scheduler).toBeDefined();

    engine[Symbol.dispose]();
  });

  it('fireTimer tolerates a sleep timer that has no registered resolver', async () => {
    const engine = new Engine();

    await expect(
      engine.fireTimer({
        id: 'sleep:missing-resolver',
        workflowId: 'missing-workflow',
        fireAt: 1_000,
        kind: 'sleep',
      }),
    ).resolves.toBeUndefined();

    engine[Symbol.dispose]();
  });

  it('Engine.create registers activities before workflows and recovers when requested', async () => {
    const storage = new MemoryStorage();
    const firstEngine = new Engine({ storage });
    const formatFactoryGreeting = activity({
      name: 'formatFactoryGreeting',
      execute: async (input: { name: string }) => `Hello, ${input.name}`,
    });
    const factoryWelcome = defineWorkflow({
      name: 'factoryWelcome',
      handler: async function* (ctx: WorkflowContext, input: { name: string }) {
        const greeting = yield* ctx.run(formatFactoryGreeting, input);
        const suffix = yield* ctx.waitForSignal<string>('suffix');
        return `${greeting}${suffix}`;
      },
    });

    firstEngine.register(formatFactoryGreeting);
    firstEngine.register(factoryWelcome);
    await firstEngine.start('factoryWelcome', { name: 'Ada' }, { id: 'factory-recover-id' });
    await flush();
    firstEngine[Symbol.dispose]();

    const recoveredEngine = await Engine.create({
      storage,
      activities: { formatFactoryGreeting },
      workflows: { factoryWelcome },
      recover: true,
    });

    expect(recoveredEngine.getActivityDefinition('formatFactoryGreeting')).toMatchObject({
      name: 'formatFactoryGreeting',
    });
    expect(recoveredEngine.getWorkflowDefinition('factoryWelcome')).toMatchObject({
      type: 'factoryWelcome',
    });

    await recoveredEngine.signal('factory-recover-id', 'suffix', '!');
    await expect(recoveredEngine.getHandle('factory-recover-id').result()).resolves.toBe(
      'Hello, Ada!',
    );
    recoveredEngine[Symbol.dispose]();
  });

  it('Engine.create({ recover: false }) skips recovery preflight', async () => {
    const storage = new MemoryStorage();
    const unknownState: WorkflowState = {
      id: 'factory-unknown-id',
      type: 'factory-unknown',
      status: 'running',
      input: null,
      version: '1',
      createdAt: 1,
      updatedAt: 1,
    };
    await storage.put(KEYS.workflow('factory-unknown-id'), encode(unknownState));

    const engine = await Engine.create({ storage, recover: false });
    expect(await engine.get('factory-unknown-id')).toMatchObject({
      id: 'factory-unknown-id',
      type: 'factory-unknown',
      status: 'running',
    });
    engine[Symbol.dispose]();
  });

  it('Engine.create rejects workflow and activity map keys that do not match definition names', async () => {
    const greetWorkflow = defineWorkflow({
      name: 'actualWorkflowName',
      handler: async function* () {
        return 'ok';
      },
    });
    const greetActivity = activity({
      name: 'actualActivityName',
      execute: async () => 'ok',
    });

    await expect(
      Engine.create({ workflows: { expectedWorkflowName: greetWorkflow }, recover: false }),
    ).rejects.toBeInstanceOf(EngineCreateNameMismatchError);
    await expect(
      Engine.create({ activities: { expectedActivityName: greetActivity }, recover: false }),
    ).rejects.toBeInstanceOf(EngineCreateNameMismatchError);
  });

  it('Engine.create disposes the partially constructed engine on failure', async () => {
    // Constructor side effects (broadcast channel, scheduler, dispatchers,
    // alert manager) start before registration runs. If a key mismatch or
    // recovery error escapes, the engine reference never reaches the caller —
    // so Engine.create has to dispose what it constructed before rethrowing.
    // We observe disposal by patching the prototype method. Instance-level
    // spying isn't possible because the engine reference never escapes
    // Engine.create on the failure path, and Bun's test runner runs cases
    // within a file serially, so the prototype patch only intercepts the
    // engine constructed by THIS test.
    const originalDispose = Engine.prototype[Symbol.asyncDispose];
    let disposeCount = 0;
    Engine.prototype[Symbol.asyncDispose] = async function () {
      disposeCount += 1;
      return originalDispose.call(this);
    };

    try {
      const greetWorkflow = defineWorkflow({
        name: 'disposalWorkflow',
        handler: async function* () {
          return 'ok';
        },
      });
      await expect(
        Engine.create({ workflows: { wrongKey: greetWorkflow }, recover: false }),
      ).rejects.toBeInstanceOf(EngineCreateNameMismatchError);

      expect(disposeCount).toBe(1);
    } finally {
      Engine.prototype[Symbol.asyncDispose] = originalDispose;
    }
  });

  it('register() returns a typed view of the same runtime engine', async () => {
    const formatBuilderGreeting = activity({
      name: 'formatBuilderGreeting',
      execute: async (input: { name: string }) => `Hello, ${input.name}`,
    });
    const builderWelcome = defineWorkflow({
      name: 'builderWelcome',
      handler: async function* (ctx: WorkflowContext, input: { name: string }) {
        return yield* ctx.run(formatBuilderGreeting, input);
      },
    });

    const engine = new Engine<{}, {}>().register(formatBuilderGreeting).register(builderWelcome);
    const handle = await engine.start('builderWelcome', { name: 'Grace' });
    await expect(handle.result()).resolves.toBe('Hello, Grace');
    engine[Symbol.dispose]();
  });

  it('activity definition metadata is preserved through Engine.create and register()', async () => {
    const inputSchema = makeDefinitionSchema<{ name: string }>();
    const outputSchema = makeDefinitionSchema<string>();
    const retry = {
      maxAttempts: 4,
      initialBackoff: '1s',
      backoffMultiplier: 2,
      maxBackoff: '10s',
      nonRetryableErrors: ['ValidationError'],
    };
    const definition = activity({
      name: 'metadataActivity',
      description: 'Metadata activity',
      tags: ['metadata'],
      inputSchema,
      outputSchema,
      queue: 'metadata-queue',
      timeout: '30s',
      retry,
      idempotent: true,
      execute: async (input: { name: string }) => input.name,
    });

    const createdEngine = await Engine.create({
      activities: { metadataActivity: definition },
      recover: false,
    });
    const builderEngine = new Engine<{}, {}>().register(definition);

    expect(createdEngine.getActivityDefinition('metadataActivity')).toEqual(
      builderEngine.getActivityDefinition('metadataActivity'),
    );
    expect(createdEngine.getActivityDefinition('metadataActivity')).toMatchObject({
      name: 'metadataActivity',
      description: 'Metadata activity',
      tags: ['metadata'],
      queue: 'metadata-queue',
      timeout: '30s',
      retry,
      idempotent: true,
    });

    // Both registration paths must preserve the colocated schema metadata —
    // not just the simple scalar fields. A regression that drops schemas
    // would still pass the toMatchObject above but break tools that
    // introspect activity I/O contracts.
    const createdMetadata = createdEngine.getActivityDefinition('metadataActivity');
    const builderMetadata = builderEngine.getActivityDefinition('metadataActivity');
    expect(createdMetadata).toBeDefined();
    expect(builderMetadata).toBeDefined();
    expect(createdMetadata?.inputSchema).toBe(inputSchema);
    expect(createdMetadata?.outputSchema).toBe(outputSchema);
    expect(builderMetadata?.inputSchema).toBe(inputSchema);
    expect(builderMetadata?.outputSchema).toBe(outputSchema);

    createdEngine[Symbol.dispose]();
    builderEngine[Symbol.dispose]();
  });

  it('register(name, fn) shorthand registers a workflow', async () => {
    const engine = new Engine();
    const handler = async function* (_ctx: WorkflowContext, input: unknown) {
      return `hello ${input as string}`;
    };

    engine.register('greet', handler);
    const handle = await engine.start('greet', 'world');
    const result = await handle.result();
    expect(result).toBe('hello world');
    engine[Symbol.dispose]();
  });

  it('register(activityDefinition) registers a named activity for workflow execution', async () => {
    const engine = new Engine();

    async function double(value: unknown) {
      return (value as number) * 2;
    }

    const dispatchedDouble = Object.defineProperty(
      async function (value: unknown) {
        return (value as number) * 3;
      },
      'name',
      { value: 'double' },
    );

    engine.register(activity({ name: 'double', execute: double }));
    engine.register('double-via-registered-activity', async function* (ctx: WorkflowContext) {
      return yield* ctx.run(dispatchedDouble, 21);
    });

    const handle = await engine.start('double-via-registered-activity', undefined);
    const result = await handle.result();

    expect(result).toBe(42);
    engine[Symbol.dispose]();
  });

  it('ctx.run(name, input) dispatches through the registered activity table', async () => {
    const engine = new Engine();

    engine.register(
      activity({
        name: 'formatGreeting',
        execute: async (input: { name: string }) => `Hello, ${input.name}`,
      }),
    );
    engine.register('welcome', async function* (ctx: WorkflowContext, input: { name: string }) {
      return yield* ctx.run('formatGreeting', input);
    });

    const handle = await engine.start('welcome', { name: 'Steve' });
    const result = await handle.result();

    expect(result).toBe('Hello, Steve');
    engine[Symbol.dispose]();
  });

  it('ctx.run(name, input) keeps unknown activity names on the existing error path', async () => {
    const engine = new Engine();

    engine.register('missing-activity', async function* (ctx: WorkflowContext) {
      return yield* ctx.run('missingActivity', { name: 'Steve' });
    });

    const handle = await engine.start('missing-activity', undefined);
    await expect(handle.result()).rejects.toThrow(
      'No activity registered with name "missingActivity"',
    );
    engine[Symbol.dispose]();
  });

  it('simple workflow completes with ctx.run', async () => {
    const engine = new Engine();
    const doubleActivity = async (input: unknown) => (input as number) * 2;

    engine.register('double', async function* (ctx: WorkflowContext, input: unknown) {
      const result = yield* ctx.run(doubleActivity, input);
      return result;
    });

    const handle = await engine.start('double', 5);
    const result = await handle.result();
    expect(result).toBe(10);
    engine[Symbol.dispose]();
  });

  it('two-step workflow completes both ctx.run calls', async () => {
    const engine = new Engine();
    const add = async (input: { left: number; right: number }) => input.left + input.right;
    const multiply = async (input: { left: number; right: number }) => input.left * input.right;

    engine.register('math', async function* (ctx: WorkflowContext, input: unknown) {
      const sum = yield* ctx.run(add, { left: input as number, right: 3 });
      const product = yield* ctx.run(multiply, { left: sum, right: 2 });
      return product;
    });

    const handle = await engine.start('math', 7);
    const result = await handle.result();
    expect(result).toBe(20); // (7 + 3) * 2
    engine[Symbol.dispose]();
  });

  it('handle.result() resolves with workflow output', async () => {
    const engine = new Engine();
    engine.register('value', async function* () {
      return { answer: 42 };
    });

    const handle = await engine.start('value', null);
    const result = await handle.result();
    expect(result).toEqual({ answer: 42 });
    engine[Symbol.dispose]();
  });

  it('WorkflowStartedEvent fires on start', async () => {
    const engine = new Engine();
    engine.register('noop', async function* () {
      return 'done';
    });

    const events: WorkflowStartedEvent[] = [];
    engine.addEventListener(WorkflowStartedEvent.type, (event) => {
      events.push(event as WorkflowStartedEvent);
    });

    const handle = await engine.start('noop', 'test-input');
    await handle.result();

    expect(events).toHaveLength(1);
    expect(events[0]!.workflowId).toBe(handle.id);
    expect(events[0]!.workflowType).toBe('noop');
    expect(events[0]!.input).toBe('test-input');
    engine[Symbol.dispose]();
  });

  it('delivers a signal sent immediately after start before the first inline turn launches', async () => {
    const engine = new Engine();

    engine.register('wait-for-go', async function* (ctx: WorkflowContext) {
      return yield* ctx.waitForSignal('go');
    });

    const handle = await engine.start('wait-for-go', null);
    await handle.signal('go', 'ready');

    await expect(handle.result()).resolves.toBe('ready');
    engine[Symbol.dispose]();
  });

  it('cancels a workflow immediately after start before the first inline turn launches', async () => {
    const engine = new Engine();

    engine.register('wait-forever', async function* (ctx: WorkflowContext) {
      return yield* ctx.waitForSignal('never');
    });

    const handle = await engine.start('wait-forever', null);
    await handle.cancel();

    await expect(handle.result()).rejects.toThrow('Workflow cancelled');
    engine[Symbol.dispose]();
  });

  it('resume() returns the queued handle without starting an inline workflow twice', async () => {
    const engine = new Engine();
    let runCount = 0;

    engine.register('queued-resume', async function* (ctx: WorkflowContext) {
      runCount += 1;
      return yield* ctx.waitForSignal('go');
    });

    const handle = await engine.start('queued-resume', null);
    const resumedHandle = await engine.resume(handle.id);

    expect(resumedHandle.id).toBe(handle.id);

    await resumedHandle.signal('go', 'done');
    await expect(handle.result()).resolves.toBe('done');
    expect(runCount).toBe(1);
    engine[Symbol.dispose]();
  });

  it('recoverAll() keeps queued inline starts from running twice', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    let runCount = 0;

    engine.register('queued-recover', async function* (ctx: WorkflowContext) {
      runCount += 1;
      return yield* ctx.waitForSignal('go');
    });

    const handle = await engine.start('queued-recover', null);
    const recoveredHandles = await engine.recoverAll();

    expect(recoveredHandles.some((recoveredHandle) => recoveredHandle.id === handle.id)).toBe(true);

    await handle.signal('go', 'done');
    await expect(handle.result()).resolves.toBe('done');
    expect(runCount).toBe(1);
    engine[Symbol.dispose]();
  });

  it('get() reports running once an inline workflow has started its first turn', async () => {
    const workflowId = 'queued-running-status';
    const storage = new MemoryStorage();
    const originalScan = storage.scan.bind(storage);
    const signalPrefix = `sig:${encodeStorageKeyComponent(workflowId)}:go:`;
    const bufferedSignalScanStarted = Promise.withResolvers<void>();
    const bufferedSignalScanReleased = Promise.withResolvers<void>();
    let holdNextBufferedSignalScan = true;
    let started = false;

    storage.scan = async function* (
      prefix: string,
      options?: ScanOptions,
    ): AsyncIterable<[string, Uint8Array]> {
      if (holdNextBufferedSignalScan && prefix === signalPrefix) {
        holdNextBufferedSignalScan = false;
        bufferedSignalScanStarted.resolve();
        await bufferedSignalScanReleased.promise;
      }

      yield* originalScan(prefix, options);
    };

    const engine = new Engine({ storage });
    engine.register('queued-running-status', async function* (ctx: WorkflowContext) {
      started = true;
      yield* ctx.waitForSignal('go');
      return 'done';
    });

    const handle = await engine.start('queued-running-status', null, { id: workflowId });

    await bufferedSignalScanStarted.promise;
    expect(started).toBe(true);
    expect(await engine.get(workflowId)).toMatchObject({ status: 'running' });

    bufferedSignalScanReleased.resolve();
    await flush();

    await handle.signal('go', 'done');
    await expect(handle.result()).resolves.toBe('done');
    engine[Symbol.dispose]();
  });

  it('resume() returns the existing handle for a parked inline workflow', async () => {
    const engine = new Engine();
    let runCount = 0;

    engine.register('active-resume', async function* (ctx: WorkflowContext) {
      runCount += 1;
      return yield* ctx.waitForSignal('go');
    });

    const handle = await engine.start('active-resume', null);
    await flush();

    const resumedHandle = await engine.resume(handle.id);
    expect(resumedHandle.id).toBe(handle.id);
    expect(runCount).toBe(1);

    await resumedHandle.signal('go', 'done');
    await expect(handle.result()).resolves.toBe('done');
    expect(runCount).toBe(2);
    engine[Symbol.dispose]();
  });

  it('recoverAll() returns the existing handle for a parked inline workflow', async () => {
    const engine = new Engine();
    let runCount = 0;

    engine.register('active-recover', async function* (ctx: WorkflowContext) {
      runCount += 1;
      return yield* ctx.waitForSignal('go');
    });

    const handle = await engine.start('active-recover', null);
    await flush();

    const recoveredHandles = await engine.recoverAll();
    expect(recoveredHandles.some((recoveredHandle) => recoveredHandle.id === handle.id)).toBe(true);
    expect(runCount).toBe(1);

    await handle.signal('go', 'done');
    await expect(handle.result()).resolves.toBe('done');
    expect(runCount).toBe(2);
    engine[Symbol.dispose]();
  });

  it('resume() and recoverAll() ignore parked inline ownership after cancellation reaches storage', async () => {
    const workflowId = 'cancelled-parked-inline-workflow';
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const cancelledStatePersisted = Promise.withResolvers<void>();
    const releaseCancelledStateWrite = Promise.withResolvers<void>();
    const originalBatch = storage.batch.bind(storage);
    let holdCancelledStateWrite = false;

    storage.batch = async (operations) => {
      await originalBatch(operations);

      if (!holdCancelledStateWrite) {
        return;
      }

      const cancelledWorkflowUpdate = operations.find(
        (operation) =>
          operation.type === 'put' &&
          operation.key === KEYS.workflow(workflowId) &&
          (decode(operation.value) as WorkflowState).status === 'cancelled',
      );
      if (!cancelledWorkflowUpdate) {
        return;
      }

      cancelledStatePersisted.resolve();
      await releaseCancelledStateWrite.promise;
    };

    engine.register('cancelled-parked-inline-workflow', async function* (ctx: WorkflowContext) {
      return yield* ctx.waitForSignal('go');
    });

    const handle = await engine.start('cancelled-parked-inline-workflow', null, { id: workflowId });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (engine[ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING]() === 1) {
        break;
      }

      await flush();
    }

    expect(engine[ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING]()).toBe(1);

    holdCancelledStateWrite = true;
    const cancelPromise = engine.cancel(workflowId);
    await cancelledStatePersisted.promise;

    await expect(engine.resume(workflowId)).rejects.toThrow(
      `Cannot resume workflow "${workflowId}": status is "cancelled", expected "running"`,
    );

    const recoveredHandles = await engine.recoverAll();
    expect(recoveredHandles.some((recoveredHandle) => recoveredHandle.id === workflowId)).toBe(
      false,
    );

    releaseCancelledStateWrite.resolve();
    await cancelPromise;
    await expect(handle.result()).rejects.toThrow('Workflow cancelled');
    expect(engine[ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING]()).toBe(0);
    engine[Symbol.dispose]();
  });

  it('WorkflowCompletedEvent fires with result and duration', async () => {
    const engine = new Engine();
    engine.register('fast', async function* () {
      return 'completed';
    });

    const events: WorkflowCompletedEvent[] = [];
    engine.addEventListener(WorkflowCompletedEvent.type, (event) => {
      events.push(event as WorkflowCompletedEvent);
    });

    const handle = await engine.start('fast', null);
    await handle.result();

    expect(events).toHaveLength(1);
    expect(events[0]!.workflowId).toBe(handle.id);
    expect(events[0]!.result).toBe('completed');
    expect(events[0]!.duration).toBeGreaterThanOrEqual(0);
    engine[Symbol.dispose]();
  });

  it('signal on a completed workflow is a no-op and does not recreate cleanup scratch', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    engine.register('signal-noop', async function* () {
      return 'done';
    });

    const handle = await engine.start('signal-noop', null);
    await expect(handle.result()).resolves.toBe('done');
    await expect(
      engine.signal(handle.id, 'after-complete', { value: true }),
    ).resolves.toBeUndefined();

    const persistedSignalKeys: string[] = [];
    for await (const [key] of storage.scan(`sig:${encodeStorageKeyComponent(handle.id)}:`)) {
      persistedSignalKeys.push(key);
    }

    expect(persistedSignalKeys).toEqual([]);
    expect(await storage.get(KEYS.terminalCleanupNeeded(handle.id))).toBeNull();

    engine[Symbol.dispose]();
  });

  it('resolves handle.result() even when terminal cleanup throws', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const cleanupWarnings: CleanupWarningEvent[] = [];
    const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

    engine.addEventListener(CleanupWarningEvent.type, (event) => {
      cleanupWarnings.push(event as CleanupWarningEvent);
    });

    engine.register('cleanup-throw', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('finish');
      return 'expected-result';
    });

    // Patch deletePrefix to throw on the first call, which occurs when the
    // deferred terminal-cleanup timer runs `#cleanupReviews`. The completion
    // state write runs before that cleanup, so the workflow is durably
    // recorded as terminal before the error fires.
    const originalDeletePrefix = storage.deletePrefix.bind(storage);
    let deletePrefixCallCount = 0;
    storage.deletePrefix = async (prefix: string): Promise<number> => {
      deletePrefixCallCount++;
      if (deletePrefixCallCount === 1) {
        throw new Error('simulated cleanup failure');
      }
      return originalDeletePrefix(prefix);
    };

    const handle = await engine.start('cleanup-throw', null);
    await flush();

    const reviewKey = KEYS.review(handle.id, 'cleanup-warning-review');
    await storage.put(reviewKey, encode({ status: 'pending' }));

    // handle.result() must resolve — the resolver must not be stranded even
    // though the deferred durable cleanup later fails.
    const resultPromise = handle.result();
    await engine.signal(handle.id, 'finish', null);
    const result = await resultPromise;
    expect(result).toBe('expected-result');

    await engine.scheduler.tick(Date.now() + 120_000);

    // Confirm that cleanup did in fact fail — guards against the test
    // passing vacuously if the deletePrefix patch was never exercised.
    expect(cleanupWarnings).toHaveLength(1);
    expect(cleanupWarnings[0]!.source).toBe('cleanupTerminalWorkflowDurableState');
    expect(cleanupWarnings[0]!.error.message).toBe('simulated cleanup failure');
    expect(await storage.get(reviewKey)).not.toBeNull();
    expect(await storage.get(KEYS.terminalCleanupNeeded(handle.id))).not.toBeNull();

    await engine.scheduler.tick(Date.now() + 120_000);

    expect(await storage.get(reviewKey)).toBeNull();
    expect(await storage.get(KEYS.terminalCleanupNeeded(handle.id))).toBeNull();

    consoleErrorSpy.mockRestore();
    engine[Symbol.dispose]();
  });

  it('resolves handle.result() even when completion event dispatch throws', async () => {
    const capturedCompletionErrors: unknown[] = [];
    const onMessageSpy = spyOn(InlineExecutionStrategy.prototype, 'onMessage').mockImplementation(
      function (
        this: InlineExecutionStrategy,
        handler: (message: WorkerOutboundMessage) => void | Promise<void>,
      ) {
        onMessageSpy.mockRestore();

        const wrappedHandler = (message: WorkerOutboundMessage): void => {
          const result = handler(message);
          if (result instanceof Promise) {
            result.catch((error: unknown) => {
              capturedCompletionErrors.push(error);
            });
          }
        };

        InlineExecutionStrategy.prototype.onMessage.call(this, wrappedHandler);
      },
    );

    const engine = new Engine();
    const originalDispatchEvent = engine.dispatchEvent.bind(engine);

    engine.register('dispatch-throws-on-complete', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('finish');
      return 'expected-result';
    });

    engine.dispatchEvent = ((event: Event): boolean => {
      if (event.type === WorkflowCompletedEvent.type) {
        throw new Error('simulated completion dispatch failure');
      }

      return originalDispatchEvent(event);
    }) as typeof engine.dispatchEvent;

    const handle = await engine.start('dispatch-throws-on-complete', null);
    await flush();

    const resultPromise = handle.result();
    await engine.signal(handle.id, 'finish', null);

    await expect(resultPromise).resolves.toBe('expected-result');
    await flush();

    expect(capturedCompletionErrors).toHaveLength(1);
    expect((capturedCompletionErrors[0] as Error).message).toBe(
      'simulated completion dispatch failure',
    );

    engine[Symbol.dispose]();
  });

  it('WorkflowFailedEvent fires when workflow throws', async () => {
    const engine = new Engine();
    engine.register('failing', async function* () {
      throw new Error('deliberate failure');
    });

    const events: WorkflowFailedEvent[] = [];
    engine.addEventListener(WorkflowFailedEvent.type, (event) => {
      events.push(event as WorkflowFailedEvent);
    });

    const handle = await engine.start('failing', null);
    await expect(handle.result()).rejects.toThrow('deliberate failure');

    expect(events).toHaveLength(1);
    expect(events[0]!.error.message).toBe('deliberate failure');
    engine[Symbol.dispose]();
  });

  it('cancel() aborts a running workflow', async () => {
    const engine = new Engine();
    const storage = engine.storage as MemoryStorage;

    engine.register('long-running', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('never-arrives');
      return 'should not reach';
    });

    const handle = await engine.start('long-running', null);
    // Attach a catch handler before cancelling so the rejection is handled
    const resultPromise = handle.result().catch(() => {});
    await flush();

    await engine.cancel(handle.id);
    await resultPromise;

    const stateBytes = await storage.get(KEYS.workflow(handle.id));
    const state = decode(stateBytes!) as WorkflowState;
    expect(state.status).toBe('cancelled');
    engine[Symbol.dispose]();
  });

  it('engine disposal leaves waitForSignal suspended for recovery instead of resuming with undefined', async () => {
    const storage = new MemoryStorage();
    let resumedAfterWait = false;

    const registerWorkflow = (engine: Engine) => {
      engine.register('dispose-wait-signal', async function* (ctx: WorkflowContext) {
        const value = yield* ctx.waitForSignal<string>('go');
        resumedAfterWait = true;
        return `resumed:${value}`;
      });
    };

    const engine1 = new Engine({ storage });
    registerWorkflow(engine1);

    await engine1.start('dispose-wait-signal', null, { id: 'dispose-wait-signal' });
    await flush();

    engine1[Symbol.dispose]();
    await flush();

    expect(resumedAfterWait).toBe(false);

    const stateBytes = await storage.get(KEYS.workflow('dispose-wait-signal'));
    const state = decode(stateBytes!) as WorkflowState;
    expect(state.status).toBe('running');

    const engine2 = new Engine({ storage });
    registerWorkflow(engine2);

    const recoveredHandles = await engine2.recoverAll();
    expect(recoveredHandles).toHaveLength(1);

    await engine2.signal('dispose-wait-signal', 'go', 'value');
    await expect(recoveredHandles[0]!.result()).resolves.toBe('resumed:value');

    engine2[Symbol.dispose]();
  });

  it('cleans up a signal waiter when a buffered signal scan fails after registration', async () => {
    const workflowId = 'signal-waiter-cleanup';
    const storage = new MemoryStorage();
    const originalScan = storage.scan.bind(storage);
    const targetPrefix = `sig:${encodeStorageKeyComponent(workflowId)}:approval:`;
    let approvalScanCount = 0;

    storage.scan = function scan(
      prefix: string,
      options?: ScanOptions,
    ): AsyncIterable<[string, Uint8Array]> {
      if (prefix === targetPrefix) {
        approvalScanCount += 1;
        if (approvalScanCount === 2) {
          return (async function* (): AsyncIterable<[string, Uint8Array]> {
            throw new Error('simulated signal scan failure');
          })();
        }
      }

      return originalScan(prefix, options);
    };

    const engine = new Engine({ storage });
    engine.register('signal-waiter-cleanup', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('approval');
      return 'unreached';
    });

    const handle = await engine.start('signal-waiter-cleanup', null, { id: workflowId });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (approvalScanCount === 2) {
        break;
      }

      await flush();
    }

    expect(approvalScanCount).toBe(2);
    expect(engine[ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING]()).toBe(0);
    const resultPromise = handle.result().catch(() => undefined);
    await engine.cancel(handle.id);
    await resultPromise;

    engine[Symbol.dispose]();
  });

  it('WorkflowCancelledEvent fires on cancel', async () => {
    const engine = new Engine();

    engine.register('cancellable', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('never');
      return 'nope';
    });

    const events: WorkflowCancelledEvent[] = [];
    engine.addEventListener(WorkflowCancelledEvent.type, (event) => {
      events.push(event as WorkflowCancelledEvent);
    });

    const handle = await engine.start('cancellable', null);
    const resultPromise = handle.result().catch(() => {});
    await flush();
    await engine.cancel(handle.id);
    await resultPromise;

    expect(events).toHaveLength(1);
    expect(events[0]!.workflowId).toBe(handle.id);
    engine[Symbol.dispose]();
  });

  it('signal() writes to storage and delivers to waiting workflow', async () => {
    const engine = new Engine();

    engine.register('signal-workflow', async function* (ctx: WorkflowContext) {
      const payload = yield* ctx.waitForSignal('my-signal');
      return `received: ${payload as string}`;
    });

    const handle = await engine.start('signal-workflow', null);
    await flush();

    await engine.signal(handle.id, 'my-signal', 'hello-signal');
    const result = await handle.result();

    expect(result).toBe('received: hello-signal');
    engine[Symbol.dispose]();
  });

  it('does not park a workflow after cancel wins during the pre-park signal scan', async () => {
    const workflowId = 'parked-pre-park-cancel-race-id';
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const bufferedSignalScanStarted = Promise.withResolvers<void>();
    const bufferedSignalScanReleased = Promise.withResolvers<void>();
    const originalScan = storage.scan.bind(storage);
    const signalPrefix = `sig:${workflowId}:go:`;
    let holdNextBufferedSignalScan = true;

    storage.scan = async function* (
      prefix: string,
      options?: ScanOptions,
    ): AsyncIterable<[string, Uint8Array]> {
      if (holdNextBufferedSignalScan && prefix === signalPrefix) {
        holdNextBufferedSignalScan = false;
        bufferedSignalScanStarted.resolve();
        await bufferedSignalScanReleased.promise;
      }

      yield* originalScan(prefix, options);
    };

    engine.register('parked-pre-park-cancel-race', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('go');
      return 'should-not-park';
    });

    const handle = await engine.start('parked-pre-park-cancel-race', null, { id: workflowId });
    const resultPromise = handle.result().then(
      () => ({ status: 'resolved' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );

    await bufferedSignalScanStarted.promise;
    expect(engine[ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING]()).toBe(0);

    await engine.cancel(workflowId);
    bufferedSignalScanReleased.resolve();
    await flush();

    const result = await resultPromise;
    const workflowState = await engine.get(workflowId);
    expect(result.status).toBe('rejected');
    expect(
      result.status === 'rejected' && result.error instanceof Error
        ? result.error.message
        : String(result.status === 'rejected' ? result.error : ''),
    ).toBe('Workflow cancelled');
    expect(engine[ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING]()).toBe(0);
    expect(workflowState?.status).toBe('cancelled');
    engine[Symbol.dispose]();
  });

  it('does not resume a parked workflow after cancel writes a terminal state', async () => {
    const workflowId = 'parked-resume-cancel-race-id';
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    let resumedAfterSignal = false;
    const checkpointReadStarted = Promise.withResolvers<void>();
    const checkpointReadReleased = Promise.withResolvers<void>();
    const originalGet = storage.get.bind(storage);
    let holdNextCheckpointRead = true;

    storage.get = async (key: string): Promise<Uint8Array | null> => {
      if (holdNextCheckpointRead && key === KEYS.checkpoint(workflowId)) {
        holdNextCheckpointRead = false;
        checkpointReadStarted.resolve();
        await checkpointReadReleased.promise;
      }

      return await originalGet(key);
    };

    engine.register('parked-resume-cancel-race', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('go');
      resumedAfterSignal = true;
      return 'should-not-complete';
    });

    const handle = await engine.start('parked-resume-cancel-race', null, { id: workflowId });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (engine[ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING]() === 1) {
        break;
      }

      await flush();
    }

    expect(engine[ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING]()).toBe(1);

    const resultPromise = handle.result().then(
      () => ({ status: 'resolved' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await engine.signal(workflowId, 'go', 'resume-now');
    await checkpointReadStarted.promise;

    await engine.cancel(workflowId);
    checkpointReadReleased.resolve();
    await flush();

    const result = await resultPromise;
    const workflowState = await engine.get(workflowId);
    expect(result.status).toBe('rejected');
    expect(
      result.status === 'rejected' && result.error instanceof Error
        ? result.error.message
        : String(result.status === 'rejected' ? result.error : ''),
    ).toBe('Workflow cancelled');
    expect(resumedAfterSignal).toBe(false);
    expect(engine[ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING]()).toBe(0);
    expect(workflowState?.status).toBe('cancelled');
    engine[Symbol.dispose]();
  });

  it('does not let a queued parked resume continue after cancel starts', async () => {
    const workflowId = 'parked-resume-termination-race-id';
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    let resumedAfterCancellationStarted = false;
    const serializedResumeStateReadStarted = Promise.withResolvers<void>();
    const serializedResumeStateReadReleased = Promise.withResolvers<void>();
    const originalGet = storage.get.bind(storage);
    let holdSerializedResumeStateRead = false;
    let workflowStateReadsAfterSignal = 0;

    storage.get = async (key: string): Promise<Uint8Array | null> => {
      if (holdSerializedResumeStateRead && key === KEYS.workflow(workflowId)) {
        workflowStateReadsAfterSignal += 1;
        if (workflowStateReadsAfterSignal === 2) {
          serializedResumeStateReadStarted.resolve();
          await serializedResumeStateReadReleased.promise;
        }
      }

      return await originalGet(key);
    };

    engine.register('parked-resume-termination-race', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('go');
      resumedAfterCancellationStarted = true;
      yield* ctx.waitForSignal('never');
      return 'should-not-complete';
    });

    const handle = await engine.start('parked-resume-termination-race', null, { id: workflowId });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (engine[ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING]() === 1) {
        break;
      }

      await flush();
    }

    expect(engine[ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING]()).toBe(1);

    holdSerializedResumeStateRead = true;
    await engine.signal(workflowId, 'go', 'resume-now');
    await serializedResumeStateReadStarted.promise;

    const cancelPromise = engine.cancel(workflowId);
    serializedResumeStateReadReleased.resolve();
    await cancelPromise;
    await flush();

    const result = await handle.result().then(
      () => ({ status: 'resolved' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    const workflowState = await engine.get(workflowId);
    expect(result.status).toBe('rejected');
    expect(
      result.status === 'rejected' && result.error instanceof Error
        ? result.error.message
        : String(result.status === 'rejected' ? result.error : ''),
    ).toBe('Workflow cancelled');
    expect(resumedAfterCancellationStarted).toBe(false);
    expect(engine[ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING]()).toBe(0);
    expect(workflowState?.status).toBe('cancelled');
    engine[Symbol.dispose]();
  });

  it('list() returns workflows', async () => {
    const engine = new Engine();
    engine.register('listable', async function* () {
      return 'ok';
    });

    const h1 = await engine.start('listable', null, { id: 'wf-a' });
    const h2 = await engine.start('listable', null, { id: 'wf-b' });
    await h1.result();
    await h2.result();

    const result = await engine.list();
    expect(result.total).toBe(2);
    expect(result.items.map((item) => item.id).toSorted()).toEqual(['wf-a', 'wf-b']);
    engine[Symbol.dispose]();
  });

  it('list() orders summaries by createdAt descending with id tiebreaker', async () => {
    let now = 1_700_000_000_000;
    const engine = new Engine({ getNow: () => now });
    engine.register('orderable', async function* () {
      return 'ok';
    });

    now = 1_000;
    const first = await engine.start('orderable', null, { id: 'wf-zzz' });
    now = 2_000;
    const second = await engine.start('orderable', null, { id: 'wf-aaa' });
    now = 2_000;
    const third = await engine.start('orderable', null, { id: 'wf-bbb' });
    await Promise.all([first.result(), second.result(), third.result()]);

    const result = await engine.list();
    expect(result.items.map((item) => item.id)).toEqual(['wf-aaa', 'wf-bbb', 'wf-zzz']);
    engine[Symbol.dispose]();
  });

  it('list() filters by status', async () => {
    const engine = new Engine();
    engine.register('filterable', async function* () {
      return 'ok';
    });
    engine.register('waiter', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('block');
      return 'ok';
    });

    await engine.start('filterable', null, { id: 'done-1' });
    await engine.start('waiter', null, { id: 'running-1' });

    // Wait for the first to complete
    await flush();

    const completedOnly = await engine.list({ status: 'completed' });
    expect(completedOnly.items.every((item) => item.status === 'completed')).toBe(true);
    engine[Symbol.dispose]();
  });

  it('list() rejects malformed filters through the shared validation path', async () => {
    const engine = new Engine();

    await expect(engine.list({ idPrefix: 'a:b' })).rejects.toBeInstanceOf(
      ListFilterValidationError,
    );
    engine[Symbol.dispose]();
  });

  it('list() backfills legacy failed workflow failureCategory only when requested', async () => {
    const storage = new AttributeReadCountingStorage();
    const engine = new Engine({ storage });
    engine.register('attribute-backed-category', async function* () {
      throw new Error('legacy failure');
    });

    const handle = await engine.start('attribute-backed-category', null, {
      id: 'wf-attribute-category',
    });
    await expect(handle.result()).rejects.toThrow('legacy failure');

    const stateBytes = await storage.get(KEYS.workflow(handle.id));
    expect(stateBytes).not.toBeNull();
    const legacyState = decode(stateBytes!) as WorkflowState;
    legacyState.failureCategory = null;
    await storage.put(KEYS.workflow(handle.id), encode(legacyState));
    await storage.put(KEYS.attribute(handle.id), encode({ failureCategory: 'planning' }));

    storage.attributeReadCount = 0;

    const defaultResult = await engine.list({ status: 'failed' });
    expect(defaultResult.items).toContainEqual(
      expect.objectContaining({ id: 'wf-attribute-category' }),
    );
    expect(defaultResult.items[0]?.failureCategory).toBeUndefined();
    expect(storage.attributeReadCount).toBe(0);

    const includedResult = await engine.list(
      { status: 'failed' },
      { includeFailureCategory: true },
    );
    expect(includedResult.items[0]?.failureCategory).toBe('application');
    expect(storage.attributeReadCount).toBe(1);

    engine[Symbol.dispose]();
  });

  it('list() keeps workflow state failureCategory authoritative over stale attributes', async () => {
    const storage = new AttributeReadCountingStorage();
    const engine = new Engine({ storage });
    engine.register('state-backed-category', async function* () {
      throw new Error('state failure');
    });

    const handle = await engine.start('state-backed-category', null, {
      id: 'wf-state-category',
    });
    await expect(handle.result()).rejects.toThrow('state failure');
    await storage.put(KEYS.attribute(handle.id), encode({ failureCategory: 'planning' }));

    storage.attributeReadCount = 0;

    const includedResult = await engine.list(
      { status: 'failed' },
      { includeFailureCategory: true },
    );

    expect(includedResult.items).toContainEqual(
      expect.objectContaining({
        id: 'wf-state-category',
        failureCategory: 'application',
      }),
    );
    expect(storage.attributeReadCount).toBe(0);

    engine[Symbol.dispose]();
  });

  it('list() reads requested legacy failureCategory attributes concurrently within constrained chunks', async () => {
    const storage = new ConcurrentAttributeReadCountingStorage();
    const engine = new Engine({ storage });
    engine.register('attribute-backed-category-concurrent', async function* () {
      throw new Error('legacy failure');
    });

    const handles = await Promise.all(
      [0, 1, 2].map((index) =>
        engine.start('attribute-backed-category-concurrent', null, {
          id: `wf-attribute-category-${index}`,
        }),
      ),
    );

    for (const handle of handles) {
      await expect(handle.result()).rejects.toThrow('legacy failure');
      const stateBytes = await storage.get(KEYS.workflow(handle.id));
      expect(stateBytes).not.toBeNull();
      const legacyState = decode(stateBytes!) as WorkflowState;
      legacyState.failureCategory = null;
      await storage.put(KEYS.workflow(handle.id), encode(legacyState));
      await storage.put(KEYS.attribute(handle.id), encode({ failureCategory: 'planning' }));
    }

    storage.attributeReadCount = 0;
    storage.maxConcurrentAttributeReadCount = 0;

    const result = await engine.list(
      { idPrefix: 'wf-attribute-category-' },
      { includeFailureCategory: true },
    );

    expect(result.items).toHaveLength(3);
    expect(result.items.every((item) => item.failureCategory === 'application')).toBe(true);
    expect(storage.attributeReadCount).toBe(3);
    expect(storage.maxConcurrentAttributeReadCount).toBeGreaterThan(1);

    engine[Symbol.dispose]();
  });

  it('getHandle() returns handle for existing workflow', async () => {
    const engine = new Engine();
    engine.register('gettable', async function* () {
      return 42;
    });

    const handle = await engine.start('gettable', null, { id: 'fixed-id' });
    await handle.result();

    const retrieved = engine.getHandle('fixed-id');
    expect(retrieved).toBeInstanceOf(WorkflowHandle);
    expect(retrieved.id).toBe('fixed-id');
    engine[Symbol.dispose]();
  });

  it('Engine disposal via Symbol.dispose cleans up', () => {
    const engine = new Engine();
    engine.register('disposable', async function* () {
      return 'ok';
    });

    // Should not throw
    engine[Symbol.dispose]();
  });

  it('ctx.sleep pauses workflow via scheduler', async () => {
    let now = 1000;
    const storage = new MemoryStorage();
    const engine = new Engine({ storage: storage as WeftStorage, getNow: () => now });

    engine.register('sleepy', async function* (ctx: WorkflowContext) {
      yield* ctx.sleep(5000);
      return 'awake';
    });

    const handle = await engine.start('sleepy', null);
    await flush();

    // Workflow should still be running (sleep not yet expired)
    const stateBytes = await storage.get(KEYS.workflow(handle.id));
    const state = decode(stateBytes!) as WorkflowState;
    expect(state.status).toBe('running');

    // Advance time and tick the scheduler
    now = 7000;
    await engine.scheduler.tick(now);
    await flush();

    const result = await handle.result();
    expect(result).toBe('awake');
    engine[Symbol.dispose]();
  });

  it('fireTimer starts a pending delayed workflow when an external scheduler fires its timer', async () => {
    let now = 1000;
    const storage = new MemoryStorage();
    const engine = new Engine({ storage: storage as WeftStorage, getNow: () => now });
    const executions: string[] = [];

    engine.register(
      'external-delayed-start',
      async function* (_ctx: WorkflowContext, input: { value: string }) {
        executions.push(input.value);
        return `ran:${input.value}`;
      },
    );

    const handle = await engine.start(
      'external-delayed-start',
      { value: 'scheduled' },
      {
        id: 'wf-external-delayed-start',
        startAt: 6000,
        executionTimeout: 10_000,
      },
    );
    await flush();

    expect(await engine.get(handle.id)).toMatchObject({ status: 'pending' });

    const timerEntry = await findStoredTimerEntry(
      storage,
      (entry) => entry.kind === 'delayed-start' && entry.workflowId === handle.id,
    );
    now = timerEntry.fireAt;

    await engine.fireTimer(timerEntry);
    await flush();

    await expect(handle.result()).resolves.toBe('ran:scheduled');
    expect(executions).toEqual(['scheduled']);
    engine[Symbol.dispose]();
  });

  it('ctx.all runs parallel operations', async () => {
    const engine = new Engine();
    const double = async (...args: unknown[]) => (args[0] as number) * 2;
    const triple = async (...args: unknown[]) => (args[0] as number) * 3;

    engine.register('parallel-workflow', async function* (ctx: WorkflowContext) {
      const results = yield* ctx.all([ctx.run(double, 5), ctx.run(triple, 5)]);
      return results;
    });

    const handle = await engine.start('parallel-workflow', null);
    const result = await handle.result();
    expect(result).toEqual([10, 15]);
    engine[Symbol.dispose]();
  });

  it('ctx.race takes first result', async () => {
    const engine = new Engine();
    const fast = async () => 'fast';
    const slow = async () => {
      await sleepForTesting(100);
      return 'slow';
    };

    engine.register('race-workflow', async function* (ctx: WorkflowContext) {
      const result = yield* ctx.race([ctx.run(fast), ctx.run(slow)]);
      return result;
    });

    const handle = await engine.start('race-workflow', null);
    const result = await handle.result();
    expect(result).toBe('fast');
    engine[Symbol.dispose]();
  });

  it('ctx.memo caches the value', async () => {
    const engine = new Engine();
    let callCount = 0;

    engine.register('memo-workflow', async function* (ctx: WorkflowContext) {
      const first = yield* ctx.memo('expensive', () => {
        callCount++;
        return 'computed';
      });
      const second = yield* ctx.memo('expensive', () => {
        callCount++;
        return 'computed-again';
      });
      return { first, second };
    });

    const handle = await engine.start('memo-workflow', null);
    const result = (await handle.result()) as { first: string; second: string };

    // memo('expensive') was called twice, but fn should only execute once
    // The second call returns the cached value from the memo cache in Context
    expect(result.first).toBe('computed');
    expect(result.second).toBe('computed');
    // The fn should have been called once for the first memo and the
    // second memo returns from the memo cache before yielding to the engine
    expect(callCount).toBe(1);
    engine[Symbol.dispose]();
  });

  it('fails malformed operation requests with an explicit unsupported-type error', async () => {
    const engine = new Engine();

    engine.register('malformed-operation-workflow', async function* () {
      yield {
        type: 'unsupported-operation-type',
        operationId: 'unsupported-operation-id',
      } as never;
      return 'unreachable';
    });

    const handle = await engine.start('malformed-operation-workflow', null);
    await expect(handle.result()).rejects.toThrow(
      'Unsupported operation type: unsupported-operation-type',
    );
    engine[Symbol.dispose]();
  });

  it('custom workflow ID via options.id', async () => {
    const engine = new Engine();
    engine.register('identified', async function* () {
      return 'ok';
    });

    const handle = await engine.start('identified', null, { id: 'my-custom-id' });
    expect(handle.id).toBe('my-custom-id');
    await handle.result();
    engine[Symbol.dispose]();
  });

  it('activity failure propagates to workflow', async () => {
    const engine = new Engine();
    const failingActivity = async () => {
      throw new Error('activity broke');
    };

    engine.register('activity-fail', async function* (ctx: WorkflowContext) {
      const result = yield* ctx.run(failingActivity);
      return result;
    });

    const handle = await engine.start('activity-fail', null);
    await expect(handle.result()).rejects.toThrow('activity broke');
    engine[Symbol.dispose]();
  });

  it('throws when starting unregistered workflow type', async () => {
    const engine = new Engine();
    await expect(engine.start('nonexistent', null)).rejects.toThrow('No workflow registered');
    engine[Symbol.dispose]();
  });

  it('throws when starting duplicate workflow ID', async () => {
    const engine = new Engine();
    engine.register('dup', async function* () {
      return 'ok';
    });

    await engine.start('dup', null, { id: 'same-id' });
    await expect(engine.start('dup', null, { id: 'same-id' })).rejects.toMatchObject({
      message: 'Workflow with id "same-id" already exists',
      name: 'WorkflowAlreadyExistsError',
    });
    engine[Symbol.dispose]();
  });

  it('throws when options.id is an empty string', async () => {
    const engine = new Engine();
    engine.register('empty-id', async function* () {
      return 'ok';
    });

    await expect(engine.start('empty-id', null, { id: '' })).rejects.toThrow(
      'options.id must not be an empty string',
    );
    engine[Symbol.dispose]();
  });

  it('throws when options.id exceeds the maximum length', async () => {
    const engine = new Engine();
    engine.register('long-id', async function* () {
      return 'ok';
    });

    await expect(engine.start('long-id', null, { id: 'a'.repeat(129) })).rejects.toThrow(
      'options.id must be at most 128 characters',
    );
    engine[Symbol.dispose]();
  });

  it('allows options.id to contain storage key separators', async () => {
    const engine = new Engine();
    engine.register('separator-id', async function* () {
      return 'ok';
    });

    const handle = await engine.start('separator-id', null, { id: 'wf:ckpt/with spaces' });
    await expect(handle.result()).resolves.toBe('ok');
    expect(await engine.get(handle.id)).toMatchObject({ id: 'wf:ckpt/with spaces' });
    engine[Symbol.dispose]();
  });

  it('does not hit storage for dedup when starting without a caller-provided id', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    engine.register('noop', async function* () {
      return 'ok';
    });

    const getSpy = spyOn(storage, 'get');

    const handle = await engine.start('noop', null); // no options.id — auto UUID
    await handle.result();

    // The dedup `storage.get` only fires for caller-provided IDs. Auto-UUIDs
    // skip it entirely. Filter to workflow-key reads to avoid false positives
    // from checkpoint or index reads that happen during execution.
    const workflowKeyReads = getSpy.mock.calls.filter(
      ([key]) => typeof key === 'string' && key.startsWith('workflow:'),
    );
    expect(workflowKeyReads.length).toBe(0);

    engine[Symbol.dispose]();
  });

  it('register(name, registration) accepts a WorkflowRegistration object', async () => {
    const engine = new Engine();
    const handler = async function* (_ctx: WorkflowContext, input: unknown) {
      return `versioned: ${input as string}`;
    };

    engine.register('versioned', { handler, version: '2.0' });
    const handle = await engine.start('versioned', 'test');
    const result = await handle.result();
    expect(result).toBe('versioned: test');
    engine[Symbol.dispose]();
  });

  it('register(name, registration) preserves workflow definition metadata for introspection', () => {
    const engine = new Engine();
    const tags = ['orders', 'examples'];
    const inputSchema = makeDefinitionSchema<{ orderId: string }>();
    const outputSchema = makeDefinitionSchema<{ completed: boolean }>();
    const handler = async function* () {
      return { completed: true };
    };

    engine.register('checkout', {
      version: '2.0',
      description: 'Runs checkout for an order.',
      tags,
      inputSchema,
      outputSchema,
      handler,
    });

    tags.push('caller-mutation');
    const definition = engine.getWorkflowDefinition('checkout');
    expect(definition).toMatchObject({
      type: 'checkout',
      version: '2.0',
      description: 'Runs checkout for an order.',
      tags: ['orders', 'examples'],
    });
    expect(definition?.inputSchema).toBe(inputSchema);
    expect(definition?.outputSchema).toBe(outputSchema);

    expect(definition).toBeDefined();
    (definition!.tags as string[]).push('returned-mutation');
    expect(engine.getWorkflowDefinition('checkout')?.tags).toEqual(['orders', 'examples']);
    expect(engine.listWorkflowDefinitions().map((entry) => entry.type)).toEqual(['checkout']);

    engine[Symbol.dispose]();
  });

  it('register(name, registration) rejects malformed schema metadata', () => {
    const engine = new Engine();
    const handler = async function* () {
      return { completed: true };
    };

    expect(() =>
      engine.register('bad-input-schema', {
        handler,
        inputSchema: {
          '~standard': {
            version: 1,
            validate: (value: unknown) => ({ value }),
          },
        } as unknown as DefinitionSchema,
      }),
    ).toThrow('registration("bad-input-schema").inputSchema');

    expect(() =>
      engine.register('bad-output-schema', {
        handler,
        outputSchema: {
          '~standard': {
            version: 1,
            vendor: '',
            validate: (value: unknown) => ({ value }),
          },
        } as unknown as DefinitionSchema,
      }),
    ).toThrow('registration("bad-output-schema").outputSchema');

    engine[Symbol.dispose]();
  });

  it('register(name, registration) defaults version to 1', async () => {
    const engine = new Engine();
    const handler = async function* () {
      return 'ok';
    };

    engine.register('default-version', { handler });
    const handle = await engine.start('default-version', null);
    const result = await handle.result();
    expect(result).toBe('ok');
    engine[Symbol.dispose]();
  });

  it('getHandle() for a completed workflow resolves result from storage', async () => {
    const engine = new Engine();
    engine.register('completed-wf', async function* () {
      return 'stored-result';
    });

    const handle = await engine.start('completed-wf', null, { id: 'completed-id' });
    await handle.result();

    // Clear the handle cache to force a storage lookup
    // by creating a new handle reference
    const newHandle = engine.getHandle('completed-id');
    const result = await newHandle.result();
    expect(result).toBe('stored-result');
    engine[Symbol.dispose]();
  });

  it('handle.result() can be first called after the workflow already completed', async () => {
    const engine = new Engine();
    engine.register('completed-before-result', async function* () {
      return 'late-result';
    });

    const handle = await engine.start('completed-before-result', null, { id: 'late-result-id' });
    let completedBeforeSubscription = false;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const state = await engine.get(handle.id);
      if (state?.status === 'completed') {
        completedBeforeSubscription = true;
        break;
      }

      await flush();
    }

    expect(completedBeforeSubscription).toBe(true);
    await expect(handle.result()).resolves.toBe('late-result');
    engine[Symbol.dispose]();
  });

  it('getHandle() for a non-existent workflow throws', async () => {
    const engine = new Engine();

    const handle = engine.getHandle('nonexistent-id');
    await expect(handle.result()).rejects.toThrow('not found');
    engine[Symbol.dispose]();
  });

  it('getHandle() for a running workflow chains result promise (resolve path)', async () => {
    const engine = new Engine();
    engine.register('chained', async function* (ctx: WorkflowContext) {
      const payload = yield* ctx.waitForSignal('go');
      return `chained: ${payload as string}`;
    });

    const handle = await engine.start('chained', null, { id: 'chain-id' });
    await flush();

    // Get a second handle — even without clearing the cache, getHandle should
    // return a handle that resolves to the same result via the shared resolver
    const secondHandle = engine.getHandle('chain-id');

    // Now signal the workflow
    await engine.signal('chain-id', 'go', 'value');

    const result1 = await handle.result();
    const result2 = await secondHandle.result();

    expect(result1).toBe('chained: value');
    expect(result2).toBe('chained: value');
    engine[Symbol.dispose]();
  });

  it('getHandle() for a running workflow chains result promise (reject path)', async () => {
    const engine = new Engine();
    engine.register('chained-fail', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('go');
      return 'nope';
    });

    const handle = await engine.start('chained-fail', null, { id: 'chain-fail-id' });
    await flush();

    // Get a second handle via getHandle while workflow is running.
    // The handle cache may still have the original, so let's force it:
    const secondHandle = engine.getHandle('chain-fail-id');

    // Cancel to trigger the reject path
    const resultPromise1 = handle.result().catch((error: Error) => error.message);
    const resultPromise2 = secondHandle.result().catch((error: Error) => error.message);

    await engine.cancel('chain-fail-id');

    const error1 = await resultPromise1;
    const error2 = await resultPromise2;

    expect(error1).toBe('Workflow cancelled');
    // The second handle may have the same or chained rejection
    expect(error2).toBeDefined();
    engine[Symbol.dispose]();
  });

  it('asyncDispose calls Symbol.dispose', async () => {
    const engine = new Engine();
    engine.register('disposable', async function* () {
      return 'ok';
    });

    await engine[Symbol.asyncDispose]();
    // Should not throw
  });

  it('WorkflowHandle cancel delegates to engine.cancel', async () => {
    const engine = new Engine();
    engine.register('handle-cancel', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('never');
      return 'nope';
    });

    const handle = await engine.start('handle-cancel', null);
    const resultPromise = handle.result().catch(() => {});
    await flush();

    await handle.cancel();
    await resultPromise;

    const stateBytes = await engine.storage.get(KEYS.workflow(handle.id));
    const state = decode(stateBytes!) as WorkflowState;
    expect(state.status).toBe('cancelled');
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle signal delegates to engine.signal', async () => {
    const engine = new Engine();
    engine.register('handle-signal', async function* (ctx: WorkflowContext) {
      const value = yield* ctx.waitForSignal('my-signal');
      return `got: ${value as string}`;
    });

    const handle = await engine.start('handle-signal', null);
    await flush();

    await handle.signal('my-signal', 'payload');
    const result = await handle.result();
    expect(result).toBe('got: payload');
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle asyncDispose is a no-op', async () => {
    const engine = new Engine();
    engine.register('asyncdispose', async function* () {
      return 'ok';
    });

    const handle = await engine.start('asyncdispose', null);
    await handle.result();

    // Should not throw
    await handle[Symbol.asyncDispose]();
    engine[Symbol.dispose]();
  });

  it('activity failure caught by workflow try/catch completes normally', async () => {
    const engine = new Engine();
    const failingActivity = async () => {
      throw new Error('activity broke');
    };

    engine.register('catch-failure', async function* (ctx: WorkflowContext) {
      try {
        yield* ctx.run(failingActivity);
      } catch {
        return 'caught';
      }
      return 'not caught';
    });

    const handle = await engine.start('catch-failure', null);
    const result = await handle.result();
    expect(result).toBe('caught');
    engine[Symbol.dispose]();
  });

  it('execution deadline times out workflow via scheduler', async () => {
    let now = 1000;
    const storage = new MemoryStorage();
    const engine = new Engine({ storage: storage as WeftStorage, getNow: () => now });

    engine.register('deadline-test', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('never');
      return 'should not complete';
    });

    const handle = await engine.start('deadline-test', null, {
      executionTimeout: 5000,
    });
    const resultPromise = handle.result().catch((error) => error);
    await flush();

    // Advance time past the deadline
    now = 7000;
    await engine.scheduler.tick(now);
    await flush();
    const error = await resultPromise;

    const stateBytes = await storage.get(KEYS.workflow(handle.id));
    const state = decode(stateBytes!) as WorkflowState;
    expect(state.status).toBe('timed-out');
    expect(error).toBeInstanceOf(WorkflowTimeoutError);
    expect((error as WorkflowTimeoutError).timeoutType).toBe('execution');
    expect((error as WorkflowTimeoutError).workflowId).toBe(handle.id);
    expect((error as WorkflowTimeoutError).elapsed).toBe(6000);
    engine[Symbol.dispose]();
  });

  it('execution deadline dispatches WorkflowTimedOutEvent', async () => {
    let now = 1000;
    const storage = new MemoryStorage();
    const engine = new Engine({ storage: storage as WeftStorage, getNow: () => now });

    engine.register('timeout-event-test', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('never');
      return 'unreachable';
    });

    const handle = await engine.start('timeout-event-test', null, {
      executionTimeout: 5000,
    });
    const resultPromise = handle.result().catch(() => {});
    await flush();

    const events: WorkflowTimedOutEvent[] = [];
    engine.addEventListener('workflow:timed-out', (event) => {
      events.push(event as WorkflowTimedOutEvent);
    });

    now = 7000;
    await engine.scheduler.tick(now);
    await flush();
    await resultPromise;

    expect(events).toHaveLength(1);
    expect(events[0]!.workflowId).toBe(handle.id);
    expect(events[0]!.timeoutType).toBe('execution');
    expect(events[0]!.elapsed).toBe(6000);
    engine[Symbol.dispose]();
  });

  it('deadline key is cleaned up on normal completion', async () => {
    let now = 1000;
    const storage = new MemoryStorage();
    const engine = new Engine({ storage: storage as WeftStorage, getNow: () => now });

    engine.register('deadline-cleanup-complete', async function* () {
      return 'done';
    });

    const handle = await engine.start('deadline-cleanup-complete', null, {
      executionTimeout: 60_000,
    });
    await handle.result();
    await flush();

    // Scan for deadline keys — should be empty
    const deadlineKeys: string[] = [];
    for await (const [key] of storage.scan('wf-deadline:')) {
      deadlineKeys.push(key);
    }
    expect(deadlineKeys).toHaveLength(0);

    // Also check scheduler timer index keys
    const timerKeys: string[] = [];
    for await (const [key] of storage.scan('timer-idx:deadline:')) {
      timerKeys.push(key);
    }
    expect(timerKeys).toHaveLength(0);
    engine[Symbol.dispose]();
  });

  it('deadline key is cleaned up on failure', async () => {
    let now = 1000;
    const storage = new MemoryStorage();
    const engine = new Engine({ storage: storage as WeftStorage, getNow: () => now });

    engine.register('deadline-cleanup-fail', async function* () {
      throw new Error('boom');
    });

    const handle = await engine.start('deadline-cleanup-fail', null, {
      executionTimeout: 60_000,
    });
    await handle.result().catch(() => {});
    await flush();

    const deadlineKeys: string[] = [];
    for await (const [key] of storage.scan('wf-deadline:')) {
      deadlineKeys.push(key);
    }
    expect(deadlineKeys).toHaveLength(0);

    const timerKeys: string[] = [];
    for await (const [key] of storage.scan('timer-idx:deadline:')) {
      timerKeys.push(key);
    }
    expect(timerKeys).toHaveLength(0);
    engine[Symbol.dispose]();
  });

  it('deadline key is cleaned up after timeout', async () => {
    let now = 1000;
    const storage = new MemoryStorage();
    const engine = new Engine({ storage: storage as WeftStorage, getNow: () => now });

    engine.register('deadline-cleanup-timeout', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('never');
      return 'unreachable';
    });

    const handle = await engine.start('deadline-cleanup-timeout', null, {
      executionTimeout: 5000,
    });
    const resultPromise = handle.result().catch(() => {});
    await flush();

    now = 7000;
    await engine.scheduler.tick(now);
    await flush();
    await resultPromise;

    const deadlineKeys: string[] = [];
    for await (const [key] of storage.scan('wf-deadline:')) {
      deadlineKeys.push(key);
    }
    expect(deadlineKeys).toHaveLength(0);

    const timerKeys: string[] = [];
    for await (const [key] of storage.scan('timer-idx:deadline:')) {
      timerKeys.push(key);
    }
    expect(timerKeys).toHaveLength(0);
    engine[Symbol.dispose]();
  });

  it('signalReceived interceptor wraps actual delivery', async () => {
    const engine = new Engine();
    const observed: string[] = [];

    engine.addInterceptor({
      signalReceived(interception, next) {
        observed.push(`signal:${interception.signalName}`);
        next(interception);
      },
    });

    engine.register('signal-intercept-test', async function* (ctx: WorkflowContext) {
      const payload = yield* ctx.waitForSignal('go');
      return payload;
    });

    const handle = await engine.start('signal-intercept-test', null);
    await flush();

    await engine.signal(handle.id, 'go', 'delivered');
    await flush();

    const result = await handle.result();
    expect(result).toBe('delivered');
    expect(observed).toEqual(['signal:go']);
    engine[Symbol.dispose]();
  });

  it('signalReceived interceptor can block delivery', async () => {
    const engine = new Engine();

    engine.addInterceptor({
      signalReceived() {
        // deliberately does not call next — blocks the signal
      },
    });

    engine.register('signal-block-test', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('blocked');
      return 'should not reach';
    });

    const handle = await engine.start('signal-block-test', null);
    await flush();

    await engine.signal(handle.id, 'blocked', 'data');
    await flush();

    // Workflow should still be waiting since signal was blocked
    const stateBytes = await engine.storage.get(KEYS.workflow(handle.id));
    const state = decode(stateBytes!) as WorkflowState;
    expect(state.status).toBe('running');
    engine[Symbol.dispose]();
  });

  it('delivers signals directly when no signal interceptor is registered', async () => {
    const engine = new Engine();

    engine.register('signal-direct-test', async function* (ctx: WorkflowContext) {
      const first = yield* ctx.waitForSignal<string>('go');
      const second = yield* ctx.waitForSignal<{ approved: boolean }>('follow-up');
      return { first, second };
    });

    const handle = await engine.start('signal-direct-test', null);
    await flush();

    await engine.signal(handle.id, 'go', 'delivered');
    await flush();
    await engine.signal(handle.id, 'follow-up', { approved: true });

    await expect(handle.result()).resolves.toEqual({
      first: 'delivered',
      second: { approved: true },
    });

    engine[Symbol.dispose]();
  });

  it('list with status array filter', async () => {
    const engine = new Engine();
    engine.register('multi-status', async function* () {
      return 'ok';
    });
    engine.register('waiter', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('block');
      return 'ok';
    });

    await engine.start('multi-status', null, { id: 'done-1' });
    await engine.start('waiter', null, { id: 'running-1' });
    await flush();

    const result = await engine.list({ status: ['completed', 'running'] });
    expect(result.total).toBe(2);
    engine[Symbol.dispose]();
  });

  it('list with attribute filter loads matched workflows in parallel and preserves filter semantics', async () => {
    const engine = new Engine();
    engine.register('attr-listable', {
      handler: async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('block');
        return 'ok';
      },
      version: '1',
      searchAttributes: { customerId: { type: 'string' } },
    });
    engine.register('other-type', {
      handler: async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('block');
        return 'ok';
      },
      version: '1',
      searchAttributes: { customerId: { type: 'string' } },
    });

    // Three matches for customer "alpha", one for "beta", and one of a
    // different type that should be filtered out by `type`.
    await engine.start('attr-listable', null, {
      id: 'alpha-1',
      searchAttributes: { customerId: 'alpha' },
    });
    await engine.start('attr-listable', null, {
      id: 'alpha-2',
      searchAttributes: { customerId: 'alpha' },
    });
    await engine.start('attr-listable', null, {
      id: 'alpha-3',
      searchAttributes: { customerId: 'alpha' },
    });
    await engine.start('attr-listable', null, {
      id: 'beta-1',
      searchAttributes: { customerId: 'beta' },
    });
    await engine.start('other-type', null, {
      id: 'alpha-other',
      searchAttributes: { customerId: 'alpha' },
    });

    // Spy on storage.get to verify the fast path issued reads in parallel
    // (i.e. as a single batch) instead of awaiting each one serially.
    const storage = engine.storage;
    const getSpy = spyOn(storage, 'get');

    const matched = await engine.list({
      type: 'attr-listable',
      attributes: [{ key: 'customerId', value: 'alpha' }],
    });

    // All three alpha workflows of the requested type, no beta, no other-type.
    expect(matched.items.map((item) => item.id).toSorted()).toEqual([
      'alpha-1',
      'alpha-2',
      'alpha-3',
    ]);
    expect(matched.total).toBe(3);
    expect(matched.items.every((item) => item.type === 'attr-listable')).toBe(true);

    // The fast path should have queued at least the three matched ids before
    // any awaited; with `Promise.all`, all calls are issued before the first
    // resolves. Verify call count rather than ordering since the spy can't
    // tell us "were they parallel" directly.
    expect(getSpy.mock.calls.length).toBeGreaterThanOrEqual(3);

    getSpy.mockRestore();
    engine[Symbol.dispose]();
  });

  it('list with attribute filter skips malformed encoded workflow identifiers in index keys', async () => {
    const engine = new Engine();
    engine.register('attr-listable', {
      handler: async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('block');
        return 'ok';
      },
      version: '1',
      searchAttributes: { customerId: { type: 'string' } },
    });

    await engine.start('attr-listable', null, {
      id: 'alpha-valid',
      searchAttributes: { customerId: 'alpha' },
    });
    await engine.storage.put('idx:customerId:s:alpha:bad%ZZ', new Uint8Array([1]));

    const matched = await engine.list({
      attributes: [{ key: 'customerId', value: 'alpha' }],
    });

    expect(matched.items.map((item) => item.id)).toEqual(['alpha-valid']);

    engine[Symbol.dispose]();
  });

  it('cancel on already completed workflow updates state', async () => {
    const engine = new Engine();
    engine.register('already-done', async function* () {
      return 'done';
    });

    const handle = await engine.start('already-done', null);
    await handle.result();

    // Cancel after completion - should still work without error
    await engine.cancel(handle.id);
    engine[Symbol.dispose]();
  });

  it('advanceWorkflow catch handler fires when handler is not a valid generator', async () => {
    const engine = new Engine();

    // Register a handler that is a regular function (not an async generator).
    // When the engine calls handler(context, input), it returns a non-generator
    // value, and calling .next() on it throws, which is caught by driveGenerator.
    // But if the handler itself throws synchronously before returning, the
    // .catch on advanceWorkflow fires.
    engine.register('bad-handler', (() => {
      throw new Error('handler construction failed');
    }) as any);

    const events: WorkflowFailedEvent[] = [];
    engine.addEventListener(WorkflowFailedEvent.type, (event) => {
      events.push(event as WorkflowFailedEvent);
    });

    const handle = await engine.start('bad-handler', null);
    await expect(handle.result()).rejects.toThrow();
    await flush();

    expect(events.length).toBeGreaterThanOrEqual(1);
    engine[Symbol.dispose]();
  });

  it('getHandle for a completed and resolved workflow loads result from storage', async () => {
    const engine = new Engine();
    engine.register('load-test', async function* () {
      return 'stored-value';
    });

    const handle = await engine.start('load-test', null, { id: 'load-test-id' });
    await handle.result();
    await flush();

    // After workflow completes, result resolvers are cleaned up.
    // Calling getHandle creates a handle that loads from storage.
    const newHandle = engine.getHandle('load-test-id');
    const result = await newHandle.result();
    expect(result).toBe('stored-value');
    engine[Symbol.dispose]();
  });

  it('getHandle for a failed workflow that was loaded from storage throws', async () => {
    const engine = new Engine();
    engine.register('fail-test', async function* () {
      throw new Error('stored failure');
    });

    const handle = await engine.start('fail-test', null, { id: 'fail-test-id' });
    await handle.result().catch(() => {});
    await flush();

    const newHandle = engine.getHandle('fail-test-id');
    await expect(newHandle.result()).rejects.toThrow('stored failure');
    engine[Symbol.dispose]();
  });

  it('getHandle for a running workflow with no cached handle creates a chained promise', async () => {
    const engine = new Engine();
    engine.register('chain-test', async function* (ctx: WorkflowContext) {
      const value = yield* ctx.waitForSignal('proceed');
      return `chained: ${value as string}`;
    });

    const handle = await engine.start('chain-test', null, { id: 'chain-test-id' });
    await flush();

    // The first getHandle returns the cached handle (from start).
    // Calling getHandle again while the workflow is running chains the resolve/reject.
    const handle2 = engine.getHandle('chain-test-id');

    // Now signal the workflow to complete
    await engine.signal('chain-test-id', 'proceed', 'data');

    const result1 = await handle.result();
    const result2 = await handle2.result();
    expect(result1).toBe('chained: data');
    expect(result2).toBe('chained: data');
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // WorkflowHandle async iteration
  // ---------------------------------------------------------------------------

  it('WorkflowHandle Symbol.asyncIterator iterates events until workflow completes', async () => {
    const engine = new Engine();
    const double = async (...args: unknown[]) => (args[0] as number) * 2;

    engine.register('iterable-workflow', async function* (ctx: WorkflowContext, input: unknown) {
      const result = yield* ctx.run(double, input);
      return result;
    });

    const handle = await engine.start('iterable-workflow', 5);
    const collectedTypes: string[] = [];

    for await (const event of handle) {
      collectedTypes.push(event.type);
    }

    expect(collectedTypes).toContain('workflow:completed');
    // Regression guard: previously `workflow:completed` fired twice because
    // both the generic `listener` and the `terminal` handler were registered
    // on terminal event types, so each terminal event was enqueued twice.
    expect(collectedTypes.filter((type) => type === 'workflow:completed')).toHaveLength(1);
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.asyncIterator does not hang when workflow already completed', async () => {
    const engine = new Engine();
    engine.register('already-done', async function* () {
      return 'ok';
    });

    const handle = await engine.start('already-done', null);
    // Wait for the workflow to fully terminate and the completion event to
    // have fired before we begin iterating.
    await handle.result();
    await flush();

    const collected: string[] = [];
    const iterate = (async () => {
      for await (const event of handle) {
        collected.push(event.type);
      }
    })();

    // Watchdog: if the iterator hangs the race returns the sentinel and the
    // test fails. The sentinel is distinct so we can detect a hang specifically.
    const result = await withTimeout(
      iterate.then(() => 'iterated' as const),
      500,
      'workflow handle iteration',
    );

    expect(result).toBe('iterated');
    expect(collected).toContain('workflow:completed');
    // The terminal event must be yielded exactly once — a regression would
    // surface as a duplicate if `listener` and `terminal` were both
    // registered on `workflow:completed`.
    expect(collected.filter((type) => type === 'workflow:completed')).toHaveLength(1);
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.asyncIterator does not double-emit when a late real terminal event races with synthesis', async () => {
    // Regression: the synthesis path pushes a synthetic terminal event and
    // sets `state.done = true`. If a real terminal event arrived later (e.g.
    // because it was in flight between `addEventListener` and the persisted
    // status read), `finishWorkflowHandleIteration` used to unconditionally
    // enqueue it, producing two terminal events. The fix guards it on
    // `state.done`. We simulate the race by starting iteration on an
    // already-terminated workflow and then dispatching a second real
    // terminal event on the handle after synthesis has run.
    const engine = new Engine();
    engine.register('race-target', async function* () {
      return 'ok';
    });

    const handle = await engine.start('race-target', null);
    await handle.result();
    await flush();

    const collected: string[] = [];
    const iterate = (async () => {
      for await (const event of handle) {
        collected.push(event.type);
      }
    })();

    // Give the iterator a microtask to attach listeners and synthesize.
    await flush();
    // Now dispatch a second terminal event that, without the guard, would
    // hit `finishWorkflowHandleIteration` and enqueue a duplicate.
    handle.dispatchEvent(new WorkflowCompletedEvent(handle.id, 'ok', 0));

    const result = await withTimeout(
      iterate.then(() => 'iterated' as const),
      500,
      'workflow handle iteration',
    );

    expect(result).toBe('iterated');
    expect(collected.filter((type) => type === 'workflow:completed')).toHaveLength(1);
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.observable synthetic event does not leak to other listeners on the handle', async () => {
    // Regression: the old synthesis path called `this.dispatchEvent(synthetic)`
    // which broadcasts to every listener attached to the handle — concurrent
    // iterators, other subscribers, and application code. The synthetic
    // event is a private reconstruction for one subscription and must not
    // leak into the handle's global dispatch stream.
    const engine = new Engine();
    engine.register('observable-global-leak', async function* () {
      return 'ok';
    });

    const handle = await engine.start('observable-global-leak', null);
    await handle.result();
    await flush();

    // Foreign listener: a direct addEventListener on the handle. Simulates
    // application code, a concurrent iterator, or another observer.
    const foreignEvents: string[] = [];
    const foreignListener = (event: Event) => {
      foreignEvents.push(event.type);
    };
    handle.addEventListener('workflow:completed', foreignListener);

    // Now subscribe via the observable, which runs the synthesis path
    // because the workflow is already terminated.
    const receivedTypes: string[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();
    const observable = handle[Symbol.observable]();
    const subscription = observable.subscribe({
      next: (event: Event) => {
        receivedTypes.push(event.type);
      },
      complete: () => {
        resolve();
      },
    });

    await promise;
    await flush();

    // The subscriber observed the synthetic completion via its own callbacks.
    expect(receivedTypes).toContain('workflow:completed');
    // The foreign listener must NOT have received the synthetic event —
    // the real `workflow:completed` had already fired before the foreign
    // listener was attached, and synthesis is private to the subscription.
    expect(foreignEvents).toHaveLength(0);

    handle.removeEventListener('workflow:completed', foreignListener);
    subscription.unsubscribe();
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.observable does not emit next() after error/complete on race', async () => {
    // Regression: the `listener` (observer.next) was registered on every
    // event type including terminals, with no `terminalDelivered` guard. If
    // the synthesis path dispatched a synthetic terminal event first (setting
    // `terminalDelivered = true`), a subsequent real terminal event would
    // still invoke `observer.next` even though `observer.complete` or
    // `observer.error` had already fired — violating the Observable
    // contract. The fix wraps the next listener in a `terminalDelivered`
    // guard. Simulate the race by subscribing to an already-completed
    // workflow, letting synthesis fire, then dispatching another terminal
    // event on the handle.
    const engine = new Engine();
    engine.register('observable-race', async function* () {
      return 'ok';
    });

    const handle = await engine.start('observable-race', null);
    await handle.result();
    await flush();

    const receivedTypes: string[] = [];
    let completeCallCount = 0;
    const { promise, resolve } = Promise.withResolvers<void>();

    const observable = handle[Symbol.observable]();
    const subscription = observable.subscribe({
      next: (event: Event) => {
        receivedTypes.push(event.type);
      },
      complete: () => {
        completeCallCount++;
        resolve();
      },
    });

    await promise;
    // Now dispatch a second terminal event post-completion. Without the
    // guard, `observer.next` would fire again after `observer.complete`.
    handle.dispatchEvent(new WorkflowCompletedEvent(handle.id, 'ok', 0));
    await flush();

    expect(completeCallCount).toBe(1);
    expect(receivedTypes.filter((type) => type === 'workflow:completed')).toHaveLength(1);
    subscription.unsubscribe();
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.asyncIterator does not hang when workflow already failed', async () => {
    const engine = new Engine();
    engine.register('already-failed', async function* () {
      throw new Error('boom');
    });

    const handle = await engine.start('already-failed', null);
    await handle.result().catch(() => {});
    await flush();

    const collected: Event[] = [];
    const iterate = (async () => {
      for await (const event of handle) {
        collected.push(event);
      }
    })();

    const result = await withTimeout(
      iterate.then(() => 'iterated' as const),
      500,
      'workflow handle iteration',
    );

    expect(result).toBe('iterated');
    const failure = collected.find((event) => event instanceof WorkflowFailedEvent);
    expect(failure).toBeInstanceOf(WorkflowFailedEvent);
    expect((failure as WorkflowFailedEvent).error.message).toBe('boom');
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.asyncIterator does not hang when workflow already cancelled', async () => {
    const engine = new Engine();
    engine.register('already-cancelled', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('never');
      return 'nope';
    });

    const handle = await engine.start('already-cancelled', null);
    const resultPromise = handle.result().catch(() => {});
    await flush();
    await handle.cancel();
    await resultPromise;
    await flush();

    const collected: Event[] = [];
    const iterate = (async () => {
      for await (const event of handle) {
        collected.push(event);
      }
    })();

    const result = await withTimeout(
      iterate.then(() => 'iterated' as const),
      500,
      'workflow handle iteration',
    );

    expect(result).toBe('iterated');
    expect(collected.some((event) => event instanceof WorkflowCancelledEvent)).toBe(true);
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.asyncIterator does not hang when workflow already timed out', async () => {
    let now = 1000;
    const engine = new Engine({ getNow: () => now });
    engine.register('already-timed-out', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('never');
      return 'nope';
    });

    const handle = await engine.start('already-timed-out', null, { executionTimeout: 5000 });
    const resultPromise = handle.result().catch(() => {});
    await flush();

    now = 7000;
    await engine.scheduler.tick(now);
    await flush();
    await resultPromise;

    const collected: Event[] = [];
    const iterate = (async () => {
      for await (const event of handle) {
        collected.push(event);
      }
    })();

    const result = await withTimeout(
      iterate.then(() => 'iterated' as const),
      500,
      'workflow handle iteration',
    );

    expect(result).toBe('iterated');
    const timedOut = collected.find((event) => event instanceof WorkflowTimedOutEvent);
    expect(timedOut).toBeInstanceOf(WorkflowTimedOutEvent);
    expect((timedOut as WorkflowTimedOutEvent).workflowId).toBe(handle.id);
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.observable does not hang when workflow already completed', async () => {
    const engine = new Engine();
    engine.register('observable-already-done', async function* () {
      return 'done';
    });

    const handle = await engine.start('observable-already-done', null);
    await handle.result();
    await flush();

    const receivedTypes: string[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();

    const observable = handle[Symbol.observable]();
    const subscription = observable.subscribe({
      next: (event: Event) => {
        receivedTypes.push(event.type);
      },
      complete: () => {
        resolve();
      },
    });

    const result = await withTimeout(
      promise.then(() => 'completed' as const),
      500,
      'workflow observable completion',
    );

    expect(result).toBe('completed');
    expect(receivedTypes).toContain('workflow:completed');
    subscription.unsubscribe();
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.observable does not hang when workflow already failed', async () => {
    const engine = new Engine();
    engine.register('observable-already-failed', async function* () {
      throw new Error('kaboom');
    });

    const handle = await engine.start('observable-already-failed', null);
    await handle.result().catch(() => {});
    await flush();

    const receivedTypes: string[] = [];
    let completeCallCount = 0;
    let capturedError: Error | undefined;
    const { promise, resolve } = Promise.withResolvers<void>();

    const observable = handle[Symbol.observable]();
    const subscription = observable.subscribe({
      next: (event: Event) => {
        receivedTypes.push(event.type);
      },
      error: (error: Error) => {
        capturedError = error;
        resolve();
      },
      complete: () => {
        completeCallCount++;
      },
    });

    const result = await withTimeout(
      promise.then(() => 'errored' as const),
      500,
      'workflow observable error',
    );

    // Give any erroneously-queued `complete()` call a chance to fire so the
    // assertion below is meaningful.
    await flush();

    expect(result).toBe('errored');
    expect(capturedError?.message).toBe('kaboom');
    // Observable contract: `error` and `complete` are mutually exclusive.
    expect(completeCallCount).toBe(0);
    expect(receivedTypes).toContain('workflow:failed');
    subscription.unsubscribe();
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.observable does not hang when workflow already cancelled', async () => {
    const engine = new Engine();
    engine.register('observable-already-cancelled', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('never');
      return 'nope';
    });

    const handle = await engine.start('observable-already-cancelled', null);
    const resultPromise = handle.result().catch(() => {});
    await flush();
    await handle.cancel();
    await resultPromise;
    await flush();

    const receivedTypes: string[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();

    const observable = handle[Symbol.observable]();
    const subscription = observable.subscribe({
      next: (event: Event) => {
        receivedTypes.push(event.type);
      },
      complete: () => {
        resolve();
      },
    });

    const result = await withTimeout(
      promise.then(() => 'completed' as const),
      500,
      'workflow observable completion',
    );

    expect(result).toBe('completed');
    expect(receivedTypes).toContain('workflow:cancelled');
    subscription.unsubscribe();
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.observable does not hang when workflow already timed out', async () => {
    let now = 1000;
    const engine = new Engine({ getNow: () => now });
    engine.register('observable-already-timed-out', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('never');
      return 'nope';
    });

    const handle = await engine.start('observable-already-timed-out', null, {
      executionTimeout: 5000,
    });
    const resultPromise = handle.result().catch(() => {});
    await flush();

    now = 7000;
    await engine.scheduler.tick(now);
    await flush();
    await resultPromise;

    const receivedTypes: string[] = [];
    let completeCallCount = 0;
    let capturedError: Error | undefined;
    const { promise, resolve } = Promise.withResolvers<void>();

    const observable = handle[Symbol.observable]();
    const subscription = observable.subscribe({
      next: (event: Event) => {
        receivedTypes.push(event.type);
      },
      error: (error: Error) => {
        capturedError = error;
        resolve();
      },
      complete: () => {
        completeCallCount++;
      },
    });

    const result = await withTimeout(
      promise.then(() => 'errored' as const),
      500,
      'workflow observable error',
    );

    // Give any erroneously-queued `complete()` call a chance to fire so the
    // assertion below is meaningful.
    await flush();

    expect(result).toBe('errored');
    expect(capturedError).toBeInstanceOf(WorkflowTimeoutError);
    // Observable contract: `error` and `complete` are mutually exclusive.
    expect(completeCallCount).toBe(0);
    expect(receivedTypes).toContain('workflow:timed-out');
    subscription.unsubscribe();
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // WorkflowHandle Symbol.observable
  // ---------------------------------------------------------------------------

  it('WorkflowHandle Symbol.observable allows subscribe, receive events, and complete', async () => {
    const engine = new Engine();

    engine.register('observable-workflow', async function* () {
      return 'done';
    });

    const handle = await engine.start('observable-workflow', null);
    const receivedTypes: string[] = [];
    let completed = false;

    const { promise, resolve } = Promise.withResolvers<void>();

    const observable = handle[Symbol.observable]();
    const subscription = observable.subscribe({
      next: (event: Event) => {
        receivedTypes.push(event.type);
      },
      complete: () => {
        completed = true;
        resolve();
      },
    });

    await promise;

    expect(completed).toBe(true);
    expect(receivedTypes).toContain('workflow:completed');

    subscription.unsubscribe();
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // engine.addInterceptor()
  // ---------------------------------------------------------------------------

  it('engine.addInterceptor() registers interceptor that runs on activity', async () => {
    const engine = new Engine();
    const interceptedNames: string[] = [];

    const interceptor: WorkflowInterceptor = {
      *activity(interception, next) {
        interceptedNames.push(interception.activityName);
        return yield* next(interception);
      },
    };

    engine.addInterceptor(interceptor);

    const greet = async (...args: unknown[]) => `Hello, ${args[0] as string}`;

    engine.register('intercepted-workflow', async function* (ctx: WorkflowContext) {
      const result = yield* ctx.run(greet, 'world');
      return result;
    });

    const handle = await engine.start('intercepted-workflow', null);
    const result = await handle.result();

    expect(result).toBe('Hello, world');
    expect(interceptedNames).toContain('greet');
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // activity-side interceptor through engine.addInterceptor()
  // ---------------------------------------------------------------------------

  it('engine.addInterceptor() registers interceptor that wraps activity execution', async () => {
    const engine = new Engine();
    const executionOrder: string[] = [];

    const interceptor: ActivityInterceptor = {
      async execute(interception, next) {
        executionOrder.push(`before:${interception.activityName}`);
        const result = await next(interception);
        executionOrder.push(`after:${interception.activityName}`);
        return result;
      },
    };

    engine.addInterceptor(interceptor);

    const compute = async (...args: unknown[]) => (args[0] as number) + 1;

    engine.register('activity-intercepted', async function* (ctx: WorkflowContext) {
      const result = yield* ctx.run(compute, 10);
      return result;
    });

    const handle = await engine.start('activity-intercepted', null);
    const result = await handle.result();

    expect(result).toBe(11);
    expect(executionOrder).toEqual(['before:compute', 'after:compute']);
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // engine.update()
  // ---------------------------------------------------------------------------

  it('engine.update() sends update to workflow with onUpdate handler and returns response', async () => {
    const engine = new Engine();

    engine.register('updatable-workflow', async function* (ctx: WorkflowContext) {
      ctx.onUpdate('setGreeting', (payload) => {
        return `Hello, ${payload as string}!`;
      });
      // Wait for a signal so the workflow stays alive long enough for the update
      const value = yield* ctx.waitForSignal('finish');
      return value;
    });

    const handle = await engine.start('updatable-workflow', null);
    await flush();

    const updateResult = await engine.update(handle.id, 'setGreeting', 'World');
    expect(updateResult).toBe('Hello, World!');

    // Clean up: signal the workflow to complete
    await engine.signal(handle.id, 'finish', 'done');
    const result = await handle.result();
    expect(result).toBe('done');
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // handle.update()
  // ---------------------------------------------------------------------------

  it('handle.update() convenience method sends update and returns response', async () => {
    const engine = new Engine();

    engine.register('handle-updatable', async function* (ctx: WorkflowContext) {
      ctx.onUpdate('increment', (payload) => {
        return (payload as number) + 1;
      });
      const value = yield* ctx.waitForSignal('finish');
      return value;
    });

    const handle = await engine.start('handle-updatable', null);
    await flush();

    const updateResult = await handle.update('increment', 42);
    expect(updateResult).toBe(43);

    await engine.signal(handle.id, 'finish', 'complete');
    await handle.result();
    engine[Symbol.dispose]();
  });

  it('handle.update() works immediately after start before the first inline turn launches', async () => {
    const engine = new Engine();

    engine.register('handle-immediate-update', async function* (ctx: WorkflowContext) {
      ctx.onUpdate('increment', (payload) => {
        return (payload as number) + 1;
      });
      return yield* ctx.waitForSignal('finish');
    });

    const handle = await engine.start('handle-immediate-update', null);

    await expect(handle.update('increment', 41)).resolves.toBe(42);

    await handle.signal('finish', 'complete');
    await expect(handle.result()).resolves.toBe('complete');
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // ctx.step()
  // ---------------------------------------------------------------------------

  it('ctx.step() works as a non-generator alternative to yield* ctx.run', async () => {
    const engine = new Engine();

    engine.register('step-workflow', async function* (ctx: WorkflowContext) {
      const result = yield* ctx.run(async (...args: unknown[]) => {
        return (args[0] as number) * 3;
      }, 7);
      return result;
    });

    const handle = await engine.start('step-workflow', null);
    const result = await handle.result();
    expect(result).toBe(21);
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // activity() helper function
  // ---------------------------------------------------------------------------

  it('activity() helper wraps a function with colocated configuration', () => {
    const sendEmail = activity({
      name: 'sendEmail',
      execute: async (input: { to: string; body: string }) => {
        return `sent to ${input.to}`;
      },
      timeout: '30s',
      retry: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
    });

    // Should have the ActivityDefinition properties
    expect(sendEmail.name).toBe('sendEmail');
    expect(sendEmail.timeout).toBe('30s');
    expect(sendEmail.retry).toBeDefined();
    expect(sendEmail.execute).toBeInstanceOf(Function);

    // Should also be callable as a function
    expect(typeof sendEmail).toBe('function');
  });

  it('register() accepts a named activity registration', () => {
    const engine = new Engine();

    expect(() =>
      engine.register(
        activity({
          name: 'sendEmail',
          execute: async (input: unknown) => {
            const message = input as { to: string; body: string };
            return `sent to ${message.to}: ${message.body}`;
          },
        }),
      ),
    ).not.toThrow();

    engine[Symbol.dispose]();
  });

  it('register() and ctx.run() accept typed activity definitions', async () => {
    const engine = new Engine();
    const sendEmail = activity({
      name: 'sendEmail',
      execute: async (input: { to: string; body: string }) => {
        return `sent to ${input.to}: ${input.body}`;
      },
    });

    expect(() => engine.register(sendEmail)).not.toThrow();
    engine.register('send-email', async function* (ctx: WorkflowContext) {
      return yield* ctx.run(sendEmail, {
        to: 'hello@example.com',
        body: 'Welcome',
      });
    });

    const handle = await engine.start('send-email', undefined);
    await expect(handle.result()).resolves.toBe('sent to hello@example.com: Welcome');
    engine[Symbol.dispose]();
  });

  it('lists activity definitions registered on the engine', () => {
    const engine = new Engine();
    const inputSchema = makeDefinitionSchema<{ to: string }>();
    const sendEmail = activity({
      name: 'sendEmail',
      description: 'Sends a transactional email.',
      tags: ['email'],
      inputSchema,
      execute: async (input: { to: string }) => `sent to ${input.to}`,
    });

    engine.register(sendEmail);

    const definition = engine.getActivityDefinition('sendEmail');
    expect(definition).toMatchObject({
      name: 'sendEmail',
      queue: 'default',
      description: 'Sends a transactional email.',
      tags: ['email'],
    });
    expect(definition?.inputSchema).toBe(inputSchema);
    expect(engine.listActivityDefinitions().map((entry) => entry.name)).toEqual(['sendEmail']);

    engine[Symbol.dispose]();
  });

  it('register() accepts workflows with typed input', async () => {
    const engine = new Engine();
    const handler = async function* (_ctx: WorkflowContext, input: { name: string }) {
      return `hello ${input.name}`;
    };

    engine.register('typed-greet', handler);
    const handle = await engine.start('typed-greet', { name: 'world' });
    await expect(handle.result()).resolves.toBe('hello world');
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // Development mode DevelopmentWarningEvent
  // ---------------------------------------------------------------------------

  it('development mode dispatches DevelopmentWarningEvent for checkpoint divergences', async () => {
    const engine = new Engine({ development: true });
    const warnings: DevelopmentWarningEvent[] = [];

    engine.addEventListener(DevelopmentWarningEvent.type, (event) => {
      warnings.push(event as DevelopmentWarningEvent);
    });

    engine.register('dev-warning-workflow', async function* (ctx: WorkflowContext) {
      const context = ctx;
      const result = yield* context.run(async () => {
        return new Map([[{ key: 'alpha' }, 42]]);
      });
      yield* context.waitForSignal('release');
      return result;
    });

    const handle = await engine.start('dev-warning-workflow', null);
    await flush();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.workflowId).toBe(handle.id);
    expect(warnings[0]!.fieldPaths).toEqual([
      'accumulatedResults[0][1].Map([object Object])',
      'accumulatedResults[0][1].Map([object Object])',
    ]);
    expect(warnings[0]!.message).toContain('non-serializable field');

    await engine.signal(handle.id, 'release');
    const result = (await handle.result()) as Map<unknown, unknown>;
    expect(result.size).toBe(1);
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // Symbol.observable error path (lines 217-220)
  // ---------------------------------------------------------------------------

  it('WorkflowHandle Symbol.observable calls observer.error on WorkflowFailedEvent', async () => {
    const engine = new Engine();

    engine.register('observable-for-error', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('never');
      return 'nope';
    });

    const handle = await engine.start('observable-for-error', null);
    await flush();

    const receivedErrors: Error[] = [];
    const receivedEvents: string[] = [];

    const { promise, resolve } = Promise.withResolvers<void>();

    const observable = handle[Symbol.observable]();
    const subscription = observable.subscribe({
      next: (event: Event) => {
        receivedEvents.push(event.type);
      },
      error: (error: Error) => {
        receivedErrors.push(error);
        resolve();
      },
    });

    // Dispatch a WorkflowFailedEvent directly on the handle to exercise the failListener
    const testError = new Error('observable failure test');
    handle.dispatchEvent(new WorkflowFailedEvent(handle.id, testError));

    await promise;

    expect(receivedErrors.length).toBe(1);
    expect(receivedErrors[0]!.message).toBe('observable failure test');
    // The event should also have been received by the next handler
    expect(receivedEvents).toContain('workflow:failed');

    subscription.unsubscribe();
    // Cancel the workflow to clean up
    const resultPromise = handle.result().catch(() => {});
    await engine.cancel(handle.id);
    await resultPromise;
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.observable calls observer.error on WorkflowTimedOutEvent', async () => {
    const engine = new Engine();

    engine.register('observable-for-timeout', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('never');
      return 'nope';
    });

    const handle = await engine.start('observable-for-timeout', null);
    await flush();

    const receivedErrors: Error[] = [];
    const receivedEvents: string[] = [];

    const { promise, resolve } = Promise.withResolvers<void>();

    const observable = handle[Symbol.observable]();
    const subscription = observable.subscribe({
      next: (event: Event) => {
        receivedEvents.push(event.type);
      },
      error: (error: Error) => {
        receivedErrors.push(error);
        resolve();
      },
    });

    handle.dispatchEvent(new WorkflowTimedOutEvent(handle.id, 'execution', 5000));

    await promise;

    expect(receivedErrors).toHaveLength(1);
    expect(receivedErrors[0]).toBeInstanceOf(WorkflowTimeoutError);
    expect((receivedErrors[0] as WorkflowTimeoutError).workflowId).toBe(handle.id);
    expect((receivedErrors[0] as WorkflowTimeoutError).timeoutType).toBe('execution');
    expect((receivedErrors[0] as WorkflowTimeoutError).elapsed).toBe(5000);
    expect(receivedEvents).toContain('workflow:timed-out');

    subscription.unsubscribe();
    const resultPromise = handle.result().catch(() => {});
    await engine.cancel(handle.id);
    await resultPromise;
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // getHandle chained resolve/reject for running workflows (lines 448-453)
  // ---------------------------------------------------------------------------

  it('getHandle creates chained resolve callback when WeakRef is cleared', async () => {
    const engine = new Engine();
    engine.register('chain-gc-resolve', async function* (ctx: WorkflowContext) {
      const payload = yield* ctx.waitForSignal('go');
      return `resolved: ${payload as string}`;
    });

    // Start the workflow - the handle is stored in the cache via WeakRef
    let handle: WorkflowHandle | null = await engine.start('chain-gc-resolve', null, {
      id: 'chain-gc-resolve-id',
    });
    const resultPromiseOriginal = handle.result();
    await flush();

    // Drop the only strong reference to the handle and force GC
    handle = null;
    Bun.gc(true);
    await flush();

    // Now getHandle should not find the handle in the cache (WeakRef cleared),
    // so it creates a new handle that chains off the existing result resolver.
    const chainedHandle = engine.getHandle('chain-gc-resolve-id');

    // Signal the workflow to complete, which triggers the chained resolve callback
    await engine.signal('chain-gc-resolve-id', 'go', 'data');

    const result = await chainedHandle.result();
    expect(result).toBe('resolved: data');

    // Also await the original to avoid unhandled rejections
    await resultPromiseOriginal.catch(() => {});
    engine[Symbol.dispose]();
  });

  it('getHandle creates chained reject callback when WeakRef is cleared', async () => {
    const engine = new Engine();
    engine.register('chain-gc-reject', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('never');
      return 'nope';
    });

    let handle: WorkflowHandle | null = await engine.start('chain-gc-reject', null, {
      id: 'chain-gc-reject-id',
    });
    const resultPromiseOriginal = handle.result().catch(() => {});
    await flush();

    // Drop the only strong reference and force GC
    handle = null;
    Bun.gc(true);
    await flush();

    // Get a new chained handle
    const chainedHandle = engine.getHandle('chain-gc-reject-id');
    const resultPromise = chainedHandle.result().catch((error: Error) => error.message);

    await engine.cancel('chain-gc-reject-id');
    await resultPromiseOriginal;

    const error = await resultPromise;
    expect(error).toBe('Workflow cancelled');
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // ctx.runAll operation (lines 847-848)
  // ---------------------------------------------------------------------------

  it('ctx.runAll executes named branches in parallel and returns results', async () => {
    const engine = new Engine();

    const double = async (...args: unknown[]) => (args[0] as number) * 2;
    const triple = async (...args: unknown[]) => (args[0] as number) * 3;
    const addTen = async (...args: unknown[]) => (args[0] as number) + 10;

    engine.register('run-all-workflow', async function* (ctx: WorkflowContext) {
      const results = yield* ctx.runAll({
        doubled: [double, 5],
        tripled: [triple, 5],
        plusTen: [addTen, 5],
      });
      return results;
    });

    const handle = await engine.start('run-all-workflow', null);
    const result = (await handle.result()) as Record<string, number>;

    expect(result['doubled']).toBe(10);
    expect(result['tripled']).toBe(15);
    expect(result['plusTen']).toBe(15);
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // ctx.stream() tests
  // ---------------------------------------------------------------------------

  it('ctx.stream() writes chunks to storage and returns StreamReference', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    // Block completion with a signal so we can assert chunks exist in storage
    // before terminal-state cleanup removes them.
    engine.register('export', async function* (ctx: WorkflowContext) {
      const c = ctx;
      const reference = yield* c.stream('report', async function* (sink) {
        yield { row: 1, data: 'first' };
        sink.heartbeat({ processed: 1 });
        yield { row: 2, data: 'second' };
        sink.heartbeat({ processed: 2 });
      });
      yield* c.waitForSignal('finish');
      return reference;
    });

    const handle = await engine.start('export', {});
    await flush();

    // While workflow is still running, chunks and metadata are in storage
    const chunk0 = await storage.get(KEYS.streamChunk(handle.id, 'report', 0));
    expect(chunk0).not.toBeNull();
    const chunk1 = await storage.get(KEYS.streamChunk(handle.id, 'report', 1));
    expect(chunk1).not.toBeNull();

    // Verify decoded data
    expect(decode(chunk0!)).toEqual({ row: 1, data: 'first' });
    expect(decode(chunk1!)).toEqual({ row: 2, data: 'second' });

    const prefix = KEYS.streamChunkPrefix(handle.id, 'report');
    await storage.put(`${prefix}not-a-number`, encode({ row: 99, data: 'invalid suffix' }));
    await storage.put(`${prefix}0000000003-trailing-text`, encode({ row: 100 }));
    expect(await engine.getStreamChunks(handle.id, 'report')).toEqual([
      { sequence: 0, value: { row: 1, data: 'first' } },
      { sequence: 1, value: { row: 2, data: 'second' } },
    ]);

    // Verify metadata
    const meta = await storage.get(KEYS.streamMetadata(handle.id, 'report'));
    expect(meta).not.toBeNull();

    // Unblock and confirm the returned reference matches
    await engine.signal(handle.id, 'finish');
    const result = (await handle.result()) as StreamReference;
    expect(result.key).toBe('report');
    expect(result.workflowId).toBe(handle.id);
    expect(result.chunkCount).toBe(2);
    expect(result.totalSizeBytes).toBeGreaterThan(0);

    engine[Symbol.dispose]();
  });

  it('ctx.stream() error mid-stream cleans up partial chunks', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    let streamError: Error | undefined;

    engine.register('failing-export', async function* (ctx: WorkflowContext) {
      const c = ctx;
      try {
        yield* c.stream('report', async function* () {
          yield { row: 1 };
          throw new Error('Database connection lost');
        });
        return 'not-reached';
      } catch (error) {
        streamError = error as Error;
        return 'handled';
      }
    });

    const handle = await engine.start('failing-export', {});
    const result = await handle.result();

    expect(result).toBe('handled');
    expect(streamError).toBeDefined();
    expect(streamError!.message).toBe('Database connection lost');

    // Partial chunks should be cleaned up
    const chunk0 = await storage.get(KEYS.streamChunk(handle.id, 'report', 0));
    expect(chunk0).toBeNull();

    engine[Symbol.dispose]();
  });

  it('ctx.stream() with empty generator returns zero chunks', async () => {
    const engine = new Engine();

    engine.register('empty-stream', async function* (ctx: WorkflowContext) {
      const c = ctx;
      const reference = yield* c.stream('empty', async function* () {
        // No chunks yielded
      });
      return reference;
    });

    const handle = await engine.start('empty-stream', {});
    const result = (await handle.result()) as StreamReference;

    expect(result.chunkCount).toBe(0);
    expect(result.totalSizeBytes).toBe(0);

    engine[Symbol.dispose]();
  });

  it('ctx.stream() heartbeats are queryable via handle.query("activityProgress") while streaming', async () => {
    const engine = new Engine();
    const { promise: releasePromise, resolve: releaseStream } = Promise.withResolvers<void>();

    engine.register('stream-progress', async function* (ctx: WorkflowContext) {
      const context = ctx;
      return yield* context.stream('report', async function* (sink) {
        sink.heartbeat({ processed: 1 });
        await releasePromise;
        yield { row: 1, data: 'done' };
      });
    });

    const handle = await engine.start('stream-progress', null);
    await flush();

    expect(await handle.query('activityProgress')).toEqual({ processed: 1 });

    releaseStream();

    const result = (await handle.result()) as StreamReference;
    expect(result.key).toBe('report');
    expect(result.chunkCount).toBe(1);

    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // 1A: Checkpoint size warning events
  // ---------------------------------------------------------------------------

  it('dispatches CheckpointSizeWarningEvent when checkpoint exceeds threshold', async () => {
    // Use a very low threshold so even a small checkpoint triggers the warning
    const engine = new Engine({ checkpointSizeWarningThreshold: 1 });
    const warnings: CheckpointSizeWarningEvent[] = [];

    engine.addEventListener(CheckpointSizeWarningEvent.type, (event) => {
      warnings.push(event as CheckpointSizeWarningEvent);
    });

    const echoActivity = async (...args: unknown[]) => args[0];
    engine.register('big-checkpoint', async function* (ctx: WorkflowContext) {
      const result = yield* ctx.run(echoActivity, 'data');
      return result;
    });

    const handle = await engine.start('big-checkpoint', null);
    await handle.result();

    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]!.workflowId).toBe(handle.id);
    expect(warnings[0]!.sizeBytes).toBeGreaterThanOrEqual(1);
    engine[Symbol.dispose]();
  });

  it('does not dispatch CheckpointSizeWarningEvent when checkpoint is below threshold', async () => {
    // Use an extremely high threshold so warnings never fire
    const engine = new Engine({ checkpointSizeWarningThreshold: 10_000_000 });
    const warnings: CheckpointSizeWarningEvent[] = [];

    engine.addEventListener(CheckpointSizeWarningEvent.type, (event) => {
      warnings.push(event as CheckpointSizeWarningEvent);
    });

    engine.register('small-checkpoint', async function* () {
      return 'tiny';
    });

    const handle = await engine.start('small-checkpoint', null);
    await handle.result();

    expect(warnings).toHaveLength(0);
    engine[Symbol.dispose]();
  });

  it('respects custom checkpointSizeWarningThreshold', async () => {
    const engine = new Engine({ checkpointSizeWarningThreshold: 50 });
    const warnings: CheckpointSizeWarningEvent[] = [];

    engine.addEventListener(CheckpointSizeWarningEvent.type, (event) => {
      warnings.push(event as CheckpointSizeWarningEvent);
    });

    const echoActivity = async (...args: unknown[]) => args[0];
    engine.register('threshold-test', async function* (ctx: WorkflowContext) {
      const result = yield* ctx.run(echoActivity, 'payload');
      return result;
    });

    const handle = await engine.start('threshold-test', null);
    await handle.result();

    // The checkpoint should be > 50 bytes, so the warning should fire
    if (warnings.length > 0) {
      expect(warnings[0]!.sizeBytes).toBeGreaterThanOrEqual(50);
    }
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // 1C: Development mode activates explain logging
  // ---------------------------------------------------------------------------

  it('development mode activates explain logging on workflows', async () => {
    const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const engine = new Engine({ development: true });
      const echoActivity = async (...args: unknown[]) => args[0];

      engine.register('dev-explain', async function* (ctx: WorkflowContext) {
        const result = yield* ctx.run(echoActivity, 'test');
        return result;
      });

      const handle = await engine.start('dev-explain', null);
      await handle.result();

      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('[weft]');
      engine[Symbol.dispose]();
    } finally {
      mock.restore();
    }
  });

  it('development mode activates explain logging on resumed workflows', async () => {
    const storage = new MemoryStorage();

    // First engine: start a workflow that waits for a signal
    const engine1 = new Engine({ storage: storage as WeftStorage });
    engine1.register('dev-resume', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('go');
      const result = yield* ctx.run(async () => 42);
      return result;
    });

    await engine1.start('dev-resume', null, { id: 'dev-resume-id' });
    await flush();

    // Dispose the engine (simulating a crash) without cancelling the workflow
    engine1[Symbol.dispose]();

    // Second engine (development mode): resume the workflow
    const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const engine2 = new Engine({ development: true, storage: storage as WeftStorage });
      engine2.register('dev-resume', async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('go');
        const result = yield* ctx.run(async () => 42);
        return result;
      });

      const resumed = await engine2.resume('dev-resume-id');
      await flush();

      // Signal to finish - the workflow will replay waitForSignal, then run the activity
      await engine2.signal('dev-resume-id', 'go', 'value');
      await resumed.result();

      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('[weft]');
      engine2[Symbol.dispose]();
    } finally {
      mock.restore();
    }
  });

  // ---------------------------------------------------------------------------
  // 1B: callerStack populated in operation requests
  // ---------------------------------------------------------------------------

  it('ctx.run yields a request with non-empty callerStack', () => {
    const { Context: ContextClass } = require('./context.ts') as { Context: typeof Context };
    const context = new ContextClass({
      workflowId: 'wf-caller-stack',
      workflowType: 'test',
      startedAt: 1000,
      abortController: new AbortController(),
    });

    const echoActivity = async (...args: unknown[]) => args[0];
    const generator = context.run(echoActivity, 'test');
    const yielded = generator.next();

    expect(yielded.done).toBe(false);
    const request = yielded.value as Extract<
      import('./context.ts').ContextOperationRequest,
      { type: 'activity' }
    >;
    expect(request.callerStack).toBeDefined();
    expect(request.callerStack!.length).toBeGreaterThan(0);
  });

  it('failed activity errors include workflow call site in stack trace', async () => {
    const engine = new Engine();
    let capturedError: Error | undefined;

    const failingActivity = async () => {
      throw new Error('activity failure');
    };

    engine.register('caller-stack-workflow', async function* (ctx: WorkflowContext) {
      try {
        yield* ctx.run(failingActivity);
      } catch (error) {
        capturedError = error as Error;
        throw error;
      }
      return 'unreachable';
    });

    const handle = await engine.start('caller-stack-workflow', null);
    await handle.result().catch(() => {});

    expect(capturedError).toBeDefined();
    expect(capturedError!.stack).toContain('--- workflow call site ---');
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // 1D: Error stacks survive storage round-trips
  // ---------------------------------------------------------------------------

  it('failed workflow preserves error stack through storage round-trip', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage: storage as WeftStorage });

    engine.register('stack-persist', async function* () {
      throw new Error('deliberate failure for stack test');
    });

    const handle = await engine.start('stack-persist', null, { id: 'stack-persist-id' });
    await handle.result().catch(() => {});

    // Read the state from storage directly
    const stateBytes = await storage.get(KEYS.workflow('stack-persist-id'));
    const state = decode(stateBytes!) as WorkflowState;

    expect(state.status).toBe('failed');
    expect(state.error).toBe('deliberate failure for stack test');
    expect(state.errorStack).toBeDefined();
    expect(state.errorStack).toContain('deliberate failure for stack test');
    engine[Symbol.dispose]();
  });

  it('getHandle for a failed workflow restores the error stack from storage', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage: storage as WeftStorage });

    engine.register('stack-restore', async function* () {
      throw new Error('restorable failure');
    });

    const handle = await engine.start('stack-restore', null, { id: 'stack-restore-id' });
    await handle.result().catch(() => {});
    await flush();

    // Load from storage via a new handle
    const newHandle = engine.getHandle('stack-restore-id');
    try {
      await newHandle.result();
      expect.unreachable('should have thrown');
    } catch (error) {
      const restoredError = error as Error;
      expect(restoredError.message).toBe('restorable failure');
      // The restored error should have the original stack
      expect(restoredError.stack).toContain('restorable failure');
    }
    engine[Symbol.dispose]();
  });

  it('legacy state without errorStack still loads correctly', async () => {
    const storage = new MemoryStorage();
    const { encode: encodeValue } = await import('./codec.ts');

    // Write a legacy state that has no errorStack field
    const legacyState: WorkflowState = {
      id: 'legacy-id',
      type: 'legacy-workflow',
      status: 'failed',
      input: null,
      error: 'old failure',
      version: '1',
      createdAt: 1000,
      updatedAt: 2000,
    };
    await storage.put(KEYS.workflow('legacy-id'), encodeValue(legacyState));

    const engine = new Engine({ storage: storage as WeftStorage });
    engine.register('legacy-workflow', async function* () {
      return 'ok';
    });

    const handle = engine.getHandle('legacy-id');
    try {
      await handle.result();
      expect.unreachable('should have thrown');
    } catch (error) {
      const restoredError = error as Error;
      expect(restoredError.message).toBe('old failure');
    }
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // 1D+: Clean stack traces — user call site appears prominently
  // ---------------------------------------------------------------------------

  it('activity error stack includes both original error and workflow call site sections', async () => {
    const engine = new Engine();
    let capturedError: Error | undefined;

    const brokenActivity = async () => {
      throw new Error('network timeout');
    };

    engine.register('clean-stack-workflow', async function* (ctx: WorkflowContext) {
      try {
        yield* ctx.run(brokenActivity);
      } catch (error) {
        capturedError = error as Error;
        throw error;
      }
      return 'unreachable';
    });

    const handle = await engine.start('clean-stack-workflow', null);
    await handle.result().catch(() => {});

    expect(capturedError).toBeDefined();
    expect(capturedError!.message).toBe('network timeout');
    // The stack should have the original error section
    expect(capturedError!.stack).toContain('network timeout');
    // And the workflow call site separator
    expect(capturedError!.stack).toContain('--- workflow call site ---');
    // The call site section should reference the context module (the yield* site)
    expect(capturedError!.stack).toContain('context');
    engine[Symbol.dispose]();
  });

  it('child workflow error stack includes workflow call site when child fails', async () => {
    const engine = new Engine();
    let capturedError: Error | undefined;

    engine.register('failing-child', async function* () {
      throw new Error('child exploded');
    });

    engine.register('parent-workflow', async function* (ctx: WorkflowContext) {
      try {
        yield* ctx.startChild('failing-child', null);
      } catch (error) {
        capturedError = error as Error;
        throw error;
      }
      return 'unreachable';
    });

    const handle = await engine.start('parent-workflow', null);
    await handle.result().catch(() => {});

    expect(capturedError).toBeDefined();
    expect(capturedError!.message).toContain('child exploded');
    expect(capturedError!.stack).toContain('--- workflow call site ---');
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // engine.get() — retrieve workflow state
  // ---------------------------------------------------------------------------

  it('engine.get() returns workflow state for an existing workflow', async () => {
    const engine = new Engine();
    engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
      return input;
    });

    const handle = await engine.start('echo', 42);
    await handle.result();

    const state = await engine.get(handle.id);
    expect(state).not.toBeNull();
    expect(state!.id).toBe(handle.id);
    expect(state!.type).toBe('echo');
    expect(state!.status).toBe('completed');
    expect(state!.result).toBe(42);
    engine[Symbol.dispose]();
  });

  it('engine.get() returns null for a non-existent workflow', async () => {
    const engine = new Engine();
    const state = await engine.get('nonexistent-id');
    expect(state).toBeNull();
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // engine.getAttributes() / engine.setAttributes()
  // ---------------------------------------------------------------------------

  it('engine.getAttributes() returns null when no attributes exist', async () => {
    const engine = new Engine();
    const attributes = await engine.getAttributes('nonexistent');
    expect(attributes).toBeNull();
    engine[Symbol.dispose]();
  });

  it('engine.setAttributes() writes attributes and engine.getAttributes() reads them', async () => {
    const engine = new Engine();
    await engine.setAttributes('wf-1', { color: 'blue', count: 42 });

    const attributes = await engine.getAttributes('wf-1');
    expect(attributes).not.toBeNull();
    expect(attributes!['color']).toBe('blue');
    expect(attributes!['count']).toBe(42);
    engine[Symbol.dispose]();
  });

  it('engine.setAttributes() merges with existing attributes', async () => {
    const engine = new Engine();
    await engine.setAttributes('wf-2', { color: 'red', size: 'large' });
    await engine.setAttributes('wf-2', { color: 'blue', weight: 10 });

    const attributes = await engine.getAttributes('wf-2');
    expect(attributes).not.toBeNull();
    expect(attributes!['color']).toBe('blue');
    expect(attributes!['size']).toBe('large');
    expect(attributes!['weight']).toBe(10);
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // engine.getEvents()
  // ---------------------------------------------------------------------------

  it('engine.getEvents() returns empty array when no events exist', async () => {
    const engine = new Engine();
    const events = await engine.getEvents('nonexistent');
    expect(events).toEqual([]);
    engine[Symbol.dispose]();
  });

  it('engine.getEvents() returns stored events in order', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const { EventLog } = await import('./event-log.ts');

    const workflowId = 'ev-test';
    const log = new EventLog(storage, workflowId);
    await log.append({ type: 'workflow:started', payload: { workflowId } });
    await log.append({ type: 'activity:started', payload: { workflowId } });
    await log.append({ type: 'workflow:completed', payload: { workflowId } });

    const events = await engine.getEvents(workflowId);
    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe('workflow:started');
    expect(events[1]!.type).toBe('activity:started');
    expect(events[2]!.type).toBe('workflow:completed');
    engine[Symbol.dispose]();
  });

  it('engine.getEvents() does not return the head record as a spurious event', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const { EventLog } = await import('./event-log.ts');
    const { KEYS: EventKeys } = await import('../storage/interface.ts');

    const workflowId = 'ev-head-filter';
    const log = new EventLog(storage, workflowId);
    await log.append({ type: 'workflow:checkpoint', payload: { step: 1 } });

    // Verify the head record exists in storage under the ev: prefix.
    const headBytes = await storage.get(EventKeys.eventHead(workflowId));
    expect(headBytes).not.toBeNull();

    // getEvents() must return only the real entry — not the head record.
    const events = await engine.getEvents(workflowId);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('workflow:checkpoint');

    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // engine.listReviews()
  // ---------------------------------------------------------------------------

  it('engine.listReviews() returns empty array when no reviews exist', async () => {
    const engine = new Engine();
    const reviews = await engine.listReviews();
    expect(reviews).toEqual([]);
    engine[Symbol.dispose]();
  });

  it('engine.listReviews() returns stored reviews', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const { encode: encodeValue } = await import('./codec.ts');

    const review = {
      reviewId: 'rev-1',
      workflowId: 'wf-1',
      artifact: { text: 'review me' },
      reviewType: 'manual',
      reviewers: ['alice'],
      allowPartial: false,
      createdAt: Date.now(),
    };
    await storage.put(KEYS.review('wf-1', 'rev-1'), encodeValue(review));

    const reviews = await engine.listReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!['reviewId']).toBe('rev-1');
    engine[Symbol.dispose]();
  });

  it('engine.listReviews() skips malformed pending review entries instead of throwing', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    await storage.put(KEYS.review('wf-bad', 'rev-bad'), new Uint8Array([0xc1, 0xff, 0x00]));
    await storage.put(
      KEYS.review('wf-good', 'rev-good'),
      encode({
        reviewId: 'rev-good',
        workflowId: 'wf-good',
        artifact: { text: 'review me' },
        reviewType: 'manual',
        reviewers: ['alice'],
        allowPartial: false,
        createdAt: 7_000,
      }),
    );

    const reviews = await engine.listReviews();
    expect(reviews).toEqual([
      expect.objectContaining({
        status: 'pending',
        reviewId: 'rev-good',
      }),
    ]);
    engine[Symbol.dispose]();
  });

  it('engine.listReviews() keeps the default pending-only behavior after a review is completed', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const { encode: encodeValue } = await import('./codec.ts');

    await storage.put(
      KEYS.review('wf-pending-default', 'rev-pending-default'),
      encodeValue({
        reviewId: 'rev-pending-default',
        workflowId: 'wf-pending-default',
        artifact: { text: 'approve me' },
        reviewType: 'manual',
        reviewers: ['alice'],
        allowPartial: false,
        createdAt: 1_000,
      }),
    );

    await engine.submitReview('rev-pending-default', {
      decision: 'approved',
      reviewer: 'alice',
      workflowId: 'wf-pending-default',
    });

    const reviews = await engine.listReviews();
    expect(reviews).toEqual([]);
    engine[Symbol.dispose]();
  });

  it('engine.listReviews({ status: completed }) returns completed entries with review metadata', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const { encode: encodeValue } = await import('./codec.ts');

    await storage.put(
      KEYS.review('wf-completed', 'rev-completed'),
      encodeValue({
        reviewId: 'rev-completed',
        workflowId: 'wf-completed',
        artifact: { text: 'ship it' },
        reviewType: 'design',
        reviewers: ['bob'],
        allowPartial: false,
        createdAt: 2_000,
      }),
    );

    await engine.submitReview('rev-completed', {
      decision: 'approved',
      reviewer: 'bob',
      feedback: 'Looks good',
      workflowId: 'wf-completed',
    });

    const reviews = await engine.listReviews({ status: 'completed' });
    expect(reviews).toEqual([
      expect.objectContaining({
        status: 'completed',
        reviewId: 'rev-completed',
        workflowId: 'wf-completed',
        reviewType: 'design',
        decision: 'approved',
        reviewer: 'bob',
      }),
    ]);
    engine[Symbol.dispose]();
  });

  it('engine.listReviews({ status: completed }) skips decision-only records missing review metadata', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    await storage.put(
      'review-decision:legacy-review',
      encode({
        reviewId: 'legacy-review',
        decision: 'approved',
        reviewer: 'legacy-bot',
        feedback: 'stored by an older runtime',
        timestamp: 9_000,
      }),
    );

    const reviews = await engine.listReviews({ status: 'completed' });
    expect(reviews).toEqual([]);
    engine[Symbol.dispose]();
  });

  it('engine.listReviews({ status: completed }) skips records missing artifact metadata', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    await storage.put(
      'review-decision:missing-artifact',
      encode({
        status: 'completed',
        reviewId: 'missing-artifact',
        workflowId: 'wf-missing-artifact',
        reviewType: 'design',
        reviewers: ['alice'],
        allowPartial: false,
        createdAt: 1_000,
        decision: 'approved',
        reviewer: 'alice',
        timestamp: 2_000,
      }),
    );

    const reviews = await engine.listReviews({ status: 'completed' });
    expect(reviews).toEqual([]);
    engine[Symbol.dispose]();
  });

  it('engine.listReviews({ workflowId }) filters pending reviews by workflow id', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const { encode: encodeValue } = await import('./codec.ts');

    await storage.put(
      KEYS.review('wf-match', 'rev-match'),
      encodeValue({
        reviewId: 'rev-match',
        workflowId: 'wf-match',
        artifact: { text: 'match' },
        reviewType: 'general',
        reviewers: ['alice'],
        allowPartial: false,
        createdAt: 3_000,
      }),
    );
    await storage.put(
      KEYS.review('wf-other', 'rev-other'),
      encodeValue({
        reviewId: 'rev-other',
        workflowId: 'wf-other',
        artifact: { text: 'skip' },
        reviewType: 'general',
        reviewers: ['bob'],
        allowPartial: false,
        createdAt: 4_000,
      }),
    );

    const reviews = await engine.listReviews({ workflowId: 'wf-match' });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toEqual(
      expect.objectContaining({
        status: 'pending',
        reviewId: 'rev-match',
        workflowId: 'wf-match',
      }),
    );
    engine[Symbol.dispose]();
  });

  it('engine.listReviews({ status: completed, reviewType }) filters completed reviews by review type', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const { encode: encodeValue } = await import('./codec.ts');

    await storage.put(
      KEYS.review('wf-a', 'rev-a'),
      encodeValue({
        reviewId: 'rev-a',
        workflowId: 'wf-a',
        artifact: { text: 'approve a' },
        reviewType: 'design',
        reviewers: ['alex'],
        allowPartial: false,
        createdAt: 5_000,
      }),
    );
    await storage.put(
      KEYS.review('wf-b', 'rev-b'),
      encodeValue({
        reviewId: 'rev-b',
        workflowId: 'wf-b',
        artifact: { text: 'approve b' },
        reviewType: 'security',
        reviewers: ['beth'],
        allowPartial: false,
        createdAt: 6_000,
      }),
    );

    await engine.submitReview('rev-a', {
      decision: 'approved',
      reviewer: 'alex',
      workflowId: 'wf-a',
    });
    await engine.submitReview('rev-b', {
      decision: 'rejected',
      reviewer: 'beth',
      workflowId: 'wf-b',
    });

    const reviews = await engine.listReviews({ status: 'completed', reviewType: 'security' });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toEqual(
      expect.objectContaining({
        status: 'completed',
        reviewId: 'rev-b',
        reviewType: 'security',
        decision: 'rejected',
      }),
    );
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // engine.submitReview()
  // ---------------------------------------------------------------------------

  it('engine.submitReview() stores decision and removes pending review', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const { encode: encodeValue } = await import('./codec.ts');

    const review = {
      reviewId: 'rev-submit-1',
      workflowId: 'wf-submit-1',
      artifact: { text: 'approve me' },
      reviewType: 'manual',
      reviewers: ['alice'],
      allowPartial: false,
      createdAt: Date.now(),
    };
    await storage.put(KEYS.review('wf-submit-1', 'rev-submit-1'), encodeValue(review));

    await engine.submitReview('rev-submit-1', {
      decision: 'approved',
      reviewer: 'alice',
      workflowId: 'wf-submit-1',
    });

    // Review should be removed
    const reviewAfter = await storage.get(KEYS.review('wf-submit-1', 'rev-submit-1'));
    expect(reviewAfter).toBeNull();

    // Decision should be stored
    const decisionBytes = await storage.get(
      `review-decision:${encodeStorageKeyComponent('wf-submit-1')}:${encodeStorageKeyComponent('rev-submit-1')}`,
    );
    expect(decisionBytes).not.toBeNull();
    const decisionData = decode(decisionBytes!) as { decision: string; reviewer: string };
    expect(decisionData.decision).toBe('approved');
    expect(decisionData.reviewer).toBe('alice');
    engine[Symbol.dispose]();
  });

  it('engine.submitReview() finds review by scan when workflowId is not provided', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const { encode: encodeValue } = await import('./codec.ts');

    const review = {
      reviewId: 'rev-scan-1',
      workflowId: 'wf-scan-1',
      artifact: { text: 'reject me' },
      reviewType: 'manual',
      reviewers: ['bob'],
      allowPartial: false,
      createdAt: Date.now(),
    };
    await storage.put(KEYS.review('wf-scan-1', 'rev-scan-1'), encodeValue(review));

    await engine.submitReview('rev-scan-1', {
      decision: 'rejected',
      reviewer: 'bob',
    });

    const reviewAfter = await storage.get(KEYS.review('wf-scan-1', 'rev-scan-1'));
    expect(reviewAfter).toBeNull();
    engine[Symbol.dispose]();
  });

  it('engine.submitReview() skips malformed stored reviews while scanning for a match', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    await storage.put(KEYS.review('wf-bad', 'rev-bad'), new Uint8Array([0xc1, 0xff, 0x00]));
    await storage.put(
      KEYS.review('wf-scan-2', 'rev-scan-2'),
      encode({
        reviewId: 'rev-scan-2',
        workflowId: 'wf-scan-2',
        artifact: { text: 'approve me' },
        reviewType: 'manual',
        reviewers: ['bob'],
        allowPartial: false,
        createdAt: 8_000,
      }),
    );

    await engine.submitReview('rev-scan-2', {
      decision: 'approved',
      reviewer: 'bob',
    });

    expect(await storage.get(KEYS.review('wf-scan-2', 'rev-scan-2'))).toBeNull();
    engine[Symbol.dispose]();
  });

  it('engine.submitReview() throws for non-existent review', async () => {
    const engine = new Engine();
    try {
      await engine.submitReview('nonexistent', {
        decision: 'approved',
        reviewer: 'alice',
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('not found');
    }
    engine[Symbol.dispose]();
  });

  it('engine.submitReview() dispatches ReviewCompletedEvent', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const { encode: encodeValue } = await import('./codec.ts');
    const { ReviewCompletedEvent } = await import('./review/events.ts');

    const createdAt = Date.now() - 5000;
    const review = {
      reviewId: 'rev-event-1',
      workflowId: 'wf-event-1',
      artifact: { text: 'review me' },
      reviewType: 'code-review',
      reviewers: ['alice'],
      allowPartial: false,
      createdAt,
    };
    await storage.put(KEYS.review('wf-event-1', 'rev-event-1'), encodeValue(review));

    const receivedEvents: InstanceType<typeof ReviewCompletedEvent>[] = [];
    engine.addEventListener(ReviewCompletedEvent.type, (event) => {
      receivedEvents.push(event as InstanceType<typeof ReviewCompletedEvent>);
    });

    await engine.submitReview('rev-event-1', {
      decision: 'approved',
      reviewer: 'alice',
      workflowId: 'wf-event-1',
    });

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]!.workflowId).toBe('wf-event-1');
    expect(receivedEvents[0]!.reviewId).toBe('rev-event-1');
    expect(receivedEvents[0]!.decision).toBe('approved');
    expect(receivedEvents[0]!.reviewer).toBe('alice');
    expect(receivedEvents[0]!.duration).toBeGreaterThanOrEqual(5000);
    engine[Symbol.dispose]();
  });

  it('engine.submitReview() dispatches ReviewCompletedEvent when workflowId found by scan', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const { encode: encodeValue } = await import('./codec.ts');
    const { ReviewCompletedEvent } = await import('./review/events.ts');

    const createdAt = Date.now() - 3000;
    const review = {
      reviewId: 'rev-scan-event-1',
      workflowId: 'wf-scan-event-1',
      artifact: { text: 'reject me' },
      reviewType: 'general',
      reviewers: ['bob'],
      allowPartial: false,
      createdAt,
    };
    await storage.put(KEYS.review('wf-scan-event-1', 'rev-scan-event-1'), encodeValue(review));

    const receivedEvents: InstanceType<typeof ReviewCompletedEvent>[] = [];
    engine.addEventListener(ReviewCompletedEvent.type, (event) => {
      receivedEvents.push(event as InstanceType<typeof ReviewCompletedEvent>);
    });

    // Submit without workflowId — triggers the scan path
    await engine.submitReview('rev-scan-event-1', {
      decision: 'rejected',
      reviewer: 'bob',
    });

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]!.workflowId).toBe('wf-scan-event-1');
    expect(receivedEvents[0]!.reviewId).toBe('rev-scan-event-1');
    expect(receivedEvents[0]!.decision).toBe('rejected');
    expect(receivedEvents[0]!.reviewer).toBe('bob');
    expect(receivedEvents[0]!.duration).toBeGreaterThanOrEqual(3000);
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // engine.getUpdateResult()
  // ---------------------------------------------------------------------------

  it('engine.getUpdateResult() returns null for non-existent update', async () => {
    const engine = new Engine();
    const result = await engine.getUpdateResult('nonexistent-update-id');
    expect(result).toBeNull();
    engine[Symbol.dispose]();
  });

  it('engine.getUpdateResult() returns stored update response', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    // Use the UpdateCoordinator to create a request and response
    const { UpdateCoordinator } = await import('./updates.ts');
    const coordinator = new UpdateCoordinator(storage);
    const updateId = await coordinator.createRequest('wf-poll', 'setName', { name: 'Alice' });
    const operations = coordinator.buildResponseOperations(updateId, 'wf-poll', { accepted: true });
    await storage.batch(operations);

    const result = await engine.getUpdateResult(updateId);
    expect(result).not.toBeNull();
    expect(result!.updateId).toBe(updateId);
    expect(result!.result).toEqual({ accepted: true });
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // engine.submitCoordinatedUpdate()
  // ---------------------------------------------------------------------------

  it('engine.submitCoordinatedUpdate() creates and waits for response', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
      return input;
    });

    const { UpdateCoordinator } = await import('./updates.ts');
    const coordinator = new UpdateCoordinator(storage);

    // Background poller that resolves updates
    const control = { active: true };
    const poller = (async () => {
      while (control.active) {
        const pending = await coordinator.getPendingUpdates('upd-wf');
        for (const updateRequest of pending) {
          const operations = coordinator.buildResponseOperations(updateRequest.updateId, 'upd-wf', {
            processed: true,
          });
          await storage.batch(operations);
        }
        await sleepForTesting(10);
      }
    })();

    const result = await engine.submitCoordinatedUpdate(
      'upd-wf',
      'setName',
      { name: 'test' },
      {
        timeout: 2000,
      },
    );

    control.active = false;
    await poller;

    expect(result.updateId).toBeDefined();
    expect(result.result).toEqual({ processed: true });
    expect(result.error).toBeUndefined();
    engine[Symbol.dispose]();
  });

  it('engine.submitCoordinatedUpdate() returns cached result for duplicate idempotency key', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const { UpdateCoordinator } = await import('./updates.ts');
    const coordinator = new UpdateCoordinator(storage);

    // Set up a completed update with an idempotency key
    const updateId = await coordinator.createRequest(
      'idem-wf',
      'setName',
      { name: 'Alice' },
      {
        idempotencyKey: 'unique-key',
      },
    );
    const operations = coordinator.buildResponseOperations(
      updateId,
      'idem-wf',
      { accepted: true },
      undefined,
      'unique-key',
    );
    await storage.batch(operations);

    // Call with same idempotency key — should return cached result
    const result = await engine.submitCoordinatedUpdate(
      'idem-wf',
      'setName',
      { name: 'Alice' },
      {
        idempotencyKey: 'unique-key',
      },
    );

    expect(result.updateId).toBe(updateId);
    expect(result.result).toEqual({ accepted: true });
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // Heartbeat details queryable via activityProgress
  // ---------------------------------------------------------------------------

  describe('activityProgress query', () => {
    it('returns heartbeat details via handle.query("activityProgress")', async () => {
      const engine = new Engine();

      // Gate to keep the activity alive while we query
      const { promise: gate, resolve: releaseGate } = Promise.withResolvers<void>();

      async function longRunningActivity(
        _input: unknown,
        activityContext?: import('./types.ts').ActivityContext,
      ): Promise<string> {
        activityContext?.heartbeat({ percent: 25 });
        activityContext?.heartbeat({ percent: 50 });
        await gate;
        return 'done';
      }

      engine.register('progress-workflow', async function* (ctx: WorkflowContext) {
        const context = ctx;
        const result = yield* context.run(longRunningActivity as any, 'input');
        return result;
      });

      const handle = await engine.start('progress-workflow', null);

      // Let the activity start and heartbeats fire
      await flush();

      const progress = await handle.query('activityProgress');
      expect(progress).toEqual({ percent: 50 });

      // Release the activity so the workflow completes
      releaseGate();
      const result = await handle.result();
      expect(result).toBe('done');

      // After completion, progress should be cleared
      const postProgress = await handle.query('activityProgress');
      expect(postProgress).toBeUndefined();

      engine[Symbol.dispose]();
    });

    it('returns undefined when no heartbeat has been sent', async () => {
      const engine = new Engine();

      engine.register('no-heartbeat-workflow', async function* (ctx: WorkflowContext) {
        const context = ctx;
        yield* context.waitForSignal('done');
        return 'ok';
      });

      const handle = await engine.start('no-heartbeat-workflow', null);
      await flush();

      const progress = await handle.query('activityProgress');
      expect(progress).toBeUndefined();

      await engine.signal(handle.id, 'done');
      await handle.result();
      engine[Symbol.dispose]();
    });
  });

  describe('terminal state bookkeeping', () => {
    it('cancelling after a checkpoint batch failure does not invent a phantom timeline step', async () => {
      const script = String.raw`
        import { Engine } from './src/core/engine.ts';
        import { MemoryStorage } from './src/storage/memory.ts';

        const storage = new MemoryStorage();
        const originalBatch = storage.batch.bind(storage);
        let batchCount = 0;
        const checkpointFailure = Promise.withResolvers<void>();
        let engine;

        storage.batch = async (operations) => {
          batchCount++;
          if (batchCount === 3) {
            checkpointFailure.resolve();
            throw new Error('simulated checkpoint batch failure');
          }
          return await originalBatch(operations);
        };

        engine = new Engine({ storage, checkpointHistory: 10 });
        engine.register('wf', async function* (ctx) {
          yield* ctx.run(async () => 'one');
          return yield* ctx.run(async () => 'two');
        });

        const handle = await engine.start('wf', null, { id: 'wf-batch' });
        void handle.result().catch(() => {});

        await checkpointFailure.promise;
        await engine.cancel('wf-batch');
        const timeline = await engine.getTimeline('wf-batch');
        console.log(JSON.stringify(timeline));
        engine[Symbol.dispose]();
        storage[Symbol.dispose]();
        process.exit(0);
      `;

      const process = Bun.spawn(['bun', '-e', script], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await process.exited;
      const stdoutText = await new Response(process.stdout).text();
      const stderrText = await new Response(process.stderr).text();
      const stdout = stdoutText.trim();
      const stderr = stderrText.trim();

      expect(exitCode).toBe(0);
      expect(stderr).toBe('');

      const timeline = JSON.parse(stdout) as Array<{
        outputSummary?: string;
        status: string;
        step: number;
      }>;

      expect(timeline).toHaveLength(1);
      expect(timeline[0]).toMatchObject({
        step: 1,
        status: 'cancelled',
      });
      expect(timeline[0]?.outputSummary).toContain('Workflow cancelled');
    });

    it('failing a workflow does not split the terminal state and timeline writes', async () => {
      const script = String.raw`
        import { Engine } from './src/core/engine.ts';
        import { KEYS } from './src/storage/interface.ts';
        import { MemoryStorage } from './src/storage/memory.ts';

        const workflowId = 'wf-fail-atomic';
        const storage = new MemoryStorage();
        const originalBatch = storage.batch.bind(storage);
        const timeout = setTimeout(() => process.exit(2), 250);

        process.on('unhandledRejection', (error) => {
          console.error(error instanceof Error ? error.message : String(error));
          process.exit(3);
        });

        storage.batch = async (operations) => {
          const isStandaloneTimelineWrite =
            operations.length === 1 &&
            operations[0]?.type === 'put' &&
            operations[0].key.startsWith(KEYS.timelinePrefix(workflowId));
          if (isStandaloneTimelineWrite) {
            throw new Error('simulated standalone timeline write failure');
          }
          return await originalBatch(operations);
        };

        const engine = new Engine({ storage, checkpointHistory: 10 });
        engine.register('wf', async function* (ctx) {
          return yield* ctx.run(async () => {
            throw new Error('boom');
          });
        });

        const handle = await engine.start('wf', null, { id: workflowId });
        try {
          await handle.result();
          process.exit(1);
        } catch (error) {
          const state = await engine.get(workflowId);
          const timeline = await engine.getTimeline(workflowId);
          console.log(
            JSON.stringify({
              message: error instanceof Error ? error.message : String(error),
              status: state?.status,
              timeline,
            }),
          );
          clearTimeout(timeout);
          engine[Symbol.dispose]();
          storage[Symbol.dispose]();
          process.exit(0);
        }
      `;

      const process = Bun.spawn(['bun', '-e', script], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await process.exited;
      const stdoutText = await new Response(process.stdout).text();
      const stderrText = await new Response(process.stderr).text();
      const stdout = stdoutText.trim();
      const stderr = stderrText.trim();

      expect(exitCode).toBe(0);
      expect(stderr).toBe('');

      const result = JSON.parse(stdout) as {
        message: string;
        status?: string;
        timeline: Array<{
          outputSummary?: string;
          status: string;
          step: number;
        }>;
      };

      expect(result.message).toBe('boom');
      expect(result.status).toBe('failed');
      expect(result.timeline).toHaveLength(1);
      expect(result.timeline[0]).toMatchObject({
        step: 1,
        status: 'failed',
      });
      expect(result.timeline[0]?.outputSummary).toContain('boom');
    });

    it('cancelling a workflow does not split the terminal state and timeline writes', async () => {
      const script = String.raw`
        import { Engine } from './src/core/engine.ts';
        import { KEYS } from './src/storage/interface.ts';
        import { MemoryStorage } from './src/storage/memory.ts';

        const workflowId = 'wf-cancel-atomic';
        const storage = new MemoryStorage();
        const originalBatch = storage.batch.bind(storage);
        const timeout = setTimeout(() => process.exit(2), 250);

        process.on('unhandledRejection', (error) => {
          console.error(error instanceof Error ? error.message : String(error));
          process.exit(3);
        });

        storage.batch = async (operations) => {
          const isStandaloneTimelineWrite =
            operations.length === 1 &&
            operations[0]?.type === 'put' &&
            operations[0].key.startsWith(KEYS.timelinePrefix(workflowId));
          if (isStandaloneTimelineWrite) {
            throw new Error('simulated standalone timeline write failure');
          }
          return await originalBatch(operations);
        };

        const engine = new Engine({ storage, checkpointHistory: 10 });
        engine.register('wf', async function* (ctx) {
          yield* ctx.waitForSignal('never');
          return 'unreachable';
        });

        const handle = await engine.start('wf', null, { id: workflowId });
        await new Promise((resolve) => setTimeout(resolve, 25));

        const resultPromise = handle.result().then(
          () => ({ kind: 'resolved' }),
          (error) => ({
            kind: 'rejected',
            message: error instanceof Error ? error.message : String(error),
          }),
        );

        try {
          await engine.cancel(workflowId);
          const result = await resultPromise;
          const state = await engine.get(workflowId);
          const timeline = await engine.getTimeline(workflowId);
          console.log(JSON.stringify({ cancelError: null, result, status: state?.status, timeline }));
          clearTimeout(timeout);
          engine[Symbol.dispose]();
          storage[Symbol.dispose]();
          process.exit(0);
        } catch (error) {
          console.log(
            JSON.stringify({
              cancelError: error instanceof Error ? error.message : String(error),
            }),
          );
          clearTimeout(timeout);
          engine[Symbol.dispose]();
          storage[Symbol.dispose]();
          process.exit(0);
        }
      `;

      const process = Bun.spawn(['bun', '-e', script], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await process.exited;
      const stdoutText = await new Response(process.stdout).text();
      const stderrText = await new Response(process.stderr).text();
      const stdout = stdoutText.trim();
      const stderr = stderrText.trim();

      expect(exitCode).toBe(0);
      expect(stderr).toBe('');

      const result = JSON.parse(stdout) as
        | {
            cancelError: null;
            result: { kind: string; message?: string };
            status?: string;
            timeline: Array<{
              outputSummary?: string;
              status: string;
              step: number;
            }>;
          }
        | { cancelError: string };

      if (result.cancelError !== null) {
        throw new Error(result.cancelError);
      }

      expect(result.result).toMatchObject({
        kind: 'rejected',
        message: 'Workflow cancelled',
      });
      expect(result.status).toBe('cancelled');
      expect(result.timeline).toHaveLength(1);
      expect(result.timeline[0]).toMatchObject({
        step: 1,
        status: 'cancelled',
      });
      expect(result.timeline[0]?.outputSummary).toContain('Workflow cancelled');
    });
  });

  // ---------------------------------------------------------------------------
  // Terminal-state cleanup
  // ---------------------------------------------------------------------------

  describe('terminal-state cleanup', () => {
    it('cancel() removes checkpoints and reviews', async () => {
      const engine = new Engine();

      engine.register('review-wait', async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('never');
        return 'unreached';
      });

      const handle = await engine.start('review-wait', null);
      await flush();

      // Seed a review directly in storage so we can verify cleanup runs.
      const { ReviewCoordinator } = await import('./review/index.ts');
      const coordinator = new ReviewCoordinator(engine.storage);
      const review = await coordinator.createReview(handle.id, {
        artifact: 'pending-artifact',
      });

      const reviewKey = KEYS.review(handle.id, review.reviewId);
      expect(await engine.storage.get(reviewKey)).not.toBeNull();

      const resultPromise = handle.result().catch(() => undefined);
      await engine.cancel(handle.id);
      await resultPromise;
      await engine.scheduler.tick(Date.now() + 120_000);

      // Review entry is deleted
      expect(await engine.storage.get(reviewKey)).toBeNull();
      // In-memory checkpoint is deleted (reflected via public accessor)
      const state = await engine.get(handle.id);
      expect(state?.status).toBe('cancelled');
      engine[Symbol.dispose]();
    });

    it('timeout() removes checkpoints and reviews', async () => {
      const engine = new Engine();

      engine.register('review-wait-timeout', async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('never');
        return 'unreached';
      });

      const handle = await engine.start('review-wait-timeout', null);
      await flush();

      const { ReviewCoordinator } = await import('./review/index.ts');
      const coordinator = new ReviewCoordinator(engine.storage);
      const review = await coordinator.createReview(handle.id, {
        artifact: 'pending-artifact',
      });

      const reviewKey = KEYS.review(handle.id, review.reviewId);
      expect(await engine.storage.get(reviewKey)).not.toBeNull();

      const resultPromise = handle.result().catch(() => undefined);
      await engine.timeout(handle.id);
      await resultPromise;
      await engine.scheduler.tick(Date.now() + 120_000);

      expect(await engine.storage.get(reviewKey)).toBeNull();
      const state = await engine.get(handle.id);
      expect(state?.status).toBe('timed-out');
      engine[Symbol.dispose]();
    });

    it('completing a workflow drops signals but preserves output artifacts', async () => {
      const storage = new MemoryStorage();
      const engine = new Engine({ storage });

      engine.register('cleanup-emitter', async function* (ctx: WorkflowContext) {
        const c = ctx;
        yield* c.stream('chunks', async function* () {
          yield { index: 0 };
          yield { index: 1 };
        });
        yield* c.offload('export', async () => ({ rows: [1, 2, 3] }));
        return 'done';
      });

      const handle = await engine.start('cleanup-emitter', null);

      // Pre-seed: a pending signal (internal state) and durable output
      // artifacts, plus a synthetic event-history key to verify retention.
      await engine.signal(handle.id, 'pre', { ignored: true });
      await storage.put(`ev:${handle.id}:0000000000`, encode({ kind: 'synthetic' }));

      await handle.result();
      await engine.scheduler.tick(Date.now() + 120_000);

      // Signals (internal) are dropped on completion.
      const remainingSignals: string[] = [];
      for await (const [key] of storage.scan(`sig:${handle.id}:`)) {
        remainingSignals.push(key);
      }
      expect(remainingSignals).toEqual([]);

      // Output artifacts are preserved so consumers can still read them
      // after `handle.result()` resolves.
      for (const prefix of [`offload:${handle.id}:`, `blob:${handle.id}:`, `ev:${handle.id}:`]) {
        let count = 0;
        for await (const _ of storage.scan(prefix)) count++;
        expect(count).toBeGreaterThan(0);
      }

      engine[Symbol.dispose]();
    });

    it('completing a workflow drops effect-log entries', async () => {
      // Regression test for the effect-log cleanup path: `cleanupWorkflowStorage`
      // must sweep `tool-effect:` keys so every completed workflow does not
      // leave its per-operation dedup records behind forever.
      const storage = new MemoryStorage();
      const engine = new Engine({ storage });
      const workflowId = 'effect-log-cleanup-workflow-id';

      engine.register('effect-log-cleanup-workflow', async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('finish');
        return 'done';
      });

      const handle = await engine.start('effect-log-cleanup-workflow', null, { id: workflowId });
      const effectLog = new EffectLog(storage, workflowId, 'operation-cleanup');
      for (let index = 0; index < 3; index++) {
        const hash = computeSemanticHash({ effect: 'cleanup', index });
        await effectLog.record(hash, 'cleanup-effect');
        await effectLog.commit(hash, 'cleanup-effect', { index });
      }
      const writtenToolEffectKeys: string[] = [];
      for await (const [key] of storage.scan('tool-effect:')) {
        writtenToolEffectKeys.push(key);
      }
      expect(writtenToolEffectKeys).toHaveLength(3);

      await engine.signal(handle.id, 'finish');
      await handle.result();
      await engine.scheduler.tick(Date.now() + 120_000);

      // The per-operation dedup records must be gone after completion — the
      // workflow has no consumers for them, and leaving them behind leaks
      // linearly with effect volume.
      const remainingToolEffectKeys: string[] = [];
      for await (const [key] of storage.scan('tool-effect:')) {
        remainingToolEffectKeys.push(key);
      }
      expect(remainingToolEffectKeys).toEqual([]);

      engine[Symbol.dispose]();
    });

    it('completing a workflow defers durable scratch cleanup until the terminal cleanup timer fires', async () => {
      const storage = new MemoryStorage();
      const engine = new Engine({ storage });

      engine.register('deferred-terminal-cleanup', async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('finish');
        return 'done';
      });

      const handle = await engine.start('deferred-terminal-cleanup', null);
      await flush();

      const signalKey = KEYS.signal(handle.id, 'pre', 'entry');
      const reviewKey = KEYS.review(handle.id, 'manual-review');
      const workflowHeaderKey = KEYS.workflowHeaders(handle.id);

      await storage.put(signalKey, encode({ ignored: true }));
      await storage.put(reviewKey, encode({ status: 'pending' }));
      await storage.put(workflowHeaderKey, encode([['traceparent', '00-test']]));

      const resultPromise = handle.result();
      await engine.signal(handle.id, 'finish', null);

      await expect(resultPromise).resolves.toBe('done');

      expect(await storage.get(signalKey)).not.toBeNull();
      expect(await storage.get(reviewKey)).not.toBeNull();
      expect(await storage.get(workflowHeaderKey)).not.toBeNull();

      await engine.scheduler.tick(Date.now() + 120_000);

      expect(await storage.get(signalKey)).toBeNull();
      expect(await storage.get(reviewKey)).toBeNull();
      expect(await storage.get(workflowHeaderKey)).toBeNull();

      engine[Symbol.dispose]();
    });

    it('terminal cleanup timers survive restart and remove durable scratch data on the recovered engine', async () => {
      const storage = new MemoryStorage();
      const firstEngine = new Engine({ storage });

      firstEngine.register('restart-terminal-cleanup', async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('finish');
        return 'done';
      });

      const handle = await firstEngine.start('restart-terminal-cleanup', null);
      await flush();

      const signalKey = KEYS.signal(handle.id, 'pre', 'entry');
      const reviewKey = KEYS.review(handle.id, 'manual-review');

      await storage.put(signalKey, encode({ ignored: true }));
      await storage.put(reviewKey, encode({ status: 'pending' }));

      const resultPromise = handle.result();
      await firstEngine.signal(handle.id, 'finish', null);
      await expect(resultPromise).resolves.toBe('done');

      expect(await storage.get(signalKey)).not.toBeNull();
      expect(await storage.get(reviewKey)).not.toBeNull();

      firstEngine[Symbol.dispose]();

      const secondEngine = new Engine({ storage });
      await secondEngine.scheduler.tick(Date.now() + 120_000);

      expect(await storage.get(signalKey)).toBeNull();
      expect(await storage.get(reviewKey)).toBeNull();

      secondEngine[Symbol.dispose]();
    });

    it('terminal cleanup timers still clean up scratch data when getNow() returns fractional timestamps', async () => {
      const storage = new MemoryStorage();
      const warnings: CleanupWarningEvent[] = [];
      const fractionalNow = 1_700_000_000_000.5;
      const engine = new Engine({
        storage,
        getNow: () => fractionalNow,
      });

      engine.addEventListener(CleanupWarningEvent.type, (event) => {
        warnings.push(event as CleanupWarningEvent);
      });

      engine.register('fractional-terminal-cleanup', async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('finish');
        return 'done';
      });

      const handle = await engine.start('fractional-terminal-cleanup', null);
      await flush();

      const reviewKey = KEYS.review(handle.id, 'fractional-review');
      await storage.put(reviewKey, encode({ status: 'pending' }));

      const resultPromise = handle.result();
      await engine.signal(handle.id, 'finish', null);
      await expect(resultPromise).resolves.toBe('done');

      await engine.scheduler.tick(fractionalNow + 120_000);

      expect(await storage.get(reviewKey)).toBeNull();
      expect(warnings).toEqual([]);

      engine[Symbol.dispose]();
    });

    it('terminal cleanup falls back to scan-and-batch deletion when deletePrefix is unavailable', async () => {
      const realStorage = new MemoryStorage();
      const deleteBatches: string[][] = [];
      const storage: WeftStorage = {
        get: realStorage.get.bind(realStorage),
        put: realStorage.put.bind(realStorage),
        delete: realStorage.delete.bind(realStorage),
        scan: realStorage.scan.bind(realStorage),
        batch: async (operations) => {
          deleteBatches.push(
            operations
              .filter((operation) => operation.type === 'delete')
              .map((operation) => operation.key),
          );
          await realStorage.batch(operations);
        },
        [Symbol.dispose]() {
          realStorage[Symbol.dispose]();
        },
      };

      const engine = new Engine({ storage });

      engine.register('fallback-terminal-cleanup', async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('finish');
        return 'done';
      });

      const handle = await engine.start('fallback-terminal-cleanup', null);
      await flush();

      const signalKey = KEYS.signal(handle.id, 'pre', 'entry');
      const reviewKey = KEYS.review(handle.id, 'manual-review');
      const workflowHeaderKey = KEYS.workflowHeaders(handle.id);

      await storage.put(signalKey, encode({ ignored: true }));
      await storage.put(reviewKey, encode({ status: 'pending' }));
      await storage.put(workflowHeaderKey, encode([['traceparent', '00-test']]));

      const resultPromise = handle.result();
      await engine.signal(handle.id, 'finish', null);
      await expect(resultPromise).resolves.toBe('done');

      await engine.scheduler.tick(Date.now() + 120_000);

      expect(await storage.get(signalKey)).toBeNull();
      expect(await storage.get(reviewKey)).toBeNull();
      expect(await storage.get(workflowHeaderKey)).toBeNull();
      expect(deleteBatches.some((keys) => keys.includes(signalKey))).toBe(true);

      engine[Symbol.dispose]();
    });

    it('stale terminal cleanup timers do not delete scratch data for a reused workflow id', async () => {
      const storage = new MemoryStorage();
      const workflowId = 'reused-terminal-cleanup-id';
      const fixedNow = 1_700_000_000_000;

      const firstEngine = new Engine({
        storage,
        getNow: () => fixedNow,
      });
      firstEngine.register('reused-terminal-cleanup', async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('finish');
        return 'old';
      });

      const firstHandle = await firstEngine.start('reused-terminal-cleanup', null, {
        id: workflowId,
      });
      await flush();

      const firstResultPromise = firstHandle.result();
      await firstEngine.signal(firstHandle.id, 'finish', null);
      await expect(firstResultPromise).resolves.toBe('old');

      const firstState = await firstEngine.get(workflowId);
      expect(firstState?.status).toBe('completed');
      const staleTerminalCleanupToken = firstState!.terminalCleanupToken;
      expect(staleTerminalCleanupToken).toBeDefined();

      await firstEngine.deleteAll({ status: 'completed' });
      firstEngine[Symbol.dispose]();

      const secondEngine = new Engine({
        storage,
        getNow: () => fixedNow,
      });
      secondEngine.register('reused-terminal-cleanup', async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('finish');
        return 'new';
      });

      const secondHandle = await secondEngine.start('reused-terminal-cleanup', null, {
        id: workflowId,
      });
      await flush();

      const retainedSignalKey = KEYS.signal(secondHandle.id, 'keep', 'entry');
      const retainedReviewKey = KEYS.review(secondHandle.id, 'keep-review');

      const secondResultPromise = secondHandle.result();
      await secondEngine.signal(secondHandle.id, 'finish', null);
      await expect(secondResultPromise).resolves.toBe('new');

      const secondState = await secondEngine.get(workflowId);
      expect(secondState?.status).toBe('completed');
      expect(secondState?.updatedAt).toBe(fixedNow);

      await storage.put(retainedSignalKey, encode({ kept: true }));
      await storage.put(retainedReviewKey, encode({ status: 'pending' }));

      await secondEngine.scheduler.schedule({
        id: `terminal-cleanup:preserve-output:${staleTerminalCleanupToken!}`,
        workflowId,
        fireAt: fixedNow,
        kind: 'terminal-cleanup',
      });
      await secondEngine.scheduler.tick(fixedNow + 1);

      expect(await storage.get(retainedSignalKey)).not.toBeNull();
      expect(await storage.get(retainedReviewKey)).not.toBeNull();

      await secondEngine.scheduler.tick(fixedNow + 120_000);

      expect(await storage.get(retainedSignalKey)).toBeNull();
      expect(await storage.get(retainedReviewKey)).toBeNull();

      secondEngine[Symbol.dispose]();
    });

    it('malformed terminal cleanup timers emit one warning and are deleted instead of retrying forever', async () => {
      const storage = new MemoryStorage();
      const engine = new Engine({ storage });
      const warnings: CleanupWarningEvent[] = [];
      const fireAt = Date.now();
      const timerId = 'terminal-cleanup:malformed';

      engine.addEventListener(CleanupWarningEvent.type, (event) => {
        warnings.push(event as CleanupWarningEvent);
      });

      await engine.scheduler.schedule({
        id: timerId,
        workflowId: 'wf-malformed-terminal-cleanup',
        fireAt,
        kind: 'terminal-cleanup',
      });
      await engine.scheduler.tick(Date.now() + 120_000);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.error.message).toContain('Ignoring malformed terminal cleanup timer');
      expect(await storage.get(KEYS.terminalCleanup(fireAt, timerId))).toBeNull();

      const remainingTerminalCleanupKeys: string[] = [];
      for await (const [key] of storage.scan('wf-cleanup:')) {
        remainingTerminalCleanupKeys.push(key);
      }
      expect(remainingTerminalCleanupKeys).toEqual([]);

      engine[Symbol.dispose]();
    });

    it('cancelling a workflow drops output artifacts but preserves event history', async () => {
      const storage = new MemoryStorage();
      const engine = new Engine({ storage });

      engine.register('waiter', async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('never');
        return 'unreached';
      });

      const handle = await engine.start('waiter', null);
      await flush();

      // Pre-seed all four workflow-keyed prefixes.
      await storage.put(`offload:${handle.id}:data`, encode({ rows: [1] }));
      await storage.put(`blob:${handle.id}:stream:meta`, encode({ chunks: 1 }));
      await storage.put(KEYS.stateExecution(handle.id, 'counter'), encode({ value: 1 }));
      await storage.put(`sig:${handle.id}:pre:entry`, encode({ ignored: true }));
      await storage.put(`ev:${handle.id}:0000000000`, encode({ kind: 'synthetic' }));

      const resultPromise = handle.result().catch(() => undefined);
      await engine.cancel(handle.id);
      await resultPromise;
      await engine.scheduler.tick(Date.now() + 120_000);

      // Output artifacts AND signals are dropped on cancel (no consumer waiting).
      for (const prefix of [
        `offload:${handle.id}:`,
        `blob:${handle.id}:`,
        `state:execution:${encodeStorageKeyComponent(handle.id)}:`,
        `sig:${handle.id}:`,
      ]) {
        const remaining: string[] = [];
        for await (const [key] of storage.scan(prefix)) {
          remaining.push(key);
        }
        expect(remaining).toEqual([]);
      }

      // Event history is still preserved so the `/events` endpoint keeps
      // working after cancel/timeout.
      const remainingEvents: string[] = [];
      for await (const [key] of storage.scan(`ev:${handle.id}:`)) {
        remainingEvents.push(key);
      }
      expect(remainingEvents).toContain(`ev:${handle.id}:0000000000`);

      engine[Symbol.dispose]();
    });

    it('FinalizationRegistry does not evict a freshly-cached handle', async () => {
      const engine = new Engine();
      engine.register('finalize-stable', async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('release');
        return 'ok';
      });

      const handle = await engine.start('finalize-stable', null, {
        id: 'finalize-stable-id',
      });

      // Simulate the race: when the original handle's WeakRef is cleared, the
      // registry callback fires for the old entry. After #cacheHandle is fixed,
      // the new entry should remain in the cache because the old registration
      // was unregistered before re-registering.
      //
      // We drive the callback path synthetically by calling getHandle() twice
      // after dropping the strong reference — the cached WeakRef may still
      // resolve to a live handle, so we assert the cache entry keeps the new
      // handle alive rather than being spuriously evicted.
      //
      // NOTE: GC is non-deterministic, so this test exercises the structural
      // fix (each cache entry owns an unregister token and a guard in the
      // finalization callback) rather than forcing GC.
      const secondHandle = engine.getHandle('finalize-stable-id');
      expect(secondHandle.id).toBe('finalize-stable-id');
      expect(secondHandle).toBe(handle);

      await engine.signal('finalize-stable-id', 'release');
      await handle.result();
      engine[Symbol.dispose]();
    });
  });
});

describe('Engine speculative execution', () => {
  it('commits speculative branch state only after verification succeeds', async () => {
    const engine = new Engine();
    const events: string[] = [];

    const verified = activity({
      name: 'verified-activity',
      execute: async (input: unknown) => {
        const typedInput = String(input);
        events.push(`execute:${typedInput}`);
        return `result:${typedInput}`;
      },
      verify: async (result: string) => {
        await sleepForTesting(10);
        events.push(`verify:${result}`);
        return true;
      },
    });

    engine.register('speculate-success', async function* (ctx: WorkflowContext) {
      const context = ctx;
      context.setAttribute('phase', 'root');

      const result = yield* context.speculate(async function* (branch) {
        branch.setAttribute('phase', 'speculated');
        return yield* branch.run(verified, 'ok');
      });

      events.push(`after:${String(context.getAttribute('phase'))}`);
      return { result, phase: context.getAttribute('phase') };
    });

    const handle = await engine.start('speculate-success', null);
    const result = (await handle.result()) as { result: string; phase: string };

    expect(result).toEqual({ result: 'result:ok', phase: 'speculated' });
    expect(events).toEqual(['execute:ok', 'verify:result:ok', 'after:speculated']);

    engine[Symbol.dispose]();
  });

  it('discards speculative state and compensates completed activities when verification fails', async () => {
    const engine = new Engine();
    const events: string[] = [];

    const first = activity({
      name: 'first-activity',
      execute: async (input: unknown) => {
        const typedInput = String(input);
        events.push(`execute:${typedInput}`);
        return `result:${typedInput}`;
      },
      verify: async (result: string) => {
        await sleepForTesting(20);
        events.push(`verify:${result}`);
        return false;
      },
      compensate: async (input: unknown, output: string) => {
        events.push(`compensate:${String(input)}:${output}`);
      },
    });

    const second = activity({
      name: 'second-activity',
      execute: async (input: unknown) => {
        const typedInput = String(input);
        events.push(`execute:${typedInput}`);
        return `result:${typedInput}`;
      },
      compensate: async (input: unknown, output: string) => {
        events.push(`compensate:${String(input)}:${output}`);
      },
    });

    engine.register('speculate-rollback', async function* (ctx: WorkflowContext) {
      const context = ctx;
      context.setAttribute('phase', 'root');

      try {
        yield* context.speculate(async function* (branch) {
          branch.setAttribute('phase', 'speculated');
          yield* branch.run(first, 'first');
          yield* branch.run(second, 'second');
          return 'unreachable';
        });
        return { phase: context.getAttribute('phase'), error: null };
      } catch (error) {
        events.push(`caught:${String(context.getAttribute('phase'))}`);
        return {
          phase: context.getAttribute('phase'),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    const handle = await engine.start('speculate-rollback', null);
    const result = (await handle.result()) as { phase: string; error: string };

    expect(result.phase).toBe('root');
    expect(result.error).toContain('Verification failed for activity "first-activity"');
    expect(events.indexOf('execute:second')).toBeLessThan(events.indexOf('verify:result:first'));
    expect(events).toEqual([
      'execute:first',
      'execute:second',
      'verify:result:first',
      'compensate:second:result:second',
      'compensate:first:result:first',
      'caught:root',
    ]);

    engine[Symbol.dispose]();
  });

  it('rolls back speculative runAll activity branches when verification fails', async () => {
    const engine = new Engine();
    const events: string[] = [];

    const first = activity({
      name: 'run-all-first',
      execute: async (input: unknown) => {
        const typedInput = String(input);
        events.push(`execute:${typedInput}`);
        return `result:${typedInput}`;
      },
      verify: async (result: string) => {
        await sleepForTesting(10);
        events.push(`verify:${result}`);
        return false;
      },
      compensate: async (input: unknown, output: string) => {
        events.push(`compensate:${String(input)}:${output}`);
      },
    });

    const second = activity({
      name: 'run-all-second',
      execute: async (input: unknown) => {
        const typedInput = String(input);
        await sleepForTesting(5);
        events.push(`execute:${typedInput}`);
        return `result:${typedInput}`;
      },
      compensate: async (input: unknown, output: string) => {
        events.push(`compensate:${String(input)}:${output}`);
      },
    });

    engine.register('speculate-run-all-rollback', async function* (ctx: WorkflowContext) {
      const context = ctx;
      context.setAttribute('phase', 'root');

      try {
        yield* context.speculate(async function* (branch) {
          branch.setAttribute('phase', 'speculated');
          return yield* branch.runAll({
            first: [first, 'first'],
            second: [second, 'second'],
          });
        });
        return { phase: context.getAttribute('phase'), error: null };
      } catch (error) {
        return {
          phase: context.getAttribute('phase'),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    const handle = await engine.start('speculate-run-all-rollback', null);
    const result = (await handle.result()) as { phase: string; error: string };

    expect(result.phase).toBe('root');
    expect(result.error).toContain('Verification failed for activity "run-all-first"');
    expect(events).toEqual([
      'execute:first',
      'execute:second',
      'verify:result:first',
      'compensate:second:result:second',
      'compensate:first:result:first',
    ]);

    engine[Symbol.dispose]();
  });

  it('continues speculative rollback when a compensation rejects', async () => {
    const engine = new Engine();
    const events: string[] = [];

    const first = activity({
      name: 'rejecting-compensation-first',
      execute: async (input: unknown) => {
        events.push(`execute:first:${String(input)}`);
        return `result:${String(input)}`;
      },
      verify: async () => false,
      compensate: async (input: unknown, output: string) => {
        events.push(`compensate:first:${String(input)}:${output}`);
        throw new Error('compensation failed');
      },
    });

    const second = activity({
      name: 'rejecting-compensation-second',
      execute: async (input: unknown) => {
        events.push(`execute:second:${String(input)}`);
        return `result:${String(input)}`;
      },
      compensate: async (input: unknown, output: string) => {
        events.push(`compensate:second:${String(input)}:${output}`);
      },
    });

    engine.register('speculate-compensation-rejection', async function* (ctx: WorkflowContext) {
      const context = ctx;

      try {
        yield* context.speculate(async function* (branch) {
          yield* branch.run(first, 'first');
          yield* branch.run(second, 'second');
          return 'unreachable';
        });
      } catch (error) {
        return { phase: String(context.getAttribute('phase') ?? 'root'), error: String(error) };
      }

      return { phase: String(context.getAttribute('phase') ?? 'root'), error: 'no-error' };
    });

    const handle = await engine.start('speculate-compensation-rejection', null);
    const result = (await handle.result()) as { phase: string; error: string };

    expect(result.phase).toBe('root');
    expect(result.error).toContain(
      'Verification failed for activity "rejecting-compensation-first"',
    );
    expect(events).toEqual([
      'execute:first:first',
      'execute:second:second',
      'compensate:second:second:result:second',
      'compensate:first:first:result:first',
    ]);

    engine[Symbol.dispose]();
  });

  it('executes speculative ctx.all() branches in parallel and commits their result', async () => {
    const engine = new Engine();

    const double = async (value: unknown) => (value as number) * 2;
    const increment = async (value: unknown) => (value as number) + 1;

    engine.register('speculate-parallel-success', async function* (ctx: WorkflowContext) {
      const context = ctx;
      const result = (yield* context.speculate(async function* (branch) {
        return yield* branch.all([branch.run(double, 5), branch.run(increment, 5)]);
      })) as [number, number];

      return result;
    });

    const handle = await engine.start('speculate-parallel-success', null);

    await expect(handle.result()).resolves.toEqual([10, 6]);

    engine[Symbol.dispose]();
  });

  it('swallows speculative race loser rejections after the winner settles', async () => {
    const engine = new Engine();

    const loserStarted = Promise.withResolvers<void>();
    const losingActivity = activity({
      name: 'abort-aware-loser',
      execute: async (_input: unknown, context?: { signal: AbortSignal }) => {
        loserStarted.resolve();

        return new Promise<never>((_resolve, reject) => {
          context?.signal.addEventListener(
            'abort',
            () => {
              reject(new Error('late loser rejection'));
            },
            { once: true },
          );
        });
      },
    });

    engine.register('speculate-race-abort-workflow', async function* (ctx: WorkflowContext) {
      const context = ctx;
      return yield* context.speculate(async function* (branch) {
        return yield* branch.race([
          branch.memo('winner', async () => {
            await loserStarted.promise;
            return 'winner';
          }),
          branch.run(losingActivity, null),
        ]);
      });
    });

    const handle = await engine.start('speculate-race-abort-workflow', null);

    await expect(handle.result()).resolves.toBe('winner');
    await flush();

    engine[Symbol.dispose]();
  });

  it('swallows speculative compensation failures and preserves the verification error', async () => {
    const engine = new Engine();
    const events: string[] = [];

    const unstable = activity({
      name: 'speculative-compensation-failure',
      execute: async (input: unknown) => {
        events.push(`execute:${String(input)}`);
        return `result:${String(input)}`;
      },
      verify: async () => false,
      compensate: async (_input: unknown, output: string) => {
        events.push(`compensate:${output}`);
        throw new Error('compensator exploded');
      },
    });

    engine.register('speculate-compensation-failure', async function* (ctx: WorkflowContext) {
      const context = ctx;

      try {
        yield* context.speculate(async function* (branch) {
          return yield* branch.run(unstable, 'value');
        });
        return 'unexpected-success';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });

    const handle = await engine.start('speculate-compensation-failure', null);

    await expect(handle.result()).resolves.toContain(
      'Verification failed for activity "speculative-compensation-failure"',
    );
    expect(events).toEqual(['execute:value', 'compensate:result:value']);

    engine[Symbol.dispose]();
  });

  it('treats undefined verification rejections as speculative failures', async () => {
    const engine = new Engine();

    const verified = activity({
      name: 'rejects-undefined',
      execute: async (input: unknown) => `result:${String(input)}`,
      verify: async () => {
        throw undefined;
      },
    });

    engine.register(
      'speculate-undefined-verification-rejection',
      async function* (ctx: WorkflowContext) {
        const context = ctx;
        context.setAttribute('phase', 'root');

        try {
          yield* context.speculate(async function* (branch) {
            branch.setAttribute('phase', 'speculated');
            return yield* branch.run(verified, 'ok');
          });
          return { phase: context.getAttribute('phase'), error: null };
        } catch (error) {
          return {
            phase: context.getAttribute('phase'),
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    );

    const handle = await engine.start('speculate-undefined-verification-rejection', null);
    const result = (await handle.result()) as { phase: string; error: string };

    expect(result).toEqual({ phase: 'root', error: 'undefined' });

    engine[Symbol.dispose]();
  });
});

// ---------------------------------------------------------------------------
// Engine: tenant-isolation safety guards
// ---------------------------------------------------------------------------

describe('Engine tenant-isolation guards', () => {
  it('constructs when both workerExecution and tenantResolver are configured', () => {
    const engine = new Engine({
      tenantResolver: {
        resolve: () => ({ id: 'acme' }),
      },
      workerExecution: {
        workerUrl: new URL('https://example.invalid/worker.js'),
        concurrency: 1,
      },
    });
    expect(engine).toBeInstanceOf(Engine);
    engine[Symbol.dispose]();
  });

  it('still constructs when only workerExecution is configured (no tenant)', () => {
    const engine = new Engine({
      workerExecution: {
        workerUrl: new URL('https://example.invalid/worker.js'),
        concurrency: 1,
      },
    });
    expect(engine).toBeInstanceOf(Engine);
    engine[Symbol.dispose]();
  });

  it('still constructs when only tenantResolver is configured (inline mode)', () => {
    const engine = new Engine({
      tenantResolver: { resolve: () => ({ id: 'acme' }) },
    });
    expect(engine).toBeInstanceOf(Engine);
    engine[Symbol.dispose]();
  });

  it('decodeWorkflowState falls back to undefined tenant when persisted tenant is malformed', async () => {
    const storage = new MemoryStorage();

    // Forge a state record with a tampered `tenant` field — `id` is a number,
    // not a string. A naive `as` cast would let this through and a workflow's
    // `pickToolsForTenant` helper could end up matching on `state.tenant.id === 1`
    // and dispatching admin tools.
    const tamperedState = {
      id: 'wf-tampered',
      type: 'tampered-workflow',
      status: 'completed',
      input: null,
      version: '1',
      createdAt: 1000,
      updatedAt: 2000,
      tenant: { id: 1, attributes: { role: 'admin' } },
    };
    await storage.put(KEYS.workflow('wf-tampered'), encode(tamperedState));

    const warnings: string[] = [];
    const warnSpy = spyOn(console, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });

    try {
      const engine = new Engine({ storage: storage as WeftStorage });
      const listed = await engine.list();

      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]?.id).toBe('wf-tampered');

      // The warning was emitted (at least once — list() may decode twice
      // through fast/slow paths).
      expect(warnings.some((w) => w.includes('invalid tenant field'))).toBe(true);

      // The entire point of this guard: when the engine returns a decoded
      // WorkflowState, the tampered tenant must be stripped to `undefined`
      // so workflow-author tenant-scoping helpers never see it.
      const fetched = await engine.get('wf-tampered');
      expect(fetched).not.toBeNull();
      expect(fetched?.tenant).toBeUndefined();

      // The raw on-disk bytes are deliberately NOT rewritten — we leave
      // remediation of corrupt records to storage-level tooling — so the
      // tampered bytes still exist. Verify the guard is load-time, not
      // persistence-time: the record on disk is unchanged.
      const reloadedBytes = await storage.get(KEYS.workflow('wf-tampered'));
      expect(reloadedBytes).toBeTruthy();
      const reloaded = decode(reloadedBytes!) as { tenant?: unknown };
      expect(reloaded.tenant).toEqual({ id: 1, attributes: { role: 'admin' } });

      engine[Symbol.dispose]();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('decodeWorkflowState falls back to workflow id when execution owner is malformed', async () => {
    const storage = new MemoryStorage();
    const tamperedState = {
      id: 'wf-tampered-owner',
      type: 'tampered-owner-workflow',
      status: 'completed',
      input: null,
      version: '1',
      createdAt: 1000,
      updatedAt: 2000,
      executionStateOwnerId: 'x'.repeat(129),
    };
    await storage.put(KEYS.workflow('wf-tampered-owner'), encode(tamperedState));

    const warnings: string[] = [];
    const warnSpy = spyOn(console, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });

    try {
      const engine = new Engine({ storage: storage as WeftStorage });
      const fetched = await engine.get('wf-tampered-owner');

      expect(fetched?.executionStateOwnerId).toBeUndefined();
      expect(warnings.some((w) => w.includes('invalid executionStateOwnerId field'))).toBe(true);

      engine[Symbol.dispose]();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('decodeWorkflowState accepts a well-formed tenant unchanged', async () => {
    const storage = new MemoryStorage();
    const validState: WorkflowState = {
      id: 'wf-valid-tenant',
      type: 'valid-tenant-workflow',
      status: 'completed',
      input: null,
      version: '1',
      createdAt: 1000,
      updatedAt: 2000,
      tenant: { id: 'acme', attributes: { tier: 'pro' } },
    };
    await storage.put(KEYS.workflow('wf-valid-tenant'), encode(validState));

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const engine = new Engine({ storage: storage as WeftStorage });
      const listed = await engine.list();
      expect(listed.items).toHaveLength(1);
      // No tenant warning should have fired for a well-formed record.
      const warnCalls = warnSpy.mock.calls.flatMap((call) => call.map(String));
      expect(warnCalls.some((c) => c.includes('invalid tenant field'))).toBe(false);
      engine[Symbol.dispose]();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('engine.state exposes tenant, workflow, and execution scoped AtomicState handles', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    expect(
      await engine.state.tenant<number>('tenant-a', 'counter', { initial: 0 }).increment(),
    ).toBe(1);
    expect(await engine.state.tenant<number>('tenant-a', 'counter').get()).toBe(1);
    expect(await engine.state.tenant<number>('tenant-b', 'counter').get()).toBeUndefined();

    expect(
      await engine.state
        .workflow<number>('tenant-a', 'invoice', 'counter', {
          initial: 0,
        })
        .increment(),
    ).toBe(1);
    expect(await engine.state.workflow<number>('tenant-a', 'invoice', 'counter').get()).toBe(1);
    expect(
      await engine.state.workflow<number>('tenant-a', 'receipt', 'counter').get(),
    ).toBeUndefined();

    expect(
      await engine.state.execution<number>('wf-owner', 'counter', { initial: 0 }).increment(),
    ).toBe(1);
    expect(await engine.state.execution<number>('wf-owner', 'counter').get()).toBe(1);

    engine[Symbol.dispose]();
  });

  it('ctx.state conflict diagnostics use the same scoped key as engine.state', async () => {
    const storage = new MemoryStorage();
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    const dataKey = KEYS.stateExecution('wf-conflict-key', 'counter');
    storage.conditionalBatch = async (conditions, operations) => {
      if (operations.some((operation) => operation.key === dataKey)) {
        return false;
      }
      return originalConditionalBatch(conditions, operations);
    };
    const engine = new Engine({ storage });
    let conflictStateKey: string | undefined;

    engine.register('ctx-conflict-key', async function* (ctx: WorkflowContext) {
      const state = (ctx as Context).state.execution<number>('counter', {
        initial: 0,
        maxRetries: 1,
      });
      state.addEventListener('conflict', (event) => {
        conflictStateKey = (event as AtomicStateConflictEvent).stateKey;
      });
      return yield* state.increment();
    });

    const handle = await engine.start('ctx-conflict-key', null, { id: 'wf-conflict-key' });

    await expect(handle.result()).rejects.toThrow(
      `AtomicState conflict: failed to update "${dataKey}" after 1 attempts`,
    );
    expect(conflictStateKey).toBe(dataKey);

    engine[Symbol.dispose]();
  });

  it('ctx.state shares tenant and workflow state while preserving tenant isolation', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({
      storage,
      tenantResolver: tenantFromInputField('tenantId'),
    });

    engine.register('scoped-state', async function* (ctx: WorkflowContext) {
      const context = ctx as Context;
      const tenant = yield* context.state.tenant<number>('counter', { initial: 0 }).increment();
      const workflow = yield* context.state.workflow<number>('counter', { initial: 0 }).increment();
      return { tenant, workflow };
    });

    const first = await engine.start('scoped-state', { tenantId: 'tenant-a' });
    const second = await engine.start('scoped-state', { tenantId: 'tenant-a' });
    const isolated = await engine.start('scoped-state', { tenantId: 'tenant-b' });

    expect(await first.result()).toEqual({ tenant: 1, workflow: 1 });
    expect(await second.result()).toEqual({ tenant: 2, workflow: 2 });
    expect(await isolated.result()).toEqual({ tenant: 1, workflow: 1 });

    engine[Symbol.dispose]();
  });

  it('ctx.state.execution is shared by parent, child, and parallel branches', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    engine.register('execution-child', async function* (ctx: WorkflowContext) {
      return yield* (ctx as Context).state.execution<number>('counter', { initial: 0 }).increment();
    });

    engine.register('execution-parent', async function* (ctx: WorkflowContext) {
      const context = ctx as Context;
      const before = yield* context.state.execution<number>('counter', { initial: 0 }).increment();
      const children = yield* context.all([
        context.startChild<number>('execution-child', null),
        context.startChild<number>('execution-child', null),
      ]);
      const after = yield* context.state.execution<number>('counter').get();
      const sortedChildren = children
        .map((value) => {
          if (typeof value !== 'number') {
            throw new Error('Expected child workflow result to be a number');
          }
          return value;
        })
        .toSorted((left, right) => left - right);
      return { before, children: sortedChildren, after };
    });

    const handle = await engine.start('execution-parent', null, { id: 'wf-execution-owner' });

    expect(await handle.result()).toEqual({ before: 1, children: [2, 3], after: 3 });
    expect(await engine.state.execution<number>('wf-execution-owner', 'counter').get()).toBe(3);

    engine[Symbol.dispose]();
  });

  it('purge deletes execution-scoped state and preserves tenant and workflow state', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({
      storage,
      tenantResolver: tenantFromInputField('tenantId'),
    });

    engine.register('state-cleanup', async function* (ctx: WorkflowContext) {
      const context = ctx as Context;
      yield* context.state.execution<number>('counter', { initial: 0 }).increment();
      yield* context.state.tenant<number>('counter', { initial: 0 }).increment();
      yield* context.state.workflow<number>('counter', { initial: 0 }).increment();
    });

    const handle = await engine.start(
      'state-cleanup',
      { tenantId: 'tenant-a' },
      { id: 'wf-state-cleanup' },
    );
    await handle.result();
    await engine.purge();

    expect(await storage.get(KEYS.stateExecution('wf-state-cleanup', 'counter'))).toBeNull();
    expect(await engine.state.tenant<number>('tenant-a', 'counter').get()).toBe(1);
    expect(await engine.state.workflow<number>('tenant-a', 'state-cleanup', 'counter').get()).toBe(
      1,
    );

    engine[Symbol.dispose]();
  });
});
