/**
 * The typed failures of a workflow refresh, and how a failure from the host's
 * own callbacks is classified into one.
 *
 * @module core/catalog/workflow-refresh-failure
 */

import { WorkflowCatalogConflictError, WorkflowRevisionTombstonedError } from './errors.ts';

/**
 * Why a refresh failed, as a bounded vocabulary a caller can branch on without
 * reading a message. A host's own `fetch`, `validateRuntime`, and `warm`
 * callbacks may throw anything, including text with a path or a credentialed
 * URL, so the reason (never the message) is what crosses a wire.
 *
 * - `not-registered`: no refresh source is registered for the name.
 * - `source`: the host's `fetch` failed or returned an unusable response, such
 *   as a 200 without an artifact or a first-check 304.
 * - `integrity`: the artifact's bytes do not match its digest, its envelope, or
 *   the size bound, or its proof is incomplete.
 * - `identity`: the artifact is not the requested name and revision.
 * - `contract`: the artifact's manifest failed validation, including its
 *   contract hash.
 * - `runtime`: the host rejected the artifact's runtime proof.
 * - `warming`: the host failed to warm the candidate.
 * - `conflict`: the catalog refused to install the candidate.
 * - `cancelled`: the caller's signal aborted the check.
 * - `stopped`: the coordinator was disposed.
 * - `internal`: anything else, such as a storage failure.
 */
export type WorkflowRefreshFailureReason =
  | 'not-registered'
  | 'source'
  | 'integrity'
  | 'identity'
  | 'contract'
  | 'runtime'
  | 'warming'
  | 'conflict'
  | 'cancelled'
  | 'stopped'
  | 'internal';

/** A refresh failure with a bounded {@link WorkflowRefreshFailureReason}. The original error, when there is one, is its `cause`. */
export class WorkflowRefreshError extends Error {
  readonly reason: WorkflowRefreshFailureReason;

  constructor(
    reason: WorkflowRefreshFailureReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'WorkflowRefreshError';
    this.reason = reason;
  }
}

export function stoppedError(): WorkflowRefreshError {
  return new WorkflowRefreshError('stopped', 'Workflow refresh coordinator is stopped');
}

/**
 * A failure thrown by one of the host's own callbacks, as a typed error. The
 * host's error stays the `cause` and its message is kept for in-process
 * callers. A coordinator error already typed, and a caller's own cancellation,
 * pass through unchanged.
 */
export function hostFailure(
  reason: WorkflowRefreshFailureReason,
  error: unknown,
  signal: AbortSignal,
): unknown {
  if (error instanceof WorkflowRefreshError) return error;
  if (signal.aborted) return error;
  return new WorkflowRefreshError(reason, error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}

export function failureReason(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  stopped: boolean,
): WorkflowRefreshFailureReason {
  if (error instanceof WorkflowRefreshError) return error.reason;
  if (stopped) return 'stopped';
  if (error instanceof WorkflowCatalogConflictError) return 'conflict';
  if (error instanceof WorkflowRevisionTombstonedError) return 'conflict';
  if (callerSignal?.aborted === true) return 'cancelled';
  return 'internal';
}
