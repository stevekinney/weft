import { KEYS } from '../../storage/interface.ts';
import type { InlineExecutionStrategy } from '../inline-execution-strategy.ts';
import type { EngineInternals } from './internals.ts';
import { decodeWorkflowState, isTerminalWorkflowStatus } from './validation.ts';
import { decodeWorkflowClaimHolder } from './workflow-claim-codec.ts';

/** The live/parked query-dispatch context an `InlineExecutionStrategy` hands back. */
type QueryDispatchContext = NonNullable<ReturnType<InlineExecutionStrategy['getContext']>>;

/**
 * Thrown by `query()` when this engine has no live local execution context for
 * `workflowId` AND a durable `ownership: 'workflow-lease'` claim shows another
 * engine currently holds it — distinguishing "not owned here, retry against
 * the owner" from a query handler that legitimately resolved to `undefined`.
 * A workflow that is simply terminal, purged, or never existed still resolves
 * to plain `undefined`, unchanged — this error fires only when a live holder
 * record names a DIFFERENT engine.
 *
 * Not a public `WeftError`: ADR 0002 § Open questions leaves the cross-engine
 * query/update ROUTING mechanism open (forward to the true owner vs. surface
 * a retry-elsewhere error to the caller); this is the smaller, non-speculative
 * fix for the silent-`undefined` bug alone, reusing the same "untyped `Error`"
 * shape Gate 1 (`requireStorageCapability`) already ships for a similarly
 * not-yet-typed diagnostic rather than adding a new public error code and its
 * full registration surface for a routing question ADR 0002 has not settled.
 * `query()` has no durable fallback path the way `update()`'s coordinated
 * path does (see `updates.ts`), so surfacing an error here — rather than a
 * value indistinguishable from a real `undefined` result — is the only
 * correct option.
 */
export class WorkflowNotLocallyOwnedError extends Error {
  readonly workflowId: string;

  constructor(workflowId: string) {
    super(
      `Workflow "${workflowId}" has no live query context on this engine, and a durable ` +
        'workflow-lease claim shows another engine currently owns it. Retry the query against ' +
        'the engine that currently holds the claim.',
    );
    this.name = 'WorkflowNotLocallyOwnedError';
    this.workflowId = workflowId;
  }
}

/**
 * Cheap, read-only check for whether `workflowId` is durably claimed by a
 * DIFFERENT engine under `ownership: 'workflow-lease'` — a
 * `wakeOwnershipCheck`-style storage read (one `storage.get`, no
 * `conditionalBatch`), not the actual safety mechanism. Always `false`
 * (inert) under `ownership: 'none'`/`'lease'`, where no claim registry is
 * installed.
 *
 * Always re-reads the durable holder rather than trusting this engine's own
 * cached `registry.currentEpoch(workflowId)`: after a takeover elsewhere,
 * this engine's local claim entry stays populated (and its cached epoch
 * stale) until its next renewal CAS independently detects the loss — a
 * `registry.currentEpoch(workflowId) !== null` shortcut would let a stale
 * engine keep answering `false` (and so keep serving queries/updates from a
 * deposed context) for up to a full renewal interval. Deciding by the
 * durable holder's `engineId` alone — not epoch — is sufficient here: this
 * engine reacquiring the same workflow at a new epoch after a release still
 * means the holder names THIS engine, correctly answering `false`.
 */
export async function isWorkflowClaimedByAnotherEngine(
  internals: EngineInternals,
  workflowId: string,
): Promise<boolean> {
  const registry = internals.workflowClaimRegistry;
  if (registry === null) return false;
  const raw = await internals.storage.get(KEYS.workflowOwnerHolder(workflowId));
  if (raw === null) return false;
  const holder = decodeWorkflowClaimHolder(raw);
  if (holder === null) return false;
  return holder.engineId !== registry.engineId;
}

/**
 * `true` when `workflowId`'s persisted `WorkflowState` is missing (never
 * existed, or already purged) or terminal. Used to ignore a durably stale
 * `wf-owner-holder:<id>` record: a normal owner-side complete/fail commit is
 * fenced but does not delete the holder record (only an explicit `release`
 * — graceful shutdown or the reclaim scan's redrive-detects-terminal path —
 * or a `takeover`/rotation does), so a contextless query for an already-
 * terminal workflow can otherwise see a holder record naming a DIFFERENT
 * engine and incorrectly throw `WorkflowNotLocallyOwnedError` for a workflow
 * every engine agrees has already finished. Documented behavior is that
 * terminal, purged, or unknown workflows keep resolving to plain
 * `undefined` — this check restores that for the `workflow-lease` claim
 * path specifically.
 */
export async function isWorkflowLocallyTerminalOrMissing(
  internals: EngineInternals,
  workflowId: string,
): Promise<boolean> {
  const stateBytes = await internals.storage.get(KEYS.workflow(workflowId));
  if (stateBytes === null) return true;
  const state = decodeWorkflowState(stateBytes);
  return isTerminalWorkflowStatus(state.status);
}

/**
 * `internals.workflowClaimRegistry !== null && (await isWorkflowClaimedByAnotherEngine(...))`,
 * factored out so every "revalidate before serving a possibly-stale live
 * Context" call site — `query()` below and `tryInlineUpdateHandler` in
 * `updates.ts` — shares the exact same registry-gated short-circuit. The
 * registry-null check is a plain property read, not an unconditional await,
 * so `ownership: 'none'`/`'lease'` stay exactly as synchronous as they are
 * today; only `'workflow-lease'` pays for the cheap durable read.
 */
export function isLiveContextStale(
  internals: EngineInternals,
  workflowId: string,
): boolean | Promise<boolean> {
  // Returns a plain `false` — not a resolved promise — when no claim registry
  // exists, so a caller can skip the `await` entirely. An `async` function
  // suspends at its first `await` even when the callee returns synchronously,
  // so awaiting unconditionally would defer query answers and update-handler
  // invocation by a microtask under `ownership: 'none'` and `'lease'`, which
  // must stay byte-identical.
  if (internals.workflowClaimRegistry === null) return false;
  return isWorkflowClaimedByAnotherEngine(internals, workflowId);
}

/**
 * Plain (non-`async`) lookup for the live-or-parked dispatch Context, shared
 * by `query()`'s initial read and its post-stale-check re-read. Kept
 * synchronous and out of `query()`'s own branch count so the two call sites
 * stay cheap to read without inflating `query()`'s cyclomatic complexity.
 */
function resolveDispatchContext(
  inlineStrategy: InlineExecutionStrategy,
  workflowId: string,
): QueryDispatchContext | undefined {
  return inlineStrategy.getContext(workflowId) ?? inlineStrategy.getParkedContext(workflowId);
}

/**
 * Handles `query()`'s "no live/parked Context" case: throws
 * `WorkflowNotLocallyOwnedError` only when the workflow is durably claimed by
 * a different engine AND still locally active; otherwise resolves to plain
 * `undefined` (terminal, purged, unknown, or genuinely unclaimed).
 */
async function resolveContextlessQueryResult(
  internals: EngineInternals,
  workflowId: string,
): Promise<undefined> {
  const claimedByAnotherEngine = await isWorkflowClaimedByAnotherEngine(internals, workflowId);
  if (
    claimedByAnotherEngine &&
    !(await isWorkflowLocallyTerminalOrMissing(internals, workflowId))
  ) {
    throw new WorkflowNotLocallyOwnedError(workflowId);
  }
  return undefined;
}

/** Resolve a workflow query from built-in progress state or exposed inline accessors. */
export async function query(
  internals: EngineInternals,
  workflowId: string,
  name: string,
  input?: unknown,
): Promise<unknown> {
  // Built-in query: return latest heartbeat details for this workflow
  if (name === 'activityProgress') {
    return internals.heartbeatDetails.get(workflowId);
  }

  const inlineStrategy = internals.inlineStrategy;
  if (!inlineStrategy) {
    throw new Error('Workflow queries are not supported when using the worker execution strategy.');
  }
  // When the inline waitForSignal parking optimization evicts a run's live
  // generator (parkWorkflow with retainContext), it retains the run's Context in
  // parkedContexts so query handlers registered via ctx.onQuery stay callable.
  // (A waitForSignal yield that kept a live context — e.g. one with update
  // handlers or exposed accessors that inline-parking does not park — is served
  // by getContext below.) Check the live context first so a query racing with a
  // resume always sees the freshly installed context.
  const context = resolveDispatchContext(inlineStrategy, workflowId);
  if (!context) {
    return resolveContextlessQueryResult(internals, workflowId);
  }
  // A live Context here is not proof this engine still owns the workflow: a
  // DEPOSED engine keeps its Context until some later fenced write unwinds
  // the execution, so serving from it unconditionally would let a deposed
  // engine answer a query from stale state. See `isLiveContextStale`. This
  // stays a plain (non-`async`) branch — not a helper call — so `staleCheck
  // === false` never pays a microtask, matching `isLiveContextStale`'s own
  // "skip the `await` entirely" contract for `ownership: 'none'`/`'lease'`.
  const staleCheck = isLiveContextStale(internals, workflowId);
  let liveContext: QueryDispatchContext = context;
  if (staleCheck !== false) {
    if (await staleCheck) {
      throw new WorkflowNotLocallyOwnedError(workflowId);
    }
    // Re-read the Context AFTER the ownership-validation await: `context`
    // was captured before that `await`, so a signal delivered while the
    // durable holder read was pending can resume this same-owner parked
    // workflow (or drive it to terminal cleanup) and install/remove a
    // Context in the meantime. Dispatching against the pre-await `context`
    // here would invoke a superseded parked handler/accessor instead of the
    // fresh one, or serve a torn-down Context past its lifetime.
    const refreshedContext = resolveDispatchContext(inlineStrategy, workflowId);
    if (!refreshedContext) return undefined;
    liveContext = refreshedContext;
  }
  const queryHandler = liveContext.queryHandlers.get(name);
  if (queryHandler) return queryHandler(input);
  const accessor = liveContext.exposedAccessors.get(name);
  if (!accessor) return undefined;
  return accessor();
}
