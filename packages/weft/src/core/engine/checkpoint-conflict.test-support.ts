/**
 * Fixtures shared by the checkpoint-conflict test files: storage wrappers that record the
 * writes an engine attempts, a collector for the operator warning, and helpers that drive a
 * run into a lost checkpoint compare-and-swap, hold a terminal failure in flight, and tell a
 * `result()` that rejected from one that is still pending.
 */
import { afterEach, beforeEach, spyOn } from 'bun:test';

import { KEYS, type BatchOperation, type Storage } from '../../storage/interface.ts';
import {
  createDeferred,
  waitForCondition,
  yieldToEventLoop,
} from '../../testing/fake-timers.test-support.ts';
import { rejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { decode } from '../codec/api.ts';
import { workflow, type WorkflowContext, type WorkflowState } from '../types.ts';
import { abandonWorkflowAfterCheckpointConflict } from './checkpoint-conflict-abandon.ts';
import {
  WeftWorkflowCheckpointConflictWarning,
  WorkflowCheckpointConflictError,
} from './checkpoint-conflict-error.ts';
import type { Engine } from './index.ts';
import { getInternals, type EngineInternals } from './internals.ts';

export const WRITE_METHODS = ['put', 'delete', 'deletePrefix', 'batch', 'conditionalBatch'];

export function writeOperations(
  name: string,
  argumentsList: readonly unknown[],
): readonly BatchOperation[] | null {
  if (name === 'batch') return argumentsList[0] as BatchOperation[];
  if (name === 'conditionalBatch') return argumentsList[1] as BatchOperation[];
  return null;
}

/** Wrap `base` so every write the engine attempts is recorded by method name. */
export function recordWrites(base: Storage) {
  const writes: string[] = [];
  const storage = new Proxy(base, {
    get(target, property) {
      const original: unknown = Reflect.get(target, property, target);
      if (typeof original !== 'function') return original;
      if (WRITE_METHODS.includes(String(property))) {
        return (...argumentsList: unknown[]) => {
          writes.push(String(property));
          return original.apply(target, argumentsList);
        };
      }
      return original.bind(target);
    },
  });
  return { storage, writes };
}

type ConflictWarningListener = (warning: WeftWorkflowCheckpointConflictWarning) => void;

const conflictWarningListeners = new Set<ConflictWarningListener>();
let activeInterceptions = 0;

/**
 * Take the conflict warnings `target.emitWarning` is given, for as long as the returned function
 * has not been called, and hand each to the collectors opened with {@link collectConflictWarnings}
 * instead of letting Node print it. Every other warning still reaches the real `emitWarning`.
 */
export function interceptConflictWarningsOn(
  target: Pick<NodeJS.Process, 'emitWarning'>,
): () => void {
  const passThrough = target.emitWarning.bind(target) as (...argumentsList: unknown[]) => void;
  const interception = spyOn(target, 'emitWarning').mockImplementation(
    (warning: string | Error, ...rest: unknown[]) => {
      if (!(warning instanceof WeftWorkflowCheckpointConflictWarning)) {
        passThrough(warning, ...rest);
        return;
      }
      for (const listener of conflictWarningListeners) listener(warning);
    },
  );
  activeInterceptions += 1;
  return () => {
    interception.mockRestore();
    activeInterceptions -= 1;
  };
}

/**
 * Keep the operator warning off stderr for every test of the file that calls this at its top
 * level, and hand each one to the collectors the test opened with {@link collectConflictWarnings}.
 *
 * The engine emits the warning through `process.emitWarning` when it loses a checkpoint
 * compare-and-swap race, which is the signal an operator is meant to see. A test that forces a
 * loss on purpose has to assert it and not print it, so the warning is taken at the call, before
 * Node would print it. The hooks are registered by the file that calls this, because a hook
 * registered at this module's scope would bind to the first file that imported it.
 */
export function interceptConflictWarnings(): void {
  let restore: (() => void) | undefined;
  beforeEach(() => {
    restore = interceptConflictWarningsOn(process);
  });
  afterEach(() => {
    restore?.();
    restore = undefined;
  });
}

/**
 * Collect the conflict warnings the engine emits while the collector is open. `received` resolves
 * once `expected` of them have arrived. The calling file must have called
 * {@link interceptConflictWarnings}, which is what delivers them.
 */
export function collectConflictWarnings(expected = 1) {
  if (activeInterceptions === 0) {
    throw new Error('call interceptConflictWarnings() at the top level of the test file first');
  }
  const warnings: WeftWorkflowCheckpointConflictWarning[] = [];
  const reached = createDeferred();
  const listener: ConflictWarningListener = (warning) => {
    warnings.push(warning);
    if (warnings.length >= expected) reached.resolve();
  };
  conflictWarningListeners.add(listener);
  return {
    warnings,
    received: reached.promise,
    stop: () => conflictWarningListeners.delete(listener),
  };
}

export async function readStatus(
  base: Storage,
  workflowId: string,
): Promise<WorkflowState['status']> {
  return (decode((await base.get(KEYS.workflow(workflowId)))!) as WorkflowState).status;
}

export function tokenOf(internals: EngineInternals, workflowId: string): string | undefined {
  return internals.checkpoints.get(workflowId)?.workflowExecutionToken;
}

/** Report the loss of whichever generation the engine currently holds for the workflow. */
export function loseGeneration(internals: EngineInternals, workflowId: string): void {
  abandonWorkflowAfterCheckpointConflict(
    internals,
    new WorkflowCheckpointConflictError(workflowId, {
      workflowExecutionToken: tokenOf(internals, workflowId),
    }),
  );
}

/**
 * The rejection reason of `promise`, or `'pending'` when it has not settled after one
 * event-loop turn. Lets a regression test fail on a result() that hangs without
 * waiting out the test timeout.
 */
export async function rejectionOrPending(promise: Promise<unknown>): Promise<unknown> {
  return await Promise.race([
    rejectionOf(promise),
    yieldToEventLoop().then(() => 'pending' as const),
  ]);
}

export const parkedOnSignal = (name: string) =>
  workflow({ name }).execute(async function* (context: WorkflowContext) {
    return yield* context.waitForSignal<string>('go');
  });

export async function startParked(engine: Engine, name: string, id: string) {
  engine.register(parkedOnSignal(name));
  const handle = await engine.start(name, null, { id });
  await waitForCondition(() => getInternals(engine).parkedInlineWorkflows.has(id), {
    label: `${id} parked on its signal`,
  });
  return handle;
}

export const noCallbacks = new Proxy({}, { get: () => () => {} }) as never;

/**
 * Hold the next `failWorkflow` for `workflowId` at its first storage read, as an interleaving
 * turn would, and record the writes the engine attempts from then on.
 */
export function holdFailureAtItsFirstRead(
  internals: EngineInternals,
  base: Storage,
  workflowId: string,
) {
  const reachedRead = createDeferred();
  const releaseRead = createDeferred();
  const watched = recordWrites(base);
  let held = false;
  internals.storage = new Proxy(watched.storage, {
    get(target, property) {
      const original: unknown = Reflect.get(target, property, target);
      if (typeof original !== 'function') return original;
      if (property === 'get') {
        return async (key: string) => {
          if (key === KEYS.attribute(workflowId) && !held) {
            held = true;
            reachedRead.resolve();
            await releaseRead.promise;
          }
          return original.call(target, key);
        };
      }
      return original.bind(target);
    },
  });
  return {
    reached: reachedRead.promise,
    release: () => releaseRead.resolve(),
    writes: watched.writes,
  };
}
