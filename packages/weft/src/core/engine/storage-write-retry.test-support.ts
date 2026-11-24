/**
 * What the COR-1626 retry tests share: two small workflows that park on a signal, and a run
 * started over a {@link RefusingStorage} and parked, so the refusals begin after the run has
 * started and what is refused is the write a step makes.
 */
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { decode } from '../codec/api.ts';
import { Engine, ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING } from '../engine.ts';
import { workflow, type WorkflowContext, type WorkflowState } from '../types.ts';
import { getInternals } from './internals.ts';
import {
  createRefusingStorage,
  type RefusingStorage,
} from './storage-write-refusal.test-support.ts';

/** The waits the tests use between attempts: none, so the attempts follow each other at once. */
export const NO_WAIT = [0, 0, 0, 0];

/** The attempts a refused write makes with {@link NO_WAIT}: the first and four retries. */
export const ATTEMPTS = NO_WAIT.length + 1;

/** Parks on `go`, then takes two checkpointed steps and returns `<signal>:a:b`. */
export const steps = workflow({ name: 'retry-steps' }).execute(async function* (
  ctx: WorkflowContext,
) {
  const go = yield* ctx.waitForSignal<string>('go');
  const first = yield* ctx.run(() => 'a');
  const second = yield* ctx.run(() => 'b');
  return [go, first, second].join(':');
});

/** Parks on `go`, then fails with `the workflow body failed`. */
export const failsAfterSignal = workflow({ name: 'retry-fails' }).execute(async function* (
  ctx: WorkflowContext,
) {
  yield* ctx.waitForSignal<string>('go');
  throw new Error('the workflow body failed');
});

/** A run parked on its signal, over a storage that has not started refusing yet. */
export type Run = {
  readonly engine: Engine;
  readonly refusing: RefusingStorage;
  readonly workflowId: string;
  /** The run's `result()`, with its rejection already observed. */
  readonly result: Promise<unknown>;
};

/**
 * Start `definition` over a refusing storage, park it on its signal, then arm the storage. Under
 * an ownership mode the engine holds the lease or the run's claim, so every write carries the epoch fence.
 */
export async function startParked(
  definition: typeof steps | typeof failsAfterSignal,
  workflowId: string,
  options: {
    readonly delays?: readonly number[];
    readonly ownership?: 'lease' | 'workflow-lease';
  } = {},
): Promise<Run> {
  const { observed, ...run } = await openParked(definition, workflowId, options, true);
  return { ...run, result: observed! };
}

/**
 * {@link startParked} without asking for the run's result, for a test whose first `result()` is
 * asked for later, while the engine is already ending the run.
 */
export async function startParkedUnobserved(
  definition: typeof steps | typeof failsAfterSignal,
  workflowId: string,
  options: { readonly ownership?: 'lease' | 'workflow-lease' } = {},
): Promise<Omit<Run, 'result'>> {
  const { observed: _none, ...run } = await openParked(definition, workflowId, options, false);
  return run;
}

async function openParked(
  definition: typeof steps | typeof failsAfterSignal,
  workflowId: string,
  options: {
    readonly delays?: readonly number[];
    readonly ownership?: 'lease' | 'workflow-lease';
  },
  observe: boolean,
): Promise<Omit<Run, 'result'> & { readonly observed: Promise<unknown> | undefined }> {
  const refusing = createRefusingStorage(new MemoryStorage());
  const engine: Engine =
    options.ownership !== undefined
      ? ((await Engine.create({
          storage: refusing.storage,
          workflows: { [definition.name]: definition } as { 'retry-steps': typeof steps },
          ownership: options.ownership,
        })) as unknown as Engine)
      : new Engine({ storage: refusing.storage });
  if (options.ownership === undefined) engine.register(definition as typeof steps);
  getInternals(engine).storageWriteRetryDelaysForTesting = options.delays ?? NO_WAIT;
  const handle = await engine.start(definition.name, null, { id: workflowId });
  const observed = observe ? handle.result() : undefined;
  void observed?.catch(() => {});
  await engine[ENGINE_WAIT_FOR_SIGNAL_WAITER_FOR_TESTING](workflowId);
  refusing.arm();
  return { engine, refusing, workflowId, observed };
}

/** The workflow record `workflowId` holds in the real store, decoded. */
export async function readState(
  refusing: RefusingStorage,
  workflowId: string,
): Promise<WorkflowState> {
  return decode((await refusing.base.get(KEYS.workflow(workflowId)))!) as WorkflowState;
}

/** The status of the workflow record `workflowId` holds in the real store. */
export async function statusOf(refusing: RefusingStorage, workflowId: string): Promise<string> {
  const state = await readState(refusing, workflowId);
  return state.status;
}
