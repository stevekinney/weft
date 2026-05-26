import { describe, expect, it, spyOn } from 'bun:test';
import { flushMicrotasks, waitForCondition, yieldToEventLoop } from '../testing/fake-timers.ts';

import type { BatchOperation } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { decode, encode } from './codec.ts';
import { Engine } from './engine.ts';
import {
  CleanupWarningEvent,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
} from './events.ts';
import {
  collectDueCronOccurrences,
  getNextCronOccurrence,
  parseCronExpression,
} from './schedule.ts';
import {
  schedule as defineSchedule,
  workflow as defineWorkflow,
  type ScheduleSummary,
  type WorkflowContext,
  type WorkflowFunction,
  type WorkflowState,
} from './types.ts';

type Clock = {
  now: number;
};

function createEngine(clock: Clock, storage = new MemoryStorage()) {
  return new Engine({
    storage,
    getNow: () => clock.now,
  });
}

class WorkflowStateRaceStorage extends MemoryStorage {
  #targetWorkflowKey: string | null = null;
  workflowStateReadCount = 0;

  arm(workflowId: string): void {
    this.#targetWorkflowKey = KEYS.workflow(workflowId);
    this.workflowStateReadCount = 0;
  }

  override async get(key: string): Promise<Uint8Array | null> {
    const value = await super.get(key);
    if (!value || key !== this.#targetWorkflowKey) {
      return value;
    }

    this.workflowStateReadCount += 1;
    if (this.workflowStateReadCount !== 2) {
      return value;
    }

    const workflowState = decode(value) as WorkflowState;
    return encode({
      ...workflowState,
      status: 'completed',
      result: 'simulated-race-completion',
      updatedAt: workflowState.updatedAt + 1,
    });
  }
}

class ScheduleRunStartFailureStorage extends MemoryStorage {
  failQueuedScheduleRunStart = false;
  queuedScheduleRunStartFailed = false;

  override async batch(operations: BatchOperation[]): Promise<void> {
    if (
      this.failQueuedScheduleRunStart &&
      operations.some(
        (operation) => operation.type === 'put' && operation.key.startsWith('schedule-run:'),
      )
    ) {
      this.queuedScheduleRunStartFailed = true;
      throw new Error('simulated queued schedule start failure');
    }

    return super.batch(operations);
  }
}

async function drainEngine(): Promise<void> {
  await yieldToEventLoop();
  await yieldToEventLoop();
}

function registerWorkflow<TInput, TOutput>(
  engine: Engine,
  name: string,
  handler: WorkflowFunction<TInput, TOutput>,
): void {
  const definition = defineWorkflow({ name }).execute(handler as WorkflowFunction);
  // Cast through `never` to bypass the parameter-position collision brand —
  // the helper is the documented way for tests to register dynamically-named
  // workflows.
  (engine.register as (workflow: typeof definition) => unknown)(definition);
}

function requireNextFireAt(summary: ScheduleSummary): number {
  if (summary.nextFireAt === null) {
    throw new Error(`Schedule "${summary.id}" does not have a next fire time`);
  }
  return summary.nextFireAt;
}

async function tickEngine(engine: Engine, clock: Clock, nextNow: number): Promise<void> {
  clock.now = nextNow;
  await engine.scheduler.tick(clock.now);
  await drainEngine();
}

async function listRunningWorkflowIds(engine: Engine): Promise<string[]> {
  const result = await engine.list({ status: 'running' });
  return result.items.map((item) => item.id).toSorted();
}

async function releaseRunningWorkflows(engine: Engine): Promise<void> {
  for (const workflowId of await listRunningWorkflowIds(engine)) {
    await engine.signal(workflowId, 'release');
  }
  await drainEngine();
}

function expectQueuedScheduleStartWarning(
  warnings: CleanupWarningEvent[],
  workflowId: string,
): void {
  expect(warnings).toHaveLength(1);
  expect(warnings[0]!.source).toBe('handleScheduledWorkflowTerminal');
  expect(warnings[0]!.workflowId).toBe(workflowId);
  expect(warnings[0]!.error.message).toBe('simulated queued schedule start failure');
}

async function createQueuedScheduleStartFailureFixture(): Promise<{
  engine: Engine;
  firstWorkflowId: string;
}> {
  const storage = new ScheduleRunStartFailureStorage();
  const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
  const engine = createEngine(clock, storage);

  registerWorkflow(engine, 'queue-start-failure', async function* (ctx: WorkflowContext) {
    const outcome = yield* ctx.waitForSignal('release');
    if (outcome === 'fail') {
      throw new Error('scheduled failure');
    }

    return typeof outcome === 'string' ? outcome : 'released';
  });

  const schedule = await engine.schedule('queue-start-failure', null, '* * * * *', {
    overlap: 'queue',
  });
  const firstDescription = await schedule.describe();

  await tickEngine(engine, clock, requireNextFireAt(firstDescription));
  const [firstWorkflowId] = await listRunningWorkflowIds(engine);
  expect(firstWorkflowId).toBeDefined();

  const secondDescription = await schedule.describe();
  await tickEngine(engine, clock, requireNextFireAt(secondDescription));

  const queuedDescription = await schedule.describe();
  expect(queuedDescription.queuedRuns).toBe(1);

  storage.failQueuedScheduleRunStart = true;

  return { engine, firstWorkflowId: firstWorkflowId! };
}

describe('recurring schedules', () => {
  it('cron parsing rejects invalid tokens, ranges, steps, and field counts', () => {
    expect(() => parseCronExpression('* * * *')).toThrow(
      'Cron expression must have 5 fields or 6 fields with seconds',
    );
    expect(() => parseCronExpression('x * * * *')).toThrow('Invalid cron token "x"');
    expect(() => parseCronExpression('* * * * * 8')).toThrow(
      'Cron token "8" is outside the allowed range 0-6',
    );
    expect(() => parseCronExpression('5-1 * * * *')).toThrow('Invalid cron range "5-1"');
    expect(() => parseCronExpression('*/0 * * * *')).toThrow('Invalid cron step "*/0"');
    expect(() => parseCronExpression(', * * * *')).toThrow('Invalid cron field ","');
  });

  it('parses named month and weekday aliases, normalizes Sunday aliases, and validates max occurrence limits', () => {
    const namedExpression = parseCronExpression('0 9 * JAN MON');

    expect(namedExpression.months.values).toEqual([1]);
    expect(namedExpression.daysOfWeek.values).toEqual([1]);
    expect(parseCronExpression('* * * * * 7').daysOfWeek.values).toEqual([0]);
    expect(
      collectDueCronOccurrences(
        '* * * * *',
        Date.UTC(2026, 0, 1, 0, 1, 0),
        Date.UTC(2026, 0, 1, 0, 5, 0),
        { maxOccurrences: 2 },
      ),
    ).toEqual([Date.UTC(2026, 0, 1, 0, 1, 0), Date.UTC(2026, 0, 1, 0, 2, 0)]);
    expect(() =>
      collectDueCronOccurrences('* * * * *', Date.UTC(2026, 0, 1, 0, 1, 0), Date.UTC(2026, 0, 5), {
        maxOccurrences: 0,
      }),
    ).toThrow('Cron occurrence maxOccurrences must be a positive safe integer');
  });

  it('matches the day-of-week branch when day-of-month is a wildcard', () => {
    const afterTimestamp = Date.UTC(2026, 0, 5, 12, 0, 0); // Monday

    expect(getNextCronOccurrence('0 9 * * TUE', afterTimestamp)).toBe(
      Date.UTC(2026, 0, 6, 9, 0, 0),
    );
  });

  it('matches the day-of-month branch when day-of-week is a wildcard', () => {
    const afterTimestamp = Date.UTC(2026, 0, 5, 12, 0, 0); // Monday the 5th
    expect(getNextCronOccurrence('0 9 7 * *', afterTimestamp)).toBe(Date.UTC(2026, 0, 7, 9, 0, 0));
  });

  it('falls back to a zero offset when the formatter returns an unparseable GMT offset', () => {
    const originalFormatToParts = Intl.DateTimeFormat.prototype.formatToParts;
    const formatToPartsSpy = spyOn(
      Intl.DateTimeFormat.prototype,
      'formatToParts',
    ).mockImplementation(function (
      this: Intl.DateTimeFormat,
      ...arguments_: Parameters<Intl.DateTimeFormat['formatToParts']>
    ) {
      return originalFormatToParts
        .call(this, ...arguments_)
        .map((part) => (part.type === 'timeZoneName' ? { ...part, value: 'UTC' } : part));
    });

    try {
      expect(getNextCronOccurrence('0 13 * * *', Date.UTC(2026, 0, 5, 12, 0, 0))).toBe(
        Date.UTC(2026, 0, 5, 13, 0, 0),
      );
    } finally {
      formatToPartsSpy.mockRestore();
    }
  });

  it('throws when the formatter does not provide a resolvable weekday name', () => {
    const originalFormatToParts = Intl.DateTimeFormat.prototype.formatToParts;
    const formatToPartsSpy = spyOn(
      Intl.DateTimeFormat.prototype,
      'formatToParts',
    ).mockImplementation(function (
      this: Intl.DateTimeFormat,
      ...arguments_: Parameters<Intl.DateTimeFormat['formatToParts']>
    ) {
      return originalFormatToParts
        .call(this, ...arguments_)
        .map((part) => (part.type === 'weekday' ? { ...part, value: 'Nope' } : part));
    });

    try {
      expect(() => getNextCronOccurrence('* * * * *', Date.UTC(2026, 0, 5, 12, 0, 0))).toThrow(
        'Unable to resolve weekday for time zone "UTC"',
      );
    } finally {
      formatToPartsSpy.mockRestore();
    }
  });

  it('engine.schedule(type, input, cronExpression, options?) registers a recurring workflow and fires it at the next cron boundary', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);
    const executions: Array<{ value: string }> = [];

    registerWorkflow(
      engine,
      'scheduled-echo',
      async function* (_ctx: WorkflowContext, input: { value: string }) {
        executions.push(input);
        return input.value;
      },
    );

    const schedule = await engine.schedule('scheduled-echo', { value: 'first-run' }, '* * * * *');
    const description = await schedule.describe();

    expect(description).toMatchObject({
      workflowType: 'scheduled-echo',
      cronExpression: '* * * * *',
      overlap: 'skip',
      backfill: false,
      status: 'active',
    });
    expect(description.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 1, 0));

    await tickEngine(engine, clock, requireNextFireAt(description));

    expect(executions).toEqual([{ value: 'first-run' }]);

    engine[Symbol.dispose]();
  });

  it('engine.schedule(definition) accepts declarative schedule definitions', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);
    const executions: Array<{ value: string }> = [];
    const scheduledWorkflow = defineWorkflow({ name: 'scheduled-definition-echo' }).execute(
      async function* (_ctx: WorkflowContext, input: { value: string }) {
        executions.push(input);
        return input.value;
      },
    );

    engine.register(scheduledWorkflow);

    const schedule = await engine.schedule(
      defineSchedule({
        workflow: scheduledWorkflow,
        input: { value: 'from-definition' },
        cron: '* * * * *',
        id: 'definition-schedule',
        overlapPolicy: 'allow',
        backfill: true,
      }),
    );
    const description = await schedule.describe();

    expect(description).toMatchObject({
      id: 'definition-schedule',
      workflowType: 'scheduled-definition-echo',
      cronExpression: '* * * * *',
      overlap: 'allow',
      backfill: true,
      status: 'active',
    });

    await tickEngine(engine, clock, requireNextFireAt(description));

    expect(executions).toEqual([{ value: 'from-definition' }]);
    engine[Symbol.dispose]();
  });

  it('engine.schedule(definition) accepts declarative schedule definitions that reference a registered workflow by string', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);
    const executions: Array<{ value: string }> = [];

    registerWorkflow(
      engine,
      'scheduled-definition-string-echo',
      async function* (_ctx: WorkflowContext, input: { value: string }) {
        executions.push(input);
        return input.value;
      },
    );

    const schedule = await engine.schedule(
      defineSchedule({
        workflow: 'scheduled-definition-string-echo',
        input: { value: 'from-string-definition' },
        cron: '* * * * *',
        id: 'definition-string-schedule',
      }),
    );
    const description = await schedule.describe();

    expect(description).toMatchObject({
      id: 'definition-string-schedule',
      workflowType: 'scheduled-definition-string-echo',
      cronExpression: '* * * * *',
      overlap: 'skip',
      backfill: false,
      status: 'active',
    });

    await tickEngine(engine, clock, requireNextFireAt(description));

    expect(executions).toEqual([{ value: 'from-string-definition' }]);
    engine[Symbol.dispose]();
  });

  it('engine.schedule(type, input) rejects missing cron expressions for the positional overload', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);
    const scheduleWithoutCron = engine.schedule as unknown as (
      type: string,
      input: unknown,
    ) => Promise<unknown>;

    registerWorkflow(engine, 'missing-cron-echo', async function* () {
      return 'done';
    });

    await expect(scheduleWithoutCron('missing-cron-echo', null)).rejects.toThrow(
      'cronExpression must be provided when scheduling by workflow type.',
    );

    engine[Symbol.dispose]();
  });

  it('Schedules are durable. Stored in storage under schedule:{id}. Survive process restarts. The scheduler scans for due schedules on startup and resumes ticking.', async () => {
    const storage = new MemoryStorage();
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const executions: string[] = [];

    const firstEngine = createEngine(clock, storage);
    registerWorkflow(
      firstEngine,
      'durable-scheduled-echo',
      async function* (_ctx: WorkflowContext, input: string) {
        executions.push(input);
        return input;
      },
    );

    const schedule = await firstEngine.schedule(
      'durable-scheduled-echo',
      'recovered-run',
      '*/15 * * * * *',
      { id: 'nightly-maintenance' },
    );
    const firstDescription = await schedule.describe();

    expect(await storage.get(KEYS.schedule('nightly-maintenance'))).not.toBeNull();

    firstEngine[Symbol.dispose]();

    const secondEngine = createEngine(clock, storage);
    registerWorkflow(
      secondEngine,
      'durable-scheduled-echo',
      async function* (_ctx: WorkflowContext, input: string) {
        executions.push(input);
        return input;
      },
    );
    await tickEngine(secondEngine, clock, requireNextFireAt(firstDescription));

    expect(executions).toEqual(['recovered-run']);

    secondEngine[Symbol.dispose]();
  });

  it('rejects a concurrent duplicate explicit schedule id before the later call can overwrite the stored schedule', async () => {
    const storage = new MemoryStorage();
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock, storage);

    registerWorkflow(
      engine,
      'duplicate-schedule-workflow',
      async function* (_ctx: WorkflowContext, input: string) {
        return input;
      },
    );

    const firstCreation = engine.schedule(
      'duplicate-schedule-workflow',
      'first-input',
      '* * * * *',
      { id: 'duplicate-schedule-id' },
    );
    const secondCreation = engine.schedule(
      'duplicate-schedule-workflow',
      'second-input',
      '*/2 * * * *',
      { id: 'duplicate-schedule-id' },
    );

    const [firstResult, secondResult] = await Promise.allSettled([firstCreation, secondCreation]);

    expect(firstResult.status).toBe('fulfilled');
    expect(secondResult.status).toBe('rejected');
    if (secondResult.status !== 'rejected') {
      expect.unreachable('Expected the duplicate schedule creation to be rejected');
    }
    expect(secondResult.reason).toBeInstanceOf(Error);
    expect((secondResult.reason as Error).message).toBe(
      'Schedule with id "duplicate-schedule-id" already exists',
    );

    const storedScheduleBytes = await storage.get(KEYS.schedule('duplicate-schedule-id'));
    expect(storedScheduleBytes).not.toBeNull();
    expect(decode(storedScheduleBytes!)).toMatchObject({
      id: 'duplicate-schedule-id',
      cronExpression: '* * * * *',
      input: 'first-input',
    });
    expect(await storage.get('timer-idx:schedule:duplicate-schedule-id')).not.toBeNull();

    engine[Symbol.dispose]();
  });

  it('Pauses a schedule and clears the fired timer when the workflow registration is missing after restart.', async () => {
    const storage = new MemoryStorage();
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };

    const firstEngine = createEngine(clock, storage);
    registerWorkflow(
      firstEngine,
      'restart-sensitive-schedule',
      async function* (_ctx: WorkflowContext, input: string) {
        return input;
      },
    );

    const schedule = await firstEngine.schedule(
      'restart-sensitive-schedule',
      'recovered-run',
      '*/15 * * * * *',
      { id: 'restart-sensitive-schedule' },
    );
    const firstDescription = await schedule.describe();
    const firstFireAt = requireNextFireAt(firstDescription);

    firstEngine[Symbol.dispose]();

    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    let secondEngine: Engine | undefined;

    try {
      secondEngine = createEngine(clock, storage);

      await tickEngine(secondEngine, clock, firstFireAt);

      const pausedSchedule = await secondEngine.getSchedule('restart-sensitive-schedule');

      expect(pausedSchedule).not.toBeNull();
      expect(pausedSchedule).toMatchObject({
        id: 'restart-sensitive-schedule',
        status: 'paused',
        nextFireAt: getNextCronOccurrence('*/15 * * * * *', firstFireAt),
      });
      expect(await listRunningWorkflowIds(secondEngine)).toEqual([]);
      expect(
        await storage.get(KEYS.scheduleTick(firstFireAt, 'restart-sensitive-schedule')),
      ).toBeNull();
      expect(await storage.get('timer-idx:schedule:restart-sensitive-schedule')).toBeNull();
    } finally {
      secondEngine?.[Symbol.dispose]();
      errorSpy.mockRestore();
    }
  });

  it("Overlap policy is configurable. { overlap: 'skip' } does not start a new run while the previous run is still executing.", async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);

    registerWorkflow(engine, 'overlap-skip', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('release');
      return 'released';
    });

    const schedule = await engine.schedule('overlap-skip', null, '* * * * *', { overlap: 'skip' });
    const firstDescription = await schedule.describe();

    await tickEngine(engine, clock, requireNextFireAt(firstDescription));
    expect(await listRunningWorkflowIds(engine)).toHaveLength(1);

    const secondDescription = await schedule.describe();
    await tickEngine(engine, clock, requireNextFireAt(secondDescription));

    expect(await listRunningWorkflowIds(engine)).toHaveLength(1);

    await releaseRunningWorkflows(engine);
    engine[Symbol.dispose]();
  });

  it("Overlap policy is configurable. { overlap: 'skip' } uses one workflow-state snapshot per timer tick.", async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const storage = new WorkflowStateRaceStorage();
    const engine = createEngine(clock, storage);

    registerWorkflow(
      engine,
      'overlap-skip-single-snapshot',
      async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('release');
        return 'released';
      },
    );

    const schedule = await engine.schedule('overlap-skip-single-snapshot', null, '* * * * *', {
      id: 'overlap-skip-single-snapshot',
      overlap: 'skip',
    });
    const firstDescription = await schedule.describe();

    await tickEngine(engine, clock, requireNextFireAt(firstDescription));
    const [firstWorkflowId] = await listRunningWorkflowIds(engine);
    expect(firstWorkflowId).toBeDefined();

    storage.arm(firstWorkflowId!);

    const secondDescription = await schedule.describe();
    await tickEngine(engine, clock, requireNextFireAt(secondDescription));

    expect(await listRunningWorkflowIds(engine)).toEqual([firstWorkflowId!]);

    const updatedSchedule = await schedule.describe();
    expect(updatedSchedule.currentWorkflowId).toBe(firstWorkflowId);
    expect(storage.workflowStateReadCount).toBe(1);

    await releaseRunningWorkflows(engine);
    engine[Symbol.dispose]();
  });

  it("Overlap policy is configurable. { overlap: 'allow' } starts a new run even while the previous run is still executing.", async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);

    registerWorkflow(engine, 'overlap-allow', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('release');
      return 'released';
    });

    const schedule = await engine.schedule('overlap-allow', null, '* * * * *', {
      overlap: 'allow',
    });
    const firstDescription = await schedule.describe();

    await tickEngine(engine, clock, requireNextFireAt(firstDescription));
    expect(await listRunningWorkflowIds(engine)).toHaveLength(1);

    const secondDescription = await schedule.describe();
    await tickEngine(engine, clock, requireNextFireAt(secondDescription));

    expect(await listRunningWorkflowIds(engine)).toHaveLength(2);

    await releaseRunningWorkflows(engine);
    engine[Symbol.dispose]();
  });

  it("Overlap policy is configurable. { overlap: 'cancel-running' } cancels the previous run before starting a new one.", async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);

    registerWorkflow(engine, 'overlap-cancel-running', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('release');
      return 'released';
    });

    const schedule = await engine.schedule('overlap-cancel-running', null, '* * * * *', {
      overlap: 'cancel-running',
    });
    const firstDescription = await schedule.describe();

    await tickEngine(engine, clock, requireNextFireAt(firstDescription));
    const [firstWorkflowId] = await listRunningWorkflowIds(engine);
    expect(firstWorkflowId).toBeDefined();
    const cancelledResult = engine
      .getHandle(firstWorkflowId!)
      .result()
      .catch((error: Error) => error.message);

    const secondDescription = await schedule.describe();
    await tickEngine(engine, clock, requireNextFireAt(secondDescription));

    expect(await cancelledResult).toBe('Workflow cancelled');
    expect(await engine.get(firstWorkflowId!)).toMatchObject({ status: 'cancelled' });
    expect(await listRunningWorkflowIds(engine)).toHaveLength(1);

    await releaseRunningWorkflows(engine);
    engine[Symbol.dispose]();
  });

  it("Overlap policy is configurable. { overlap: 'queue' } waits for the previous run to complete before starting the queued run.", async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);

    registerWorkflow(engine, 'overlap-queue', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('release');
      return 'released';
    });

    const schedule = await engine.schedule('overlap-queue', null, '* * * * *', {
      overlap: 'queue',
    });
    const firstDescription = await schedule.describe();

    await tickEngine(engine, clock, requireNextFireAt(firstDescription));
    const [firstWorkflowId] = await listRunningWorkflowIds(engine);
    expect(firstWorkflowId).toBeDefined();

    const secondDescription = await schedule.describe();
    await tickEngine(engine, clock, requireNextFireAt(secondDescription));
    expect(await listRunningWorkflowIds(engine)).toHaveLength(1);

    await engine.signal(firstWorkflowId!, 'release');
    await drainEngine();

    const runningAfterRelease = await listRunningWorkflowIds(engine);
    expect(runningAfterRelease).toHaveLength(1);
    expect(runningAfterRelease[0]).not.toBe(firstWorkflowId);

    await releaseRunningWorkflows(engine);
    engine[Symbol.dispose]();
  });

  it('queue overlap still dispatches WorkflowCancelledEvent when starting the queued run fails', async () => {
    const { engine, firstWorkflowId } = await createQueuedScheduleStartFailureFixture();
    const warnings: CleanupWarningEvent[] = [];
    const terminalEvents: WorkflowCancelledEvent[] = [];

    engine.addEventListener(CleanupWarningEvent.type, (event) => {
      warnings.push(event as CleanupWarningEvent);
    });
    engine.addEventListener(WorkflowCancelledEvent.type, (event) => {
      terminalEvents.push(event as WorkflowCancelledEvent);
    });

    try {
      const cancellationPromise = engine.cancel(firstWorkflowId).then(
        () => 'resolved',
        (error: Error) => error.message,
      );
      const resultPromise = engine
        .getHandle(firstWorkflowId)
        .result()
        .catch((error: Error) => error.message);

      expect(await cancellationPromise).toBe('resolved');
      expect(await resultPromise).toBe('Workflow cancelled');
      await drainEngine();

      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]!.workflowId).toBe(firstWorkflowId);
      expectQueuedScheduleStartWarning(warnings, firstWorkflowId);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('queue overlap still dispatches WorkflowCompletedEvent when starting the queued run fails', async () => {
    const { engine, firstWorkflowId } = await createQueuedScheduleStartFailureFixture();
    const warnings: CleanupWarningEvent[] = [];
    const terminalEvents: WorkflowCompletedEvent[] = [];

    engine.addEventListener(CleanupWarningEvent.type, (event) => {
      warnings.push(event as CleanupWarningEvent);
    });
    engine.addEventListener(WorkflowCompletedEvent.type, (event) => {
      terminalEvents.push(event as WorkflowCompletedEvent);
    });

    try {
      const resultPromise = engine.getHandle(firstWorkflowId).result();

      await engine.signal(firstWorkflowId, 'release', 'completed');
      await expect(resultPromise).resolves.toBe('completed');
      await drainEngine();

      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]!.workflowId).toBe(firstWorkflowId);
      expect(terminalEvents[0]!.result).toBe('completed');
      expectQueuedScheduleStartWarning(warnings, firstWorkflowId);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('queue overlap still dispatches WorkflowFailedEvent when starting the queued run fails', async () => {
    const { engine, firstWorkflowId } = await createQueuedScheduleStartFailureFixture();
    const warnings: CleanupWarningEvent[] = [];
    const terminalEvents: WorkflowFailedEvent[] = [];

    engine.addEventListener(CleanupWarningEvent.type, (event) => {
      warnings.push(event as CleanupWarningEvent);
    });
    engine.addEventListener(WorkflowFailedEvent.type, (event) => {
      terminalEvents.push(event as WorkflowFailedEvent);
    });

    try {
      const resultPromise = engine
        .getHandle(firstWorkflowId)
        .result()
        .catch((error: Error) => error);

      await engine.signal(firstWorkflowId, 'release', 'fail');
      const result = await resultPromise;
      await drainEngine();

      expect(result).toBeInstanceOf(Error);
      if (!(result instanceof Error)) {
        expect.unreachable('Expected the scheduled workflow failure to produce an Error');
      }
      expect(result.message).toBe('scheduled failure');
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]!.workflowId).toBe(firstWorkflowId);
      expect(terminalEvents[0]!.error.message).toBe('scheduled failure');
      expectQueuedScheduleStartWarning(warnings, firstWorkflowId);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('Schedules support backfill. { backfill: true } runs missed ticks on recovery and { backfill: false } skips them.', async () => {
    const storage = new MemoryStorage();
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const executions: Array<string> = [];

    const firstEngine = createEngine(clock, storage);
    registerWorkflow(
      firstEngine,
      'backfill-workflow',
      async function* (_ctx: WorkflowContext, input: string) {
        executions.push(input);
        return input;
      },
    );

    const catchUp = await firstEngine.schedule('backfill-workflow', 'catch-up', '* * * * *', {
      id: 'schedule-catch-up',
      backfill: true,
      overlap: 'allow',
    });
    const skip = await firstEngine.schedule('backfill-workflow', 'skip-missed', '* * * * *', {
      id: 'schedule-skip',
      backfill: false,
    });
    const catchUpDescription = await catchUp.describe();
    const skipDescription = await skip.describe();

    firstEngine[Symbol.dispose]();

    const secondEngine = createEngine(clock, storage);
    registerWorkflow(
      secondEngine,
      'backfill-workflow',
      async function* (_ctx: WorkflowContext, input: string) {
        executions.push(input);
        return input;
      },
    );

    await tickEngine(secondEngine, clock, Date.UTC(2026, 0, 1, 0, 3, 0));

    expect(executions.filter((input) => input === 'catch-up')).toHaveLength(3);
    expect(executions.filter((input) => input === 'skip-missed')).toHaveLength(0);

    const updatedCatchUp = await secondEngine.getSchedule(catchUpDescription.id);
    const updatedSkip = await secondEngine.getSchedule(skipDescription.id);
    expect(updatedCatchUp?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 4, 0));
    expect(updatedSkip?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 4, 0));

    secondEngine[Symbol.dispose]();
  });

  it('Non-backfill schedules skip a single late missed tick and resume from the next future occurrence.', async () => {
    const storage = new MemoryStorage();
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const executions: Array<string> = [];
    const engine = createEngine(clock, storage);

    registerWorkflow(
      engine,
      'single-missed-tick-workflow',
      async function* (_ctx: WorkflowContext) {
        executions.push('fired');
        return 'fired';
      },
    );

    const schedule = await engine.schedule('single-missed-tick-workflow', null, '* * * * *', {
      id: 'single-missed-tick',
      backfill: false,
    });
    const description = await schedule.describe();

    await tickEngine(engine, clock, Date.UTC(2026, 0, 1, 0, 1, 2));

    expect(executions).toEqual([]);

    const updatedSchedule = await engine.getSchedule(description.id);
    expect(updatedSchedule?.lastFireAt).toBeUndefined();
    expect(updatedSchedule?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 2, 0));

    engine[Symbol.dispose]();
  });

  it('Backfill schedules keep draining missed occurrences when runs immediately start child workflows.', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);
    const childInputs: number[] = [];
    const parentRuns: number[] = [];

    registerWorkflow(
      engine,
      'backfill-child-workflow',
      async function* (_ctx: WorkflowContext, input: number) {
        childInputs.push(input);
        return input;
      },
    );

    registerWorkflow(
      engine,
      'backfill-parent-workflow',
      async function* (ctx: WorkflowContext, input: number) {
        parentRuns.push(input);
        return yield* ctx.startChild<number>('backfill-child-workflow', input);
      },
    );

    await engine.schedule('backfill-parent-workflow', 7, '* * * * * *', {
      backfill: true,
    });

    await tickEngine(engine, clock, Date.UTC(2026, 0, 1, 0, 0, 3));

    expect(parentRuns).toEqual([7, 7, 7]);
    expect(childInputs).toEqual([7, 7, 7]);
    expect(await listRunningWorkflowIds(engine)).toEqual([]);

    engine[Symbol.dispose]();
  });

  it('Backfill direct flushes clear queued-start scheduling before nested child starts queue more work.', async () => {
    const originalMessageChannel = globalThis.MessageChannel;
    const pendingDeliveries: Array<() => void> = [];
    let postMessageCount = 0;

    class ControlledMessageChannel {
      port1 = {
        onmessage: null as ((event: MessageEvent<undefined>) => void) | null,
        close(): void {},
      };

      port2 = {
        postMessage: (_value: undefined): void => {
          postMessageCount += 1;
          pendingDeliveries.push(() => {
            this.port1.onmessage?.(new MessageEvent('message'));
          });
        },
        close(): void {},
      };
    }

    globalThis.MessageChannel = ControlledMessageChannel as unknown as typeof MessageChannel;

    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);

    registerWorkflow(
      engine,
      'controlled-channel-child',
      async function* (_ctx: WorkflowContext, input: number) {
        return input;
      },
    );

    registerWorkflow(
      engine,
      'controlled-channel-parent',
      async function* (ctx: WorkflowContext, input: number) {
        return yield* ctx.startChild<number>('controlled-channel-child', input);
      },
    );

    try {
      await engine.schedule('controlled-channel-parent', 11, '* * * * * *', {
        backfill: true,
      });

      clock.now = Date.UTC(2026, 0, 1, 0, 0, 3);
      const tickPromise = engine.scheduler.tick(clock.now);
      void tickPromise.catch(() => {});
      await waitForCondition(() => postMessageCount >= 1, {
        timeoutMs: 100,
        label: 'initial queued inline workflow start',
      });
      await flushMicrotasks();
      await flushMicrotasks();

      expect(postMessageCount).toBe(2);

      while (pendingDeliveries.length > 0) {
        const deliver = pendingDeliveries.shift();
        deliver?.();
        await flushMicrotasks();
      }
    } finally {
      engine[Symbol.dispose]();
      globalThis.MessageChannel = originalMessageChannel;
    }
  });

  it('Schedule timers still advance when getNow() lags behind the fired timestamp.', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);
    const executions: string[] = [];

    registerWorkflow(
      engine,
      'clock-skew-schedule-workflow',
      async function* (_ctx: WorkflowContext) {
        executions.push('fired');
        return 'fired';
      },
    );

    const schedule = await engine.schedule('clock-skew-schedule-workflow', null, '* * * * *', {
      id: 'clock-skew-schedule',
    });
    const description = await schedule.describe();
    const firstFireAt = requireNextFireAt(description);

    clock.now = firstFireAt - 1_000;
    await engine.scheduler.tick(firstFireAt);
    await drainEngine();

    expect(executions).toEqual(['fired']);

    const updatedSchedule = await schedule.describe();
    expect(updatedSchedule.lastFireAt).toBe(firstFireAt);
    expect(updatedSchedule.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 2, 0));

    engine[Symbol.dispose]();
  });

  it('Caps backfill catch-up work per scheduler tick when many cron occurrences were missed.', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);
    const executions: number[] = [];

    registerWorkflow(engine, 'bounded-backfill-workflow', async function* (_ctx: WorkflowContext) {
      executions.push(clock.now);
      return clock.now;
    });

    const schedule = await engine.schedule('bounded-backfill-workflow', null, '* * * * * *', {
      backfill: true,
    });

    await tickEngine(engine, clock, Date.UTC(2026, 0, 1, 0, 5, 0));

    const firstPassExecutionCount = executions.length;
    expect(firstPassExecutionCount).toBeGreaterThan(0);
    expect(firstPassExecutionCount).toBeLessThan(300);

    const afterFirstPass = await schedule.describe();
    expect(requireNextFireAt(afterFirstPass)).toBeLessThanOrEqual(clock.now);

    await engine.scheduler.tick(clock.now);
    await drainEngine();

    expect(executions.length).toBeGreaterThan(firstPassExecutionCount);

    engine[Symbol.dispose]();
  });

  it('Retains the re-armed schedule timer index until schedule.cancel removes the next tick.', async () => {
    const storage = new MemoryStorage();
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock, storage);
    const executions: string[] = [];

    registerWorkflow(
      engine,
      'cancellable-schedule-workflow',
      async function* (_ctx: WorkflowContext, input: string) {
        executions.push(input);
        return input;
      },
    );

    const schedule = await engine.schedule(
      'cancellable-schedule-workflow',
      'run-once',
      '* * * * *',
      { id: 'cancellable-schedule' },
    );
    const firstDescription = await schedule.describe();

    await tickEngine(engine, clock, requireNextFireAt(firstDescription));

    expect(executions).toEqual(['run-once']);

    const rearmedSchedule = await schedule.describe();
    const nextFireAt = requireNextFireAt(rearmedSchedule);
    const indexKey = 'timer-idx:schedule:cancellable-schedule';

    expect(await storage.get(indexKey)).not.toBeNull();
    expect(await storage.get(KEYS.scheduleTick(nextFireAt, 'cancellable-schedule'))).not.toBeNull();

    await schedule.cancel();

    expect(await storage.get(indexKey)).toBeNull();
    expect(await storage.get(KEYS.scheduleTick(nextFireAt, 'cancellable-schedule'))).toBeNull();

    engine[Symbol.dispose]();
  });

  it('Persists the schedule-run mapping in the same batch that starts a queued schedule workflow.', async () => {
    const storage = new MemoryStorage();
    const recordedBatchKeys: string[][] = [];
    const originalBatch = storage.batch.bind(storage);
    storage.batch = async (operations) => {
      recordedBatchKeys.push(
        operations
          .filter((operation) => operation.type === 'put')
          .map((operation) => operation.key),
      );
      return await originalBatch(operations);
    };

    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock, storage);

    registerWorkflow(
      engine,
      'batched-schedule-run-workflow',
      async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('release');
        return 'released';
      },
    );

    const schedule = await engine.schedule('batched-schedule-run-workflow', null, '* * * * *', {
      id: 'batched-schedule-run',
      overlap: 'queue',
    });
    const description = await schedule.describe();

    await tickEngine(engine, clock, requireNextFireAt(description));

    const startedSchedule = await schedule.describe();
    const currentWorkflowId = startedSchedule.currentWorkflowId;

    expect(currentWorkflowId).toBeDefined();
    expect(recordedBatchKeys).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          KEYS.workflow(currentWorkflowId!),
          KEYS.scheduleRun(currentWorkflowId!),
        ]),
      ]),
    );

    await releaseRunningWorkflows(engine);
    engine[Symbol.dispose]();
  });

  it('Schedules are listable and queryable. engine.listSchedules(filter?) returns next fire time, last fire time, and status.', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);

    registerWorkflow(engine, 'listable-schedule-workflow', async function* () {
      return 'done';
    });

    const activeSchedule = await engine.schedule('listable-schedule-workflow', null, '* * * * *', {
      id: 'active-schedule',
    });
    const pausedSchedule = await engine.schedule(
      'listable-schedule-workflow',
      null,
      '*/15 * * * * *',
      {
        id: 'paused-schedule',
      },
    );

    await pausedSchedule.pause();
    await pausedSchedule.update('*/30 * * * * *');
    await pausedSchedule.resume();
    await pausedSchedule.pause();

    const activeDescription = await activeSchedule.describe();
    await tickEngine(engine, clock, requireNextFireAt(activeDescription));

    const allSchedules = await engine.listSchedules();
    const pausedSchedules = await engine.listSchedules({ status: 'paused' });

    expect(allSchedules.items.map((item) => item.id).toSorted()).toEqual([
      'active-schedule',
      'paused-schedule',
    ]);
    expect(allSchedules.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'active-schedule',
          status: 'active',
          lastFireAt: activeDescription.nextFireAt,
        }),
        expect.objectContaining({
          id: 'paused-schedule',
          status: 'paused',
          cronExpression: '*/30 * * * * *',
        }),
      ]),
    );
    expect(pausedSchedules.items).toEqual([
      expect.objectContaining({
        id: 'paused-schedule',
        status: 'paused',
      }),
    ]);

    await pausedSchedule.cancel();
    expect(await engine.getSchedule('paused-schedule')).toMatchObject({ status: 'cancelled' });

    engine[Symbol.dispose]();
  });

  it('listSchedules sorts deterministically before applying pagination.', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);

    registerWorkflow(engine, 'ordered-schedule-workflow', async function* () {
      return 'done';
    });

    await engine.schedule('ordered-schedule-workflow', null, '* * * * *', {
      id: 'zeta-schedule',
    });
    clock.now += 1;
    await engine.schedule('ordered-schedule-workflow', null, '* * * * *', {
      id: 'alpha-schedule',
    });

    const allSchedules = await engine.listSchedules();
    const firstPage = await engine.listSchedules({ limit: 1 });
    const secondPage = await engine.listSchedules({ limit: 1, offset: 1 });

    expect(allSchedules.items.map((item) => item.id)).toEqual(['zeta-schedule', 'alpha-schedule']);
    expect(firstPage.items.map((item) => item.id)).toEqual(['zeta-schedule']);
    expect(secondPage.items.map((item) => item.id)).toEqual(['alpha-schedule']);

    engine[Symbol.dispose]();
  });

  it('Schedule summaries omit stored workflow input from describe, getSchedule, and listSchedules.', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const engine = createEngine(clock);

    registerWorkflow(engine, 'summary-redaction-workflow', async function* () {
      return 'done';
    });

    const schedule = await engine.schedule(
      'summary-redaction-workflow',
      { secret: 'top-secret' },
      '* * * * *',
      { id: 'redacted-summary' },
    );

    const describedSchedule = await schedule.describe();
    const loadedSchedule = await engine.getSchedule('redacted-summary');
    const listedSchedules = await engine.listSchedules();
    const listedSchedule = listedSchedules.items.find(
      (summary) => summary.id === 'redacted-summary',
    );

    expect(loadedSchedule).not.toBeNull();
    expect(listedSchedule).toBeDefined();

    for (const summary of [describedSchedule, loadedSchedule, listedSchedule]) {
      expect(summary).toBeDefined();
      expect(Object.keys(summary as ScheduleSummary).includes('input')).toBe(false);
    }

    engine[Symbol.dispose]();
  });

  it('Rejects malformed persisted schedules and validates runtime schedule inputs.', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const storage = new MemoryStorage();
    const engine = createEngine(clock, storage);

    registerWorkflow(engine, 'validated-schedule-workflow', async function* () {
      return 'done';
    });

    await storage.put(
      KEYS.schedule('corrupt-schedule'),
      encode({
        id: 'corrupt-schedule',
        workflowType: 'validated-schedule-workflow',
        cronExpression: 42,
      }),
    );
    await storage.put(KEYS.schedule('array-schedule'), encode([]));
    await engine.schedule('validated-schedule-workflow', null, '* * * * *', {
      id: 'missing-next-fire-at',
    });
    const storedScheduleBytes = await storage.get(KEYS.schedule('missing-next-fire-at'));
    expect(storedScheduleBytes).not.toBeNull();

    const storedSchedule = decode(storedScheduleBytes!);
    expect(storedSchedule).toBeObject();
    expect(storedSchedule).not.toBeArray();

    const { nextFireAt: _nextFireAt, ...corruptRuntimeSchedule } = storedSchedule as Record<
      string,
      unknown
    >;
    await storage.put(KEYS.schedule('missing-next-fire-at'), encode(corruptRuntimeSchedule));

    expect(await engine.getSchedule('corrupt-schedule')).toBeNull();
    expect(await engine.getSchedule('array-schedule')).toBeNull();
    expect(await engine.getSchedule('missing-next-fire-at')).toBeNull();
    const listedSchedules = await engine.listSchedules();
    expect(listedSchedules.items).toEqual([]);
    await expect(
      engine.schedule('validated-schedule-workflow', null, '* * * * *', {
        overlap: 'bogus' as unknown as never,
      }),
    ).rejects.toThrow('options.overlap');
    await expect(engine.getSchedule('')).rejects.toThrow('scheduleId');

    engine[Symbol.dispose]();
  });

  it('Pausing a schedule after a timer failure reuses one error timestamp for updatedAt and nextFireAt.', async () => {
    const storage = new ScheduleRunStartFailureStorage();
    let stableNow = Date.UTC(2026, 0, 1, 0, 0, 0);
    let errorNow = stableNow;
    const engine = new Engine({
      storage,
      getNow: () => {
        if (!storage.queuedScheduleRunStartFailed) {
          return stableNow;
        }

        return errorNow++;
      },
    });
    const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

    registerWorkflow(engine, 'pause-on-start-failure-workflow', async function* () {
      return 'done';
    });

    const schedule = await engine.schedule('pause-on-start-failure-workflow', null, '* * * * * *', {
      id: 'pause-on-start-failure',
    });
    const description = await schedule.describe();

    storage.failQueuedScheduleRunStart = true;
    stableNow = requireNextFireAt(description) + 995;
    errorNow = stableNow;
    await engine.scheduler.tick(requireNextFireAt(description));
    await drainEngine();

    const pausedSchedule = await schedule.describe();
    expect(pausedSchedule.status).toBe('paused');
    expect(pausedSchedule.updatedAt).toBe(stableNow);
    expect(pausedSchedule.nextFireAt).toBe(
      getNextCronOccurrence(pausedSchedule.cronExpression, pausedSchedule.updatedAt),
    );

    consoleErrorSpy.mockRestore();
    engine[Symbol.dispose]();
  });

  it('Tests cover: cron edge cases (Feb 29) by scheduling the next leap-day fire time correctly.', () => {
    const nextFireAt = getNextCronOccurrence('0 0 29 2 *', Date.UTC(2025, 1, 28, 0, 0, 0), {
      timeZone: 'UTC',
    });

    expect(nextFireAt).toBe(Date.UTC(2028, 1, 29, 0, 0, 0));
  });

  it('Cron scheduling defaults to UTC so persisted schedules do not drift with the host time zone.', () => {
    const nextFireAt = getNextCronOccurrence('0 0 * * * *', Date.UTC(2026, 0, 1, 12, 34, 56));

    expect(nextFireAt).toBe(Date.UTC(2026, 0, 1, 13, 0, 0));
  });

  it('Tests cover: cron edge cases (DST transitions) by skipping nonexistent spring-forward wall-clock times.', () => {
    const nextFireAt = getNextCronOccurrence(
      '0 30 2 * * *',
      Date.parse('2026-03-08T06:00:00.000Z'),
      { timeZone: 'America/New_York' },
    );

    expect(nextFireAt).toBe(Date.parse('2026-03-09T06:30:00.000Z'));
  });

  it('Tests cover: cron edge cases (DST transitions) by emitting both repeated fall-back wall-clock times.', () => {
    const nextFireAt = getNextCronOccurrence(
      '0 30 1 * * *',
      Date.parse('2026-11-01T05:30:00.000Z'),
      { timeZone: 'America/New_York' },
    );

    expect(nextFireAt).toBe(Date.parse('2026-11-01T06:30:00.000Z'));
  });
});
