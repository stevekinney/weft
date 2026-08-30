import { MemoryStorage } from '../../storage/memory.ts';
import { yieldToEventLoop } from '../../testing/fake-timers.test-support.ts';
import { Engine } from '../engine.ts';
import {
  workflow as defineWorkflow,
  type ScheduleSummary,
  type WorkflowFunction,
} from '../types.ts';

// Shared test-only harness for the schedule suites (interval schedules and the
// schedule:fired event), which previously carried identical copies. Excluded
// from the production build by the `.test-support.ts` suffix.

export type Clock = { now: number };

export const MINUTE = 60_000;
export const START = Date.UTC(2026, 0, 1, 0, 0, 0);

export function createEngine(clock: Clock, storage = new MemoryStorage()): Engine {
  return new Engine({ storage, getNow: () => clock.now });
}

export function registerWorkflow<TInput, TOutput>(
  engine: Engine,
  name: string,
  handler: WorkflowFunction<TInput, TOutput>,
): void {
  const definition = defineWorkflow({ name }).execute(handler as WorkflowFunction);
  (engine.register as (workflow: typeof definition) => unknown)(definition);
}

// Yield to the event loop twice so a tick's synchronous launch and its follow-on
// microtasks both settle before the test asserts.
export async function drainEngine(): Promise<void> {
  await yieldToEventLoop();
  await yieldToEventLoop();
}

export function requireNextFireAt(summary: ScheduleSummary): number {
  if (summary.nextFireAt === null) {
    throw new Error(`Schedule "${summary.id}" does not have a next fire time`);
  }
  return summary.nextFireAt;
}

export async function tickEngine(engine: Engine, clock: Clock, nextNow: number): Promise<void> {
  clock.now = nextNow;
  await engine.scheduler.tick(clock.now);
  await drainEngine();
}

export async function tickToNextFire(
  engine: Engine,
  clock: Clock,
  handle: { describe(): Promise<ScheduleSummary | null> },
): Promise<void> {
  const summary = await handle.describe();
  if (summary === null) {
    throw new Error('Schedule no longer exists');
  }
  await tickEngine(engine, clock, requireNextFireAt(summary));
}

export async function listRunningWorkflowIds(engine: Engine): Promise<string[]> {
  const result = await engine.list({ status: 'running' });
  return result.items.map((item) => item.id).toSorted();
}

export async function releaseRunningWorkflows(engine: Engine): Promise<void> {
  for (const workflowId of await listRunningWorkflowIds(engine)) {
    await engine.signal(workflowId, 'release');
  }
  await drainEngine();
}
