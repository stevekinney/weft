import type { WorkflowState } from '../types.ts';
import type { ExecutionAttempt } from './execution-attempts.ts';
import { currentExecutionAttempt } from './execution-attempts.ts';
import { workflowNotFoundInStorageError } from './handle-result.ts';
import type { EngineInternals } from './internals.ts';
import { deriveWorkflowResultFromState, loadWorkflowState } from './storage-io.ts';
import { isTerminalWorkflowStatus } from './validation.ts';

/**
 * A parent's view of a child this engine lost to a checkpoint race (COR-1426).
 *
 * The child's result waiter was rejected with the conflict: the winning engine owns the child, so
 * nothing on this engine will ever settle the parent's view of it. The child is healthy, though,
 * and its outcome becomes durable on the winner. So the parent keeps waiting and observes that
 * durable terminal state, polled at `workflowClaimRenewIntervalMs` (the interval of the existing
 * cross-engine result poll, which only runs under `workflow-lease`, where this conflict cannot
 * occur). It reads only, never writes, and never fails the parent for the child's loss. A child
 * that fails, is cancelled, or times out on the winner fails the parent with that outcome, exactly
 * as an awaited child's terminal state would.
 *
 * Unbounded on purpose: if the winner never finishes the child, the parent stays parked, which is
 * what it did before. The poll stops, writing nothing, as soon as the parent no longer awaits:
 * its race branch lost (aborted signal), the parent was relaunched or
 * replaced (the captured attempt is no longer current, which is also what disposal does, since it
 * retires every attempt), suspended (its checkpoint was released),
 * is terminalizing or terminal, or this engine lost its claim (`confirmParentStillOwned`).
 * `engine.resume(parent)` begins a new attempt that replays `startChild()`, which starts a fresh
 * poll; the old one stops.
 *
 * `backgroundTasks: 'manual'` starts no timer: `runMaintenance()` drives {@link pollChildOutcomes}.
 */
export type ChildOutcomeWatch = {
  readonly parentWorkflowId: string;
  readonly childWorkflowId: string;
  /**
   * The execution token of the child generation this engine lost, which the winner's resume keeps
   * (resume reuses the persisted token; only a new run, such as `onTerminalConflict: 'start-new'`,
   * mints one). A durable state carrying another token is a replacement, not the awaited child.
   */
  readonly childWorkflowExecutionToken: string | undefined;
  /** The attempt the parent held when it began awaiting, captured before any await. */
  readonly parentAttempt: ExecutionAttempt | undefined;
  /** Aborted when a `ctx.race` branch awaiting the child loses. */
  readonly signal: AbortSignal | undefined;
  /** The existing parent-claim fence; `false` means this engine no longer owns the parent. */
  readonly confirmParentStillOwned: () => Promise<boolean>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
};

type Poller = {
  tick(): Promise<void>;
  /** Tear down at engine disposal: stop, cancel the timer, and drop the parent's resolvers. */
  dispose(): void;
};

const pollersByEngine = new WeakMap<EngineInternals, Set<Poller>>();

/** The parent no longer awaits the child, so this view has nothing left to settle. */
function parentNoLongerAwaits(internals: EngineInternals, watch: ChildOutcomeWatch): boolean {
  const { parentWorkflowId, parentAttempt } = watch;
  const current = currentExecutionAttempt(internals, parentWorkflowId);
  return (
    watch.signal?.aborted === true ||
    parentAttempt === undefined ||
    current !== parentAttempt ||
    current.abandoned ||
    !internals.checkpoints.has(parentWorkflowId) ||
    internals.terminalizingWorkflows.has(parentWorkflowId)
  );
}

type ChildRead =
  { readonly kind: 'unreadable' } | { readonly kind: 'read'; state: WorkflowState | null };

async function readChild(internals: EngineInternals, childWorkflowId: string): Promise<ChildRead> {
  try {
    return { kind: 'read', state: await loadWorkflowState(internals, childWorkflowId) };
  } catch {
    // An unreadable child is not a verdict on it: keep waiting and read again.
    return { kind: 'unreadable' };
  }
}

/** The parent's outcome for what the child's durable state says, or `undefined` to keep waiting. */
function outcomeFromRead(
  watch: ChildOutcomeWatch,
  read: ChildRead,
): { readonly settle: () => void } | undefined {
  if (read.kind === 'unreadable') return undefined;
  const { state } = read;
  if (state === null || state.workflowExecutionToken !== watch.childWorkflowExecutionToken) {
    // A child this engine started and that is gone now (purged, swept, or replaced by a new run
    // under the same id) reads like any result() for a workflow not in storage, and waiting for the
    // awaited generation can never end. The replacement's outcome is not this parent's to observe.
    return { settle: () => watch.reject(workflowNotFoundInStorageError(watch.childWorkflowId)) };
  }
  if (!isTerminalWorkflowStatus(state.status)) return undefined;
  return {
    settle: () => {
      try {
        watch.resolve(deriveWorkflowResultFromState(state));
      } catch (outcome) {
        // The persisted failure, cancellation, or timeout of the child is the parent's outcome too.
        watch.reject(outcome);
      }
    },
  };
}

export function watchChildDurableOutcome(
  internals: EngineInternals,
  initialWatch: ChildOutcomeWatch,
): void {
  let pollers = pollersByEngine.get(internals);
  if (pollers === undefined) {
    pollers = new Set();
    pollersByEngine.set(internals, pollers);
  }
  const registry = pollers;
  // Dropped at `finish`, so a finished or disposed poll holds nothing of the parent's.
  let live: ChildOutcomeWatch | undefined = initialWatch;
  let inFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = (): void => {
    live = undefined;
    registry.delete(poller);
    if (timer !== undefined) {
      clearTimeout(timer);
      internals.pendingResultPollTimers.delete(timer);
      timer = undefined;
    }
  };

  const observe = async (): Promise<void> => {
    if (live === undefined || parentNoLongerAwaits(internals, live)) return finish();
    const read = await readChild(internals, live.childWorkflowId);
    if (live === undefined || parentNoLongerAwaits(internals, live)) return finish();
    const outcome = outcomeFromRead(live, read);
    if (outcome === undefined) return;
    const owned = await live.confirmParentStillOwned();
    if (live === undefined || !owned || parentNoLongerAwaits(internals, live)) return finish();
    finish();
    outcome.settle();
  };

  // One read at a time; a caller that arrives during it awaits that read.
  const tick = (): Promise<void> => {
    inFlight ??= observe().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
  const poller: Poller = { tick, dispose: finish };
  registry.add(poller);

  const scheduleNext = (): void => {
    if (live === undefined || internals.options.backgroundTaskMode !== 'automatic') return;
    const handle = setTimeout(() => {
      internals.pendingResultPollTimers.delete(handle);
      void tick().then(scheduleNext);
    }, internals.options.workflowClaimRenewIntervalMs);
    // Tracked so disposal cancels it; never holds an otherwise-idle process open.
    internals.pendingResultPollTimers.add(handle);
    (handle as { unref?: () => void }).unref?.();
    timer = handle;
  };
  void tick().then(scheduleNext);
}

/** Drive every pending parent view once; `runMaintenance()` calls this where no timer runs. */
export async function pollChildOutcomes(internals: EngineInternals): Promise<void> {
  const pollers = pollersByEngine.get(internals);
  if (pollers === undefined) return;
  for (const poller of Array.from(pollers)) await poller.tick();
}

/** Engine disposal: tear down every pending parent view rather than rely on cancelled timers. */
export function disposeChildOutcomePolls(internals: EngineInternals): void {
  const pollers = pollersByEngine.get(internals);
  if (pollers === undefined) return;
  for (const poller of Array.from(pollers)) poller.dispose();
  pollersByEngine.delete(internals);
}

/** How many parent views are being polled (diagnostics and tests). */
export function pendingChildOutcomePollCount(internals: EngineInternals): number {
  return pollersByEngine.get(internals)?.size ?? 0;
}
