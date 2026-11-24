/**
 * The `wf-retrying:{id}` record behind `WorkflowSummary.retrying` (COR-2529): which activity a
 * running workflow is retrying and on which attempt, kept in a small record of its own so a list
 * answers it without loading a checkpoint. Under its own prefix, a scan of the records is also the
 * index behind `ListFilter.retrying` (COR-2530).
 *
 * It is derived at the checkpoint commit, never written by the retry loop: the retry decision
 * already lives in the checkpoint's locals (`activity-retry-state.ts`) and commits with the
 * checkpoint at the backoff sleep, so the record changes in that same batch and no attempt adds a
 * write of its own. The commit compares the retrying activity its checkpoint shows with the one
 * the previous committed checkpoint showed and adds an operation only when they differ, which
 * covers every way an activity settles and every way a run resumes.
 *
 * @module core/engine/activity-retrying-record
 */
import { tryDecodeStorageKeyComponent, type BatchOperation } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { decode, encode } from '../codec.ts';
import { readRetryingActivity } from '../context/activity-retry-state.ts';
import type { Checkpoint, WorkflowRetrying, WorkflowState } from '../types.ts';
import type { EngineInternals } from './internals.ts';

function sameRetrying(
  left: WorkflowRetrying | undefined,
  right: WorkflowRetrying | undefined,
): boolean {
  return left?.activity === right?.activity && left?.attempt === right?.attempt;
}

/**
 * The operation that moves the record from what the previous committed checkpoint shows to what
 * `nextLocals` shows: a put for an activity now retrying, a delete once none is, and nothing when
 * the two agree. A run this engine holds no checkpoint for (a fresh start) shows nothing before.
 */
export function buildActivityRetryingOperations(
  internals: EngineInternals,
  workflowId: string,
  nextCheckpoint: Pick<Checkpoint, 'locals' | 'workflowExecutionToken'>,
): BatchOperation[] {
  const previous = readRetryingActivity(internals.checkpoints.get(workflowId)?.locals);
  const next = readRetryingActivity(nextCheckpoint.locals);
  if (sameRetrying(previous, next)) return [];
  return [activityRetryingOperation(workflowId, next, nextCheckpoint.workflowExecutionToken)];
}

/**
 * The operation `engine.retryFailed` writes when it reactivates a failed run. The failed run's last
 * checkpoint, the one the re-run resumes from, still names the activity that failed (no checkpoint
 * commits after a failure), so the re-run's first commit sees no change and would write no record.
 * The re-run is an attempt 2 or later whenever that checkpoint names one, so the record says so
 * from the moment the run is running again; a checkpoint that names none clears what the failure
 * left behind.
 */
export function reactivationRetryingOperation(
  workflowId: string,
  checkpoint: Pick<Checkpoint, 'locals'>,
  reactivatedState: Pick<WorkflowState, 'workflowExecutionToken'>,
): BatchOperation {
  return activityRetryingOperation(
    workflowId,
    readRetryingActivity(checkpoint.locals),
    reactivatedState.workflowExecutionToken,
  );
}

/**
 * The operation that makes the record say `retrying` for the run with `workflowExecutionToken`: a
 * put, or a delete when nothing is retrying. The record names the run it belongs to: a run that
 * ends while retrying leaves it behind (no checkpoint commits after the failure), and a
 * `start-new` replacement under the same id must not read the run before it as its own.
 */
export function activityRetryingOperation(
  workflowId: string,
  retrying: WorkflowRetrying | undefined,
  workflowExecutionToken: string | undefined,
): BatchOperation {
  const key = KEYS.activityRetrying(workflowId);
  if (retrying === undefined) return { type: 'delete', key };
  const record: ActivityRetryingRecord = {
    ...retrying,
    ...(workflowExecutionToken === undefined ? {} : { workflowExecutionToken }),
  };
  return { type: 'put', key, value: encode(record) };
}

/** What the `wf-retrying:{id}` record holds: the retrying activity and the run it belongs to. */
type ActivityRetryingRecord = WorkflowRetrying & { workflowExecutionToken?: string };

/**
 * The decoded record when it belongs to the run with `workflowExecutionToken`, and `undefined` when
 * it is absent, not the shape the engine writes, or left by another run under the same id.
 */
export function decodeActivityRetrying(
  bytes: Uint8Array | null,
  workflowExecutionToken: string | undefined,
): WorkflowRetrying | undefined {
  if (bytes === null) return undefined;
  const value: unknown = decode(bytes);
  if (!isRecord(value)) return undefined;
  if (value['workflowExecutionToken'] !== workflowExecutionToken) return undefined;
  const { activity, attempt } = value;
  if (typeof activity !== 'string' || activity.length === 0) return undefined;
  if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 2) {
    return undefined;
  }
  return { activity, attempt };
}

/**
 * The ids of every run that holds a retrying record: the candidate source for
 * `ListFilter.retrying: true`. A superset of the runs retrying now, since a run that ends while
 * retrying keeps its record until terminal cleanup; the list verifies each candidate against its
 * loaded state and the record's run token (`matchesListFilterAndRecords`).
 */
export async function queryRetryingIndex(internals: EngineInternals): Promise<Set<string>> {
  const prefix = KEYS.activityRetryingPrefix();
  const ids = new Set<string>();
  for await (const [key] of internals.storage.scan(prefix)) {
    const workflowId = tryDecodeStorageKeyComponent(key.slice(prefix.length));
    if (workflowId !== null) ids.add(workflowId);
  }
  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
