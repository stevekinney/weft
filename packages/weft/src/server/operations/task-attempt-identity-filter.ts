/**
 * Execution-identity filtering for `weft.tasks.diagnostics` (COR-198).
 *
 * `RemoteTaskRecord` carries the ledger's CURRENT state only — its
 * `executionIdentity` (when present) describes whichever attempt is
 * current, not the operation's full attempt history. Filtering by
 * `deploymentName`/`buildId`/`artifactDigest`/`workerId`/`workflowRevision`
 * therefore reads the durable {@link TaskAttemptRecord} COR-205 already
 * writes for that current attempt, rather than duplicating identity fields
 * onto the ledger record a second time.
 *
 * Deliberately bounded: this performs exactly one `storage.get` per
 * candidate record, and only when at least one identity filter is set — see
 * {@link hasExecutionIdentityFilter}. A `queued` record (no attempt has
 * claimed it yet) and a `leased`/`completing`/`cancelling`/`terminal`/
 * `deadLettered` record whose claim never obtained a manifest-verified
 * identity (`RemoteTaskLeased.executionIdentity`'s own doc comment — every
 * long-poll claim, always) can never match; they are excluded, not treated
 * as wildcards.
 *
 * @module server/operations/task-attempt-identity-filter
 */

import { decodeTaskAttemptRecord, taskAttemptKey } from '../../core/task-ledger/task-attempt.ts';
import type { RemoteTaskRecord } from '../../core/task-ledger/task-ledger.ts';
import type { Storage } from '../../storage/interface.ts';
import { sha256HexSync } from '../../worker/manifest/content-digest.ts';
import type { WorkerExecutionIdentity } from '../../worker/manifest/types.ts';
import type { GetTaskDiagnosticsInput } from './get-task-diagnostics.ts';

/** The current attempt's fencing token, when this record's state carries one — never a `queued` record. */
function currentAttemptTokenOf(record: RemoteTaskRecord): string | undefined {
  switch (record.state) {
    case 'queued':
      return undefined;
    case 'leased':
    case 'completing':
    case 'cancelling':
    case 'deadLettered':
      return record.attemptToken;
    case 'terminal':
      // Present for `resolved`/`retryExhausted`; absent for a `cancelled`
      // record cancelled straight from `queued` (no attempt ever existed).
      return record.attemptToken;
    default: {
      const exhaustive: never = record;
      return exhaustive;
    }
  }
}

/** True when the caller asked for at least one of the five identity dimensions. */
export function hasExecutionIdentityFilter(input: GetTaskDiagnosticsInput): boolean {
  return (
    input.deploymentName !== undefined ||
    input.buildId !== undefined ||
    input.artifactDigest !== undefined ||
    input.workerId !== undefined ||
    input.workflowRevision !== undefined
  );
}

/** One (requested filter value, identity's own value) pair per identity dimension {@link matchesIdentity} checks. */
function identityFilterPairs(
  identity: WorkerExecutionIdentity,
  input: GetTaskDiagnosticsInput,
): ReadonlyArray<readonly [requested: string | undefined, actual: string]> {
  return [
    [input.deploymentName, identity.deploymentName],
    [input.buildId, identity.buildId],
    [input.artifactDigest, identity.artifactDigest],
    [input.workerId, identity.workerId],
    [input.workflowRevision, identity.workflowRevision],
  ];
}

function matchesIdentity(
  identity: WorkerExecutionIdentity,
  input: GetTaskDiagnosticsInput,
): boolean {
  return identityFilterPairs(identity, input).every(
    ([requested, actual]) => requested === undefined || requested === actual,
  );
}

/**
 * Whether `record`'s current attempt's durable execution identity matches
 * every identity filter set on `input`. Always `true` when
 * {@link hasExecutionIdentityFilter} is `false` — callers should skip this
 * check entirely in that case rather than pay for the bounded lookup, but it
 * is also safe to call unconditionally.
 */
export async function matchesExecutionIdentityFilter(
  storage: Pick<Storage, 'get'>,
  record: RemoteTaskRecord,
  input: GetTaskDiagnosticsInput,
): Promise<boolean> {
  if (!hasExecutionIdentityFilter(input)) return true;

  const attemptToken = currentAttemptTokenOf(record);
  if (attemptToken === undefined) return false;

  const digest = sha256HexSync(attemptToken);
  const attempt = decodeTaskAttemptRecord(
    await storage.get(taskAttemptKey(record.operationId, digest)),
  );
  if (attempt?.executionIdentity === undefined) return false;

  return matchesIdentity(attempt.executionIdentity, input);
}
