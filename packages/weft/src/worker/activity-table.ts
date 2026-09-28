// ---------------------------------------------------------------------------
// Activity table resolution and result normalization for the remote worker
// ---------------------------------------------------------------------------

import type { RemoteWorkerJsonValue } from './protocol.ts';
import { encodeStrictWorkerJsonValue } from './strict-json.ts';
import {
  buildQualifiedActivityTable,
  type RemoteWorkerActivityFunction,
  type RemoteWorkerWorkflowDefinition,
} from './workflow-activity-binding.ts';

/**
 * The subset of worker options that determines the advertised activity table.
 *
 * `workflows` is required on the public {@link RemoteWorkerOptions}. It stays
 * optional here so {@link resolveActivityTable} can defend against untyped or
 * JavaScript callers that omit it and throw a clear construction error rather
 * than reading `undefined`. This optionality must not leak into the public
 * constructor type.
 */
export type ActivityTableSource = {
  workflows?: Record<string, RemoteWorkerWorkflowDefinition>;
};

/**
 * Validate and clone an activity's return value into a JSON value safe to send
 * over the wire. Values JSON would erase or rewrite are rejected with a path
 * instead of silently becoming `null`.
 */
export function normalizeWorkerJsonValue(value: unknown): RemoteWorkerJsonValue {
  return encodeStrictWorkerJsonValue(value, 'activity result');
}

/**
 * Resolve the activity table the worker will advertise and dispatch against.
 *
 * Centralises the precondition checks so name-grammar violations and
 * key/name mismatches fail fast at construction time, before any WebSocket
 * connection is opened. `workflows` is required.
 *
 * The removed `activities` alias is rejected actively rather than ignored: an
 * untyped or JavaScript caller that still passes it (especially alongside an
 * empty `workflows: {}`) would otherwise build a worker that silently drops part
 * of its configuration, so we fail loudly instead.
 */
export function resolveActivityTable(
  options: ActivityTableSource,
): Record<string, RemoteWorkerActivityFunction> {
  if (Object.prototype.hasOwnProperty.call(options, 'activities')) {
    throw new Error(
      'RemoteWorker no longer accepts `activities`; declare your activities under `workflows` instead.',
    );
  }
  if (options.workflows === undefined || options.workflows === null) {
    throw new Error(
      'RemoteWorker requires `workflows` — a map of workflow type → { name, activities }.',
    );
  }
  return buildQualifiedActivityTable(options.workflows);
}
