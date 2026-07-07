/**
 * Durable record layer for out-of-band ("async") activity completion.
 *
 * Two record shapes share the `async-act:v1:` keyspace, discriminated by their
 * decode guards (never by key shape):
 *
 * - **Pending token records** ({@link KEYS.asyncActivity}): an activity that
 *   deferred via `ctx.completeAsync()` and is awaiting an external completion.
 * - **Resolution records** ({@link KEYS.asyncActivityResolution}): an
 *   acknowledged completion or failure whose resumed-workflow checkpoint has
 *   not committed yet. Written atomically with the token-record delete so the
 *   acknowledgement is durable before the caller learns it succeeded.
 *
 * The completion orchestration (park, consume, deliver, resume) lives in
 * `async-activity-completion.ts`; this module owns the persisted shapes, the
 * key derivations, and the in-memory resolution queue that recovery drains.
 */

import { KEYS, encodeStorageKeyComponent, type BatchOperation } from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import { ActivityAsyncPendingEvent } from '../events.ts';
import type { OperationOutcome } from '../types.ts';
import { commitFencedEngineWrite } from './fenced-write.ts';
import type { EngineInternals } from './internals.ts';

const ASYNC_ACTIVITY_TOKEN_PREFIX = 'async-act:v1';

/**
 * Storage-key prefix for durable async-activity records. Matches the base of
 * {@link KEYS.asyncActivity}; the full key appends `<workflowId>:<token>` (and
 * `:resolution` for resolution records). The trailing colon (absent from the
 * token prefix) scopes the global recovery scan to record keys only.
 */
export const ASYNC_ACTIVITY_KEY_PREFIX = 'async-act:v1:';

/**
 * Per-workflow prefix for all async-activity storage keys — pending token
 * records AND resolution records. Used by cleanup and purge paths that need to
 * sweep every async-activity record for a workflow without enumerating
 * individual tokens.
 */
export function asyncActivityWorkflowPrefix(workflowId: string): string {
  return `${ASYNC_ACTIVITY_KEY_PREFIX}${encodeStorageKeyComponent(workflowId)}:`;
}

/**
 * In-memory record of an activity that deferred to out-of-band completion and
 * is awaiting `completeAsyncActivity` / `failAsyncActivity`.
 */
export type PendingAsyncActivity = {
  readonly token: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly operationId: string;
  readonly step: number;
  readonly attempt: number;
  readonly createdAt: number;
};

/**
 * In-memory form of an acknowledged outcome awaiting delivery into the workflow
 * generator. `originalReason` (the raw thrown value on the failure path) exists
 * only within the acknowledging process — it is not persisted, so a resolution
 * reloaded by recovery reconstructs the error from the recorded outcome.
 */
export type PendingAsyncActivityResolution = {
  readonly token: string;
  readonly outcome: OperationOutcome;
  readonly originalReason?: { value: unknown };
  readonly timelineStatus: 'completed' | 'failed';
  readonly timelineOutput: unknown;
};

/** Durable shape persisted under {@link KEYS.asyncActivity}. */
type PersistedAsyncActivity = {
  readonly version: 1;
  readonly token: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly operationId: string;
  readonly step: number;
  readonly attempt: number;
  readonly createdAt: number;
};

function isPersistedAsyncActivity(value: unknown): value is PersistedAsyncActivity {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record['version'] === 1 &&
    typeof record['token'] === 'string' &&
    typeof record['workflowId'] === 'string' &&
    typeof record['activityName'] === 'string' &&
    typeof record['operationId'] === 'string' &&
    typeof record['step'] === 'number' &&
    typeof record['attempt'] === 'number' &&
    typeof record['createdAt'] === 'number'
  );
}

/**
 * Durable shape persisted under {@link KEYS.asyncActivityResolution}: an
 * acknowledged completion or failure whose resumed-workflow checkpoint has not
 * committed yet. Written atomically with the token-record delete so the
 * acknowledgement is durable before the caller learns it succeeded.
 */
type PersistedAsyncActivityResolution = {
  readonly version: 1;
  readonly kind: 'resolution';
  readonly token: string;
  readonly workflowId: string;
  readonly outcome: OperationOutcome;
};

function isPersistedOperationOutcome(value: unknown): value is OperationOutcome {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['status'] === 'completed') return 'value' in record;
  if (record['status'] === 'failed') return typeof record['error'] === 'string';
  return false;
}

function isPersistedAsyncActivityResolution(
  value: unknown,
): value is PersistedAsyncActivityResolution {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record['version'] === 1 &&
    record['kind'] === 'resolution' &&
    typeof record['token'] === 'string' &&
    typeof record['workflowId'] === 'string' &&
    isPersistedOperationOutcome(record['outcome'])
  );
}

/**
 * Derive the durable, deterministic task token for an async activity.
 *
 * The token is anchored to the workflow id, the activity state key, and the
 * dispatch attempt — all of which are stable across replay — so a workflow that
 * crashes while parked on an async activity mints the identical token after
 * recovery. Plain `ctx.run()` uses the workflow step as the state key.
 * `operationId` is deliberately excluded because it is regenerated on every
 * yield and would change on replay.
 */
export function deriveAsyncActivityToken(
  workflowId: string,
  step: number | string,
  attempt: number,
): string {
  return `${ASYNC_ACTIVITY_TOKEN_PREFIX}:${workflowId}:${step}:${attempt}`;
}

function buildPersistPendingAsyncActivityOperation(pending: PendingAsyncActivity): BatchOperation {
  const record: PersistedAsyncActivity = {
    version: 1,
    token: pending.token,
    workflowId: pending.workflowId,
    activityName: pending.activityName,
    operationId: pending.operationId,
    step: pending.step,
    attempt: pending.attempt,
    createdAt: pending.createdAt,
  };
  return {
    type: 'put',
    key: KEYS.asyncActivity(pending.workflowId, pending.token),
    value: encode(record),
  };
}

/**
 * Build the acknowledgement batch for a consumed token: delete the pending
 * token record and persist the resolution record carrying `outcome`, in one
 * batch, so the acknowledgement is durable before the caller learns it
 * succeeded.
 */
export function buildAsyncActivityAcknowledgementOperations(
  pending: PendingAsyncActivity,
  outcome: OperationOutcome,
): BatchOperation[] {
  const record: PersistedAsyncActivityResolution = {
    version: 1,
    kind: 'resolution',
    token: pending.token,
    workflowId: pending.workflowId,
    outcome,
  };
  return [
    { type: 'delete', key: KEYS.asyncActivity(pending.workflowId, pending.token) },
    {
      type: 'put',
      key: KEYS.asyncActivityResolution(pending.workflowId, pending.token),
      value: encode(record),
    },
  ];
}

/**
 * Register a deferred activity: record it in memory and durably, then announce
 * the token via {@link ActivityAsyncPendingEvent}. Idempotent on `token`: if the
 * token is already registered (e.g. because `recoverPendingAsyncActivities` loaded
 * it before the workflow replayed and re-deferred), the durable record is
 * refreshed but the event is NOT re-emitted, preventing duplicate side-effects
 * (e.g. re-sending a webhook notification) on replay.
 */
export async function registerPendingAsyncActivity(
  internals: EngineInternals,
  pending: PendingAsyncActivity,
): Promise<void> {
  const alreadyRegistered = internals.pendingAsyncActivities.has(pending.token);
  internals.pendingAsyncActivities.set(pending.token, pending);
  await commitFencedEngineWrite(
    internals,
    [buildPersistPendingAsyncActivityOperation(pending)],
    [],
    () =>
      new Error(`Async activity registration for token "${pending.token}" lost its precondition.`),
  );
  if (!alreadyRegistered) {
    internals.engine.dispatchEvent(
      new ActivityAsyncPendingEvent(
        pending.token,
        pending.operationId,
        pending.workflowId,
        pending.activityName,
        pending.attempt,
      ),
    );
  }
}

/**
 * Reload async-activity records from storage into memory. Called by
 * `recoverAll()` so a token minted before a crash is resolvable again — even
 * before the recovered workflow has replayed far enough to re-register it —
 * and so an acknowledged-but-not-yet-checkpointed resolution is redelivered
 * when replay re-parks on the same deterministic token.
 */
export async function recoverPendingAsyncActivities(internals: EngineInternals): Promise<void> {
  // Global scan prefix shared with `KEYS.asyncActivity`; the per-token suffix
  // (`<workflowId>:<token>`) follows this base. The same namespace also holds
  // acknowledged-but-not-yet-checkpointed resolution records
  // (`<workflowId>:<token>:resolution`); each record is discriminated by its
  // decode guard, never by key shape.
  for await (const [, bytes] of internals.storage.scan(ASYNC_ACTIVITY_KEY_PREFIX)) {
    const decoded = decode(bytes);
    if (isPersistedAsyncActivity(decoded)) {
      internals.pendingAsyncActivities.set(decoded.token, {
        token: decoded.token,
        workflowId: decoded.workflowId,
        activityName: decoded.activityName,
        operationId: decoded.operationId,
        step: decoded.step,
        attempt: decoded.attempt,
        createdAt: decoded.createdAt,
      });
      continue;
    }
    if (isPersistedAsyncActivityResolution(decoded)) {
      // An acknowledged outcome whose resumed-workflow checkpoint never
      // committed before the crash. Queue it so replay re-parking on the same
      // deterministic token adopts it instead of waiting for a delivery that
      // already happened. The raw thrown reason is not persisted; failed
      // outcomes are reconstructed from the recorded message/name/category.
      queuePendingAsyncActivityResolution(internals, decoded.workflowId, {
        token: decoded.token,
        outcome: decoded.outcome,
        timelineStatus: decoded.outcome.status,
        timelineOutput:
          decoded.outcome.status === 'completed' ? decoded.outcome.value : decoded.outcome.error,
      });
    }
  }
}

/**
 * True when a resolution cannot be delivered yet because inline replay has not
 * adopted the workflow generator (the post-recovery window).
 */
export function shouldBufferPendingAsyncActivityResolution(
  internals: EngineInternals,
  workflowId: string,
): boolean {
  return internals.inlineStrategy !== null && !internals.inlineStrategy.hasGenerator(workflowId);
}

/** Queue a resolution for delivery when replay reaches its token again. */
export function queuePendingAsyncActivityResolution(
  internals: EngineInternals,
  workflowId: string,
  resolution: PendingAsyncActivityResolution,
): void {
  internals.pendingAsyncActivityResolutions ??= new Map();
  const queued = internals.pendingAsyncActivityResolutions.get(workflowId) ?? [];
  queued.push(resolution);
  internals.pendingAsyncActivityResolutions.set(workflowId, queued);
}

/** Take the queued resolution for `token`, if one is waiting. */
export function takePendingAsyncActivityResolution(
  internals: EngineInternals,
  workflowId: string,
  token: string,
): PendingAsyncActivityResolution | undefined {
  internals.pendingAsyncActivityResolutions ??= new Map();
  const queued = internals.pendingAsyncActivityResolutions.get(workflowId);
  if (queued === undefined) return undefined;
  const index = queued.findIndex((resolution) => resolution.token === token);
  if (index === -1) return undefined;
  const resolution = queued[index];
  if (resolution === undefined) return undefined;
  queued.splice(index, 1);
  if (queued.length === 0) {
    internals.pendingAsyncActivityResolutions.delete(workflowId);
  }
  return resolution;
}
