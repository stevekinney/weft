import { KEYS } from '../../storage/interface.ts';
import type { EngineInternals } from './internals.ts';
import { decodeWorkflowClaimHolder } from './workflow-claim-codec.ts';

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
 * installed, and whenever THIS engine's own claim registry already tracks
 * the workflow — a live local claim with no local context is the existing,
 * unrelated "not currently active in-memory" ambiguity this check does not
 * change.
 */
export async function isWorkflowClaimedByAnotherEngine(
  internals: EngineInternals,
  workflowId: string,
): Promise<boolean> {
  const registry = internals.workflowClaimRegistry;
  if (registry === null) return false;
  if (registry.currentEpoch(workflowId) !== null) return false;
  const raw = await internals.storage.get(KEYS.workflowOwnerHolder(workflowId));
  if (raw === null) return false;
  return decodeWorkflowClaimHolder(raw) !== null;
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
  const context =
    inlineStrategy.getContext(workflowId) ?? inlineStrategy.getParkedContext(workflowId);
  if (!context) {
    if (await isWorkflowClaimedByAnotherEngine(internals, workflowId)) {
      throw new WorkflowNotLocallyOwnedError(workflowId);
    }
    return undefined;
  }
  const queryHandler = context.queryHandlers.get(name);
  if (queryHandler) return queryHandler(input);
  const accessor = context.exposedAccessors.get(name);
  if (!accessor) return undefined;
  return accessor();
}
