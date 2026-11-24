/**
 * `EngineOptions.runConcurrency`: the cap on counted top-level runs this engine executes at once.
 *
 * A counted run takes a slot when its execution begins in this process: a fresh start's first
 * turn, a resume, a recovery, or a launch from a checkpoint. It gives the slot back when it ends,
 * is suspended, or is purged, and a run whose workflow claim this engine no longer holds stops
 * counting. Only a fresh start is ever held: the inline launch queue keeps a counted start queued
 * while every slot is taken, and launches the oldest one when a slot is given back. A run resumed
 * from storage was already executing before, so it takes a slot even past the cap.
 *
 * The module holds no engine reference and imports nothing at runtime, so termination cleanup can
 * give a slot back without reaching the launch queue: the queue hands over the flush it wants when
 * it holds a start back ({@link requeueStartsHeldForRunSlots}).
 *
 * @module core/engine/run-concurrency
 */

import type { WorkflowState } from '../types.ts';
import type { RunConcurrencySnapshot } from '../types/engine-run-concurrency-options.ts';
import type {
  EngineConstructorOptions,
  QueuedInlineWorkflowExecutionStart,
  ResolvedRunConcurrency,
} from './engine-internal-types.ts';
import type { EngineInternals } from './internals.ts';

function checkedMax(max: unknown): number {
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max <= 0) {
    throw new Error('options.runConcurrency.max must be a positive safe integer');
  }
  return max;
}

function checkedCounts(counts: unknown): (workflowType: string) => boolean {
  if (counts === undefined) return () => true;
  if (typeof counts !== 'function') {
    throw new Error('options.runConcurrency.counts must be a function when provided');
  }
  return counts as (workflowType: string) => boolean;
}

/**
 * `EngineOptions.runConcurrency`, checked: a positive safe integer cap and an optional `counts`
 * function. Only the inline strategy holds a start back, so `worker` and `realm` mode refuse it.
 */
export function resolveRunConcurrency(
  options: EngineConstructorOptions | undefined,
): ResolvedRunConcurrency | null {
  const runConcurrency: unknown = options?.runConcurrency;
  if (runConcurrency === undefined) return null;
  if (typeof runConcurrency !== 'object' || runConcurrency === null) {
    throw new Error('options.runConcurrency must be an object when provided');
  }
  const mode = options?.workflowExecutionMode;
  if (mode !== undefined && mode !== 'inline') {
    throw new Error(
      `options.runConcurrency is only supported in inline execution mode, not "${mode}"`,
    );
  }
  const { max, counts } = runConcurrency as { max?: unknown; counts?: unknown };
  return { max: checkedMax(max), counts: checkedCounts(counts) };
}

type RunSlots = {
  /** The counted runs executing now, in the order they took a slot. */
  readonly running: Set<string>;
  /** Called after a slot is given back, so the launch queue can launch a waiting start. */
  wake: (() => void) | undefined;
};

const slotsByEngine = new WeakMap<EngineInternals, RunSlots>();

function slotsOf(internals: EngineInternals): RunSlots {
  let slots = slotsByEngine.get(internals);
  if (slots === undefined) {
    slots = { running: new Set(), wake: undefined };
    slotsByEngine.set(internals, slots);
  }
  return slots;
}

function policyOf(internals: EngineInternals): ResolvedRunConcurrency | null {
  return internals.options.runConcurrency ?? null;
}

/** Whether a run of `workflowType` counts toward the cap: the engine has one, the run is top-level, and `counts` says so. */
export function countsTowardRunConcurrency(
  internals: EngineInternals,
  workflowType: string,
  topLevel: boolean,
): boolean {
  const policy = policyOf(internals);
  return policy !== null && topLevel && policy.counts(workflowType);
}

/** Records that a run's execution began in this process. A run that does not count is ignored. */
export function takeRunSlot(
  internals: EngineInternals,
  workflowId: string,
  workflowType: string,
  topLevel: boolean,
): void {
  if (!countsTowardRunConcurrency(internals, workflowType, topLevel)) return;
  slotsOf(internals).running.add(workflowId);
}

/**
 * Caches a resumed run's type and revision for the dispatch hot path (WFT-19) and takes its slot:
 * it was executing before, so it is never held, even past the cap.
 */
export function recordResumedRunIdentity(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  revision: string | undefined,
): void {
  internals.workflowTypeByWorkflowId.set(workflowId, { type: state.type, revision });
  takeRunSlot(internals, workflowId, state.type, state.parentWorkflowId === undefined);
}

/**
 * The counted runs still executing here. A run whose type entry terminal cleanup removed, or whose
 * workflow claim this engine no longer holds, is dropped first: another engine drives it now.
 */
function runningRuns(internals: EngineInternals): Set<string> {
  const { running } = slotsOf(internals);
  const registry = internals.workflowClaimRegistry;
  for (const workflowId of running) {
    const lost = registry !== null && registry.currentEpoch(workflowId) === null;
    if (lost || !internals.workflowTypeByWorkflowId.has(workflowId)) running.delete(workflowId);
  }
  return running;
}

/** Whether a counted start may begin now: the engine has no cap, or a slot is free. */
export function hasFreeRunSlot(internals: EngineInternals): boolean {
  const policy = policyOf(internals);
  return policy === null || runningRuns(internals).size < policy.max;
}

/**
 * Gives back `workflowId`'s slot, when it holds one, and wakes the launch queue so the oldest
 * waiting start can take it. Safe to call for any run, counted or not.
 */
export function releaseRunSlot(internals: EngineInternals, workflowId: string): void {
  const slots = slotsByEngine.get(internals);
  if (slots === undefined || !slots.running.delete(workflowId)) return;
  slots.wake?.();
}

function countsStart(
  internals: EngineInternals,
  start: QueuedInlineWorkflowExecutionStart,
): boolean {
  return countsTowardRunConcurrency(internals, start.workflowType, start.nestingDepth === 0);
}

/**
 * Whether a flush holds `start` back: it counts, and either every slot is taken or an older
 * counted start of the same flush is already held, so a slot freed mid-flush goes to the oldest.
 */
export function holdsForRunSlot(
  internals: EngineInternals,
  start: QueuedInlineWorkflowExecutionStart,
  heldSoFar: number,
): boolean {
  return countsStart(internals, start) && (heldSoFar > 0 || !hasFreeRunSlot(internals));
}

/**
 * Whether flushing the queue now would launch a start. A start held for a slot stays queued until
 * one is given back, so a drain stops when only held starts remain: disposal discards them with
 * their runs still `running` in storage, and recovery resumes those.
 */
export function queueHasLaunchableStart(internals: EngineInternals): boolean {
  return internals.queuedInlineWorkflowStarts.some(
    (start) => !holdsForRunSlot(internals, start, 0),
  );
}

/**
 * Puts the starts a flush held back at the front of the queue, oldest first, ahead of any start
 * queued while the flush ran, and has the next freed slot call `scheduleFlush`. A slot given back
 * while the flush ran found nothing to wake, so that case calls it here.
 */
export function requeueStartsHeldForRunSlots(
  internals: EngineInternals,
  held: readonly QueuedInlineWorkflowExecutionStart[],
  scheduleFlush: () => void,
): void {
  if (held.length === 0) return;
  internals.queuedInlineWorkflowStarts = [...held, ...internals.queuedInlineWorkflowStarts];
  slotsOf(internals).wake = scheduleFlush;
  if (hasFreeRunSlot(internals)) scheduleFlush();
}

/** Forgets every slot, for engine disposal. */
export function clearRunSlots(internals: EngineInternals): void {
  slotsByEngine.delete(internals);
}

/**
 * The cap, the counted runs executing, and the counted starts waiting in the launch queue, or
 * `null` when the engine has no cap.
 */
export function runConcurrencySnapshot(internals: EngineInternals): RunConcurrencySnapshot | null {
  const policy = policyOf(internals);
  if (policy === null) return null;
  const waiting = internals.queuedInlineWorkflowStarts
    .filter((start) => countsStart(internals, start))
    .map((start) => start.workflowId);
  return { max: policy.max, running: [...runningRuns(internals)], waiting };
}
