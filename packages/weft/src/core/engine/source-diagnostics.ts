/**
 * Bounded per-`(name, revision)` load-state diagnostics for dynamic
 * workflow sources (WFT-15/16): the `idle -> loading -> ready|failed`
 * state machine, waiter-count bookkeeping, and the `loading -> cancelled`
 * transition. The `record*`/`begin*`/`end*` functions are pure state
 * mutation, individually unit-testable; the `*AndDispatch` wrappers pair
 * each with the matching `workflow-source:load-*` event, gated on the pure
 * function's boolean return so a late, orphaned settle never re-dispatches
 * `ready`/`failed` after the key already moved to `cancelled`, and a fresh
 * attempt for the same key resets cleanly back to `loading` first.
 * `source-resolution.ts` calls only the `*AndDispatch` wrappers.
 *
 * @module core/engine/source-diagnostics
 */

import {
  WorkflowSourceLoadCancelledEvent,
  WorkflowSourceLoadFailedEvent,
  WorkflowSourceLoadReadyEvent,
  WorkflowSourceLoadStartedEvent,
} from '../events/workflow-source-events.ts';
import { classifyErrorAsFailureCategory } from '../failure-categories.ts';
import type { WorkflowSourceKind } from '../source/index.ts';
import type { Engine } from './index.ts';
import type { EngineInternals } from './internals.ts';
import {
  decrementWaiterCount,
  incrementWaiterCount,
  readWaiterCount,
  type SourceLoadDiagnostics,
} from './source-runtime-state.ts';

function getOrCreateDiagnosticsEntry(
  internals: EngineInternals,
  name: string,
  revision: string,
): SourceLoadDiagnostics {
  let byRevision = internals.sources.diagnostics.get(name);
  if (byRevision === undefined) {
    byRevision = new Map();
    internals.sources.diagnostics.set(name, byRevision);
  }
  let entry = byRevision.get(revision);
  if (entry === undefined) {
    entry = {
      state: 'idle',
      kind: 'module',
      requestedRevision: revision,
      loadStartedAt: undefined,
      loadDurationMs: undefined,
      lastFailureCategory: undefined,
    };
    byRevision.set(revision, entry);
  }
  return entry;
}

/** Bounded diagnostics for one `(name, revision)`, or `undefined` when no load was ever attempted. */
export function readSourceLoadDiagnostics(
  internals: EngineInternals,
  name: string,
  revision: string,
): SourceLoadDiagnostics | undefined {
  return internals.sources.diagnostics.get(name)?.get(revision);
}

/** Record that a fresh shared load for `(name, revision)` just started. */
export function recordSourceLoadStarted(
  internals: EngineInternals,
  name: string,
  revision: string,
  kind: WorkflowSourceKind,
  now: number,
): void {
  const entry = getOrCreateDiagnosticsEntry(internals, name, revision);
  entry.state = 'loading';
  entry.kind = kind;
  entry.loadStartedAt = now;
  entry.loadDurationMs = undefined;
  entry.lastFailureCategory = undefined;
}

/**
 * Record a successful load, UNLESS the key already moved on (a `cancelled`
 * transition from the last waiter releasing, or a fresh attempt already
 * reset it back to `loading` for a NEW load this settle does not belong
 * to). Returns whether the caller should dispatch `WorkflowSourceLoadReadyEvent`.
 */
export function recordSourceLoadReady(
  internals: EngineInternals,
  name: string,
  revision: string,
  now: number,
): boolean {
  const entry = readSourceLoadDiagnostics(internals, name, revision);
  if (entry === undefined || entry.state !== 'loading') return false;
  entry.state = 'ready';
  entry.loadDurationMs = entry.loadStartedAt === undefined ? undefined : now - entry.loadStartedAt;
  return true;
}

/** The failed-load counterpart of {@link recordSourceLoadReady}. */
export function recordSourceLoadFailed(
  internals: EngineInternals,
  name: string,
  revision: string,
  now: number,
  error: unknown,
): boolean {
  const entry = readSourceLoadDiagnostics(internals, name, revision);
  if (entry === undefined || entry.state !== 'loading') return false;
  entry.state = 'failed';
  entry.loadDurationMs = entry.loadStartedAt === undefined ? undefined : now - entry.loadStartedAt;
  entry.lastFailureCategory = classifyErrorAsFailureCategory(error, {
    defaultErrorCategory: 'application',
  });
  return true;
}

/** Increment the outstanding-waiter count for `(name, revision)`. Call once per `resolveWorkflowSource()` call, before any await. */
export function beginSourceWaiter(
  internals: EngineInternals,
  name: string,
  revision: string,
): void {
  incrementWaiterCount(internals.sources.waitersByKey, name, revision);
}

/**
 * Decrement the outstanding-waiter count for `(name, revision)`; call in
 * every `resolveWorkflowSource()` call's own `finally`. Returns whether
 * this was the LAST outstanding waiter releasing while the shared load is
 * still `loading` — the caller should transition diagnostics to
 * `cancelled` and dispatch `WorkflowSourceLoadCancelledEvent`.
 */
export function endSourceWaiterAndCheckCancellation(
  internals: EngineInternals,
  name: string,
  revision: string,
): boolean {
  const remaining = decrementWaiterCount(internals.sources.waitersByKey, name, revision);
  if (remaining > 0) return false;
  const entry = readSourceLoadDiagnostics(internals, name, revision);
  if (entry === undefined || entry.state !== 'loading') return false;
  entry.state = 'cancelled';
  return true;
}

/**
 * When a new caller joins a still-in-flight shared load whose diagnostics
 * were marked `cancelled` (the last waiter released while the shared
 * promise was still unsettled, and a later caller then joined that SAME
 * orphaned promise instead of starting a fresh one — single-flight never
 * aborts the shared load itself, only per-caller waiter interest), restore
 * the state to `loading` so the eventual settle reaches its normal
 * `ready`/`failed` transition instead of being silently suppressed by
 * `recordSourceLoadReady`/`recordSourceLoadFailed`'s own `state !==
 * 'loading'` guard. Never dispatches a fresh `WorkflowSourceLoadStartedEvent`
 * — the load itself did not restart, only diagnostics visibility into it
 * did. A no-op for any state other than `cancelled` (in particular,
 * `getOrCreateSharedSourceLoad`'s cache-miss branch already sets `loading`
 * itself via {@link recordSourceLoadStartedAndDispatch} for a genuinely new
 * load, so this never fires there).
 */
export function reviveOrphanedSourceLoadDiagnostics(
  internals: EngineInternals,
  name: string,
  revision: string,
): void {
  const entry = readSourceLoadDiagnostics(internals, name, revision);
  if (entry === undefined || entry.state !== 'cancelled') return;
  entry.state = 'loading';
}

/** Current outstanding-waiter count for `(name, revision)`. */
export function readSourceWaiterCount(
  internals: EngineInternals,
  name: string,
  revision: string,
): number {
  return readWaiterCount(internals.sources.waitersByKey, name, revision);
}

/** Bundles the identity a `source-resolution.ts` call site already has in scope, so the `*AndDispatch` wrappers below take one argument instead of five. */
export type SourceEventContext = {
  engine: Engine;
  internals: EngineInternals;
  name: string;
  revision: string;
  kind: WorkflowSourceKind;
};

/** {@link recordSourceLoadStarted} plus dispatching `WorkflowSourceLoadStartedEvent`. */
export function recordSourceLoadStartedAndDispatch(ctx: SourceEventContext, now: number): void {
  recordSourceLoadStarted(ctx.internals, ctx.name, ctx.revision, ctx.kind, now);
  ctx.engine.dispatchEvent(new WorkflowSourceLoadStartedEvent(ctx.name, ctx.revision, ctx.kind));
}

/** {@link recordSourceLoadReady} plus dispatching `WorkflowSourceLoadReadyEvent` when it returns `true`. */
export function recordSourceLoadReadyAndDispatch(ctx: SourceEventContext, now: number): void {
  if (!recordSourceLoadReady(ctx.internals, ctx.name, ctx.revision, now)) return;
  const loadDurationMs = readSourceLoadDiagnostics(
    ctx.internals,
    ctx.name,
    ctx.revision,
  )!.loadDurationMs!;
  ctx.engine.dispatchEvent(
    new WorkflowSourceLoadReadyEvent(ctx.name, ctx.revision, ctx.kind, loadDurationMs),
  );
}

/** {@link recordSourceLoadFailed} plus dispatching `WorkflowSourceLoadFailedEvent` when it returns `true`. */
export function recordSourceLoadFailedAndDispatch(
  ctx: SourceEventContext,
  now: number,
  error: unknown,
): void {
  if (!recordSourceLoadFailed(ctx.internals, ctx.name, ctx.revision, now, error)) return;
  const diagnostics = readSourceLoadDiagnostics(ctx.internals, ctx.name, ctx.revision)!;
  ctx.engine.dispatchEvent(
    new WorkflowSourceLoadFailedEvent(
      ctx.name,
      ctx.revision,
      ctx.kind,
      diagnostics.loadDurationMs ?? 0,
      diagnostics.lastFailureCategory!,
    ),
  );
}

/** {@link endSourceWaiterAndCheckCancellation} plus dispatching `WorkflowSourceLoadCancelledEvent` when it returns `true`. */
export function endSourceWaiterAndDispatchCancellation(
  engine: Engine,
  internals: EngineInternals,
  name: string,
  revision: string,
): void {
  if (!endSourceWaiterAndCheckCancellation(internals, name, revision)) return;
  const kind = readSourceLoadDiagnostics(internals, name, revision)?.kind ?? 'module';
  engine.dispatchEvent(new WorkflowSourceLoadCancelledEvent(name, revision, kind));
}
