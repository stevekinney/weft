// ---------------------------------------------------------------------------
// Activity table resolution and result normalization for the remote worker
// ---------------------------------------------------------------------------

import { isRemoteWorkerJsonValue, type RemoteWorkerJsonValue } from './protocol.ts';
import {
  buildQualifiedActivityTable,
  type RemoteWorkerActivityFunction,
  type RemoteWorkerWorkflowDefinition,
} from './workflow-activity-binding.ts';

/** The subset of worker options that determines the advertised activity table. */
export type ActivityTableSource = {
  workflows?: Record<string, RemoteWorkerWorkflowDefinition>;
  activities?: Record<string, RemoteWorkerActivityFunction>;
};

/**
 * Coerce an activity's return value into a JSON value safe to send over the
 * wire. `undefined`, non-serializable values, and anything that does not round
 * -trip through JSON collapse to `null`.
 */
export function normalizeWorkerJsonValue(value: unknown): RemoteWorkerJsonValue {
  if (value === undefined) return null;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return null;
  const parsed: unknown = JSON.parse(encoded);
  return isRemoteWorkerJsonValue(parsed) ? parsed : null;
}

/**
 * Resolve the activity table the worker will advertise and dispatch against.
 *
 * Centralises the precondition checks so name-grammar violations and
 * key/name mismatches fail fast at construction time, before any WebSocket
 * connection is opened. Exactly one of `workflows` / `activities` must be set.
 */
export function resolveActivityTable(
  options: ActivityTableSource,
): Record<string, RemoteWorkerActivityFunction> {
  const hasWorkflows = options.workflows !== undefined;
  const hasActivities = options.activities !== undefined;
  if (hasWorkflows && hasActivities) {
    throw new Error(
      'RemoteWorker accepts either `workflows` or `activities`, not both — `workflows` is the canonical entry; remove `activities` when migrating.',
    );
  }
  if (!hasWorkflows && !hasActivities) {
    throw new Error(
      'RemoteWorker requires either `workflows` (preferred) or `activities` (legacy) — both were omitted.',
    );
  }
  if (options.workflows !== undefined) {
    return buildQualifiedActivityTable(options.workflows);
  }
  // Legacy entry: callers pre-qualified the activity names themselves. We
  // still trust the keys verbatim — Phase 5 sweeps these call sites.
  return { ...options.activities };
}
