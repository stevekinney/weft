/**
 * Shared fixtures for the COR-1597 suites: a held top-level activity, a storage that holds one
 * write, and observers that read a promise's state without awaiting it.
 */
import { type BatchOperation, type Storage, MemoryStorage } from "../../embedded/storage/src/index.ts";
import { createDeferred, yieldToEventLoop } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import type { ActivityContext, WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';
import type { Engine } from './index.ts';

export type Observed = {
  state: 'pending' | 'resolved' | 'rejected';
  reason: unknown;
  settled: Promise<void>;
};

/** Watch a promise without awaiting it: its state and reason are read when the test asks. */
export function observe(promise: Promise<unknown>): Observed {
  const observed: Observed = { state: 'pending', reason: undefined, settled: Promise.resolve() };
  observed.settled = promise.then(
    () => {
      observed.state = 'resolved';
    },
    (reason: unknown) => {
      observed.state = 'rejected';
      observed.reason = reason;
    },
  );
  return observed;
}

export async function statusOf(engine: Engine, id: string): Promise<string | undefined> {
  const state = await engine.get(id);
  return state?.status;
}

/** Yield `count` real event-loop turns (a timer each), not microtasks. */
export async function macrotasks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await yieldToEventLoop();
}

let invocation = 0;
export const nextId = (label: string): string => `terminal-in-flight-${label}-${(invocation += 1)}`;

/** A held top-level activity: it records that it ran, then waits for the test to release it. */
export function heldActivity(options: { readonly afterQuickActivity?: boolean } = {}) {
  const started = createDeferred();
  const gate = createDeferred();
  const record = { ran: 0, completed: 0, signalAbortedInside: undefined as boolean | undefined };
  const held = activity({
    name: 'held',
    execute: async (_input?: unknown, context?: ActivityContext) => {
      record.ran += 1;
      started.resolve();
      await gate.promise;
      record.signalAbortedInside = context?.signal.aborted;
      record.completed += 1;
      return 'held-done';
    },
  });
  const quick = activity({ name: 'quick', execute: async () => 'quick-done' });
  const heldWorkflow = workflow({ name: 'held-workflow' })
    .activities({ quick, held })
    .execute(async function* (ctx: WorkflowContext) {
      if (options.afterQuickActivity) yield* ctx.run(quick);
      return yield* ctx.run(held);
    });
  return { held, heldWorkflow, started, gate, record };
}

/**
 * A memory storage that holds the first write touching `id` after the test arms it, until the test releases it. Reads and every later write pass through.
 */
export function holdingStorage(id: string) {
  const memory = new MemoryStorage();
  let armed = false;
  let releaseHeld: (() => void) | undefined;
  const heldKeys: string[] = [];
  const held = createDeferred();
  const keysOf = (operations: BatchOperation[]) => operations.map((operation) => operation.key);
  const maybeHold = async (keys: string[]) => {
    if (armed && keys.some((key) => key.includes(id))) {
      armed = false;
      heldKeys.push(...keys);
      held.resolve();
      await new Promise<void>((resolve) => (releaseHeld = resolve));
    }
  };
  const proxy = new Proxy(memory, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof member !== 'function') return member;
      const name = String(property);
      const call = (...args: unknown[]) =>
        (member as (...rest: unknown[]) => unknown).apply(target, args);
      if (name === 'batch') {
        return async (operations: BatchOperation[]) => {
          await maybeHold(keysOf(operations));
          return call(operations);
        };
      }
      if (name === 'conditionalBatch') {
        return async (conditions: unknown, operations: BatchOperation[]) => {
          await maybeHold(keysOf(operations));
          return call(conditions, operations);
        };
      }
      return call.bind(null);
    },
  });
  return {
    storage: proxy as unknown as Storage,
    arm: () => {
      armed = true;
    },
    held: held.promise,
    heldKeys,
    release: () => releaseHeld?.(),
  };
}
