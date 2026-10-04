import {
  decodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskRecord,
} from '../../core/task-ledger/task-ledger.ts';
import type { ServeOptions } from '../index.ts';
import { isAuthenticated, type Principal } from '../principal.ts';
import { readRestJsonBody, type RestBodyReadOptions } from '../rest-body.ts';
import type { ServerContext } from './context.ts';
import type {
  TaskLedgerCompletionFailureReason,
  TaskResultDisposition,
} from './task-ledger-completion.ts';
import { recordTaskBacklogMetric } from './task-metrics.ts';
import { applyWorkerTaskResult } from './task-result-application.ts';
import {
  authorizeTaskResultForCurrentAttempt,
  currentAttemptFromLedgerRecord,
  type TaskResultAuthorizationFailure,
} from './task-result-authorization.ts';
import { taskResultPayloadSizeError } from './task-result-resolution.ts';

const TASK_RESULT_RE = /^\/v1\/tasks\/([\w-]+)\/result$/;

export async function parseTaskResultBody(
  request: Request,
  options?: RestBodyReadOptions,
): Promise<Record<string, unknown> | null | Response> {
  try {
    return (await readRestJsonBody(request, options)) as Record<string, unknown>;
  } catch (error) {
    if (isPayloadTooLargeFault(error)) {
      return Response.json({ error: error.message }, { status: 413 });
    }
    return null;
  }
}

function isPayloadTooLargeFault(value: unknown): value is { message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['code'] === 'PayloadTooLarge' &&
    typeof (value as Record<string, unknown>)['message'] === 'string'
  );
}

type ValidatedTaskResult = {
  operationId: string;
  status: 'completed' | 'failed' | 'cancelled';
  workerId: string | undefined;
  value: unknown;
  error: string | undefined;
  attemptToken: string;
  workflowRevision: string | undefined;
};

type TaskResultStatus = ValidatedTaskResult['status'];

function isTaskResultStatus(value: string): value is TaskResultStatus {
  return value === 'completed' || value === 'failed' || value === 'cancelled';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function authorizeWorkerPrincipal(principal: Principal | undefined): Response | null {
  if (principal === undefined) return null;
  if (isAuthenticated(principal) && principal.hasScope('workers:write')) return null;
  return Response.json({ error: 'Forbidden' }, { status: 403 });
}

export async function awaitTaskLedgerRecovery(context: ServerContext): Promise<Response | null> {
  try {
    await context.taskLedgerRecovery.ready;
    return null;
  } catch (error) {
    return Response.json(
      {
        error: `Startup task-ledger recovery failed — cannot admit new task claims: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 503 },
    );
  }
}

/**
 * Validate and extract typed fields from a parsed task-result body.
 * Returns the validated result or a 400 Response if validation fails.
 */
function validateTaskResultBody(body: Record<string, unknown>): ValidatedTaskResult | Response {
  const operationId = body['operationId'];
  const status = body['status'];
  if (typeof operationId !== 'string' || typeof status !== 'string') {
    return Response.json(
      { error: 'Missing required fields: operationId, status' },
      { status: 400 },
    );
  }

  if (!isTaskResultStatus(status)) {
    return Response.json(
      { error: 'status must be "completed", "failed", or "cancelled"' },
      { status: 400 },
    );
  }

  const rawAttemptToken = body['attemptToken'];
  if (typeof rawAttemptToken !== 'string' || rawAttemptToken === '') {
    return Response.json({ error: 'attemptToken must be a non-empty string' }, { status: 400 });
  }

  return {
    operationId,
    status,
    workerId: optionalString(body['workerId']),
    value: body['value'],
    error: optionalString(body['error']),
    attemptToken: rawAttemptToken,
    workflowRevision: optionalString(body['workflowRevision']),
  };
}

/**
 * Every reason `handleTaskResultRequest` can permanently reject a `taskResult`
 * submission for, surfaced on the `403`/`413` response body's `reason` field
 * (COR-237) so a caller — including `LongPollWorker`'s own result-delivery
 * logic — does not have to pattern-match `error` text to tell the classes
 * apart. `TaskResultAuthorizationFailure` covers the shared identity gate
 * both transports go through; `'queue-mismatch'` and `'revision-mismatch'`
 * are long-poll-specific preconditions checked before/alongside it;
 * `TaskLedgerCompletionFailureReason` (currently only `'conflicting-content'`)
 * is the one named ledger-commit outcome from below that gate.
 */
export type LongPollTaskResultRejectionReason =
  | TaskResultAuthorizationFailure
  | 'queue-mismatch'
  | 'revision-mismatch'
  | TaskLedgerCompletionFailureReason;

type LongPollCompletionAuthorization =
  Readonly<{ ok: true }> | Readonly<{ ok: false; reason: LongPollTaskResultRejectionReason }>;

/**
 * Whether a long-poll completion may apply, read from the durable ledger
 * record rather than the old `op:inflight:` record. Unlike the pre-ledger
 * system, an absent or non-owning record is a hard rejection, not a
 * duplicate-tolerant no-op — the ledger's single authoritative key removes
 * the ambiguity that made "absent" a plausible stand-in for "already
 * resolved elsewhere" (see the project brief's failure matrix: "Result
 * arrives for unknown operation → Rejected"). The identity/attempt-token
 * decision itself is shared with the WebSocket transport (COR-233) — see
 * `authorizeTaskResultForCurrentAttempt` in `task-result-authorization.ts`,
 * which is also what lets a resend of an already-`terminal`/`deadLettered`
 * result reach `commitTaskLedgerCompletion`'s idempotent `duplicate`
 * handling instead of dying here the way it did before COR-233.
 *
 * Revision authorization (WFT-20) is STRICT for long-poll, unlike the
 * WebSocket transport's additive policy: when the stored ledger record
 * carries a `workflowRevision`, the POST body must echo it back exactly — a
 * missing echo is rejected the same as a mismatched one. Long-poll has no
 * live in-flight registry entry to fall back to ("was this SDK ever told
 * about the field") the way the WebSocket path does, so once ANY caller
 * starts supplying `workflowRevision` on `TaskDispatch` for a given
 * operation, every worker completing it must echo the value back. Checked
 * only while the attempt is still live (`leased`/`completing`) — a resend
 * against an already-resolved record is authorized by attempt token alone
 * (see `authorizeTaskResultForCurrentAttempt`), and `commitTaskLedgerCompletion`'s
 * content-digest comparison is what actually guards a resolved record
 * against a genuinely different resubmission from there.
 *
 * `queue` is the `:queue` path segment the result POST arrived on. It must
 * match the record's own `queue` exactly (COR-240) — otherwise a result
 * submitted against the wrong queue path could still authorize a completion
 * as long as the rest of the body matched, which is not the contract the
 * queue segment exists to enforce.
 */
function isLongPollCompletionAuthorized(
  record: RemoteTaskRecord | null,
  validated: ValidatedTaskResult,
  queue: string,
): LongPollCompletionAuthorization {
  if (record !== null && record.queue !== queue) {
    return { ok: false, reason: 'queue-mismatch' };
  }

  const authorization = authorizeTaskResultForCurrentAttempt(
    currentAttemptFromLedgerRecord(record),
    validated.workerId,
    validated.attemptToken,
  );
  if (!authorization.ok) return authorization;

  if (
    record !== null &&
    (record.state === 'leased' || record.state === 'completing' || record.state === 'cancelling') &&
    record.workflowRevision !== undefined &&
    validated.workflowRevision !== record.workflowRevision
  ) {
    return { ok: false, reason: 'revision-mismatch' };
  }

  return { ok: true };
}

/**
 * Apply a validated task result through the shared result-application
 * implementation (`applyWorkerTaskResult`, COR-240 acceptance criterion 12),
 * then update the in-memory bookkeeping the durable write does not own —
 * resolving any parked local completion waiters and clearing the deadline
 * tracker entry.
 */
async function applyTaskResult(
  context: ServerContext,
  options: ServeOptions,
  result: ValidatedTaskResult,
): Promise<
  | { ok: true; disposition: TaskResultDisposition }
  | { ok: false; reason: string; reasonCode?: TaskLedgerCompletionFailureReason }
> {
  const { operationId, status, value, error } = result;

  const applied = await applyWorkerTaskResult(
    options,
    context.metricsCollector,
    {
      operationId,
      attemptToken: result.attemptToken,
      status,
      ...(status === 'completed' ? { value } : {}),
      ...(status !== 'completed' && error !== undefined ? { error } : {}),
    },
    result.workerId,
  );
  if (!applied.ok) {
    return {
      ok: false,
      reason: applied.reason,
      ...(applied.reasonCode !== undefined ? { reasonCode: applied.reasonCode } : {}),
    };
  }

  // Dead-lettered is terminal-ish: no further heartbeat/visibility extension
  // will arrive for this operation, so stop tracking its deadline either
  // way. taskQueue.complete() is deliberately skipped for a dead letter —
  // that signals a normal delivered result to whatever is waiting, and a
  // dead letter is the opposite: the result could not be durably applied as
  // completed/failed.
  context.deadlineTracker.remove(operationId);
  if (applied.disposition !== 'dead-lettered') {
    context.taskQueue.complete({ operationId, status, value, error });
    context.registry?.completeTask(operationId);
    recordTaskBacklogMetric(context.metricsCollector, context.taskQueue);
  }

  return { ok: true, disposition: applied.disposition };
}

/**
 * `403` response for a `taskResult` this transport will never apply — no
 * matter how many times it is resent — carrying the `operationId`/
 * `attemptToken` that identify exactly which submission was rejected, plus a
 * machine-distinguishable `reason` (COR-237) when the caller has one:
 * `LongPollTaskResultRejectionReason` names the full set. Mirrors the
 * WebSocket transport's correlated `protocolError` (protocol v7,
 * `websocket-worker.ts`'s `commitAndAcknowledgeTaskResult`/
 * `applyTaskResultFallback`) in semantics, not shape: `LongPollWorker`'s own
 * result-delivery buffer (`LongPollResultDelivery`) drops the matching
 * buffered entry based on `operationId`/`attemptToken` correlation alone —
 * `reason` is surfaced to callers for diagnostics/logging only and plays no
 * part in that drop-versus-retry decision.
 */
function taskResultForbiddenResponse(
  operationId: string,
  attemptToken: string,
  reason?: LongPollTaskResultRejectionReason,
): Response {
  return Response.json(
    { error: 'Forbidden', operationId, attemptToken, ...(reason !== undefined ? { reason } : {}) },
    { status: 403 },
  );
}

function payloadSizeExceededResponse(error: {
  code: string;
  message: string;
  maxBytes: number;
  serializedBytes: number;
  payloadKind: string;
}): Response {
  return Response.json(
    {
      error: error.message,
      code: error.code,
      maxBytes: error.maxBytes,
      serializedBytes: error.serializedBytes,
      payloadKind: error.payloadKind,
    },
    { status: 413 },
  );
}

async function applyOversizedTaskResult(
  context: ServerContext,
  options: ServeOptions,
  result: ValidatedTaskResult,
  payloadError: NonNullable<ReturnType<typeof taskResultPayloadSizeError>>,
): Promise<void> {
  const rejected = await applyWorkerTaskResult(
    options,
    context.metricsCollector,
    {
      operationId: result.operationId,
      attemptToken: result.attemptToken,
      status: 'failed',
      error: payloadError.message,
    },
    result.workerId,
  );
  if (rejected.ok) {
    context.deadlineTracker.remove(result.operationId);
    if (rejected.disposition !== 'dead-lettered') {
      context.taskQueue.complete({
        operationId: result.operationId,
        status: 'failed',
        error: payloadError.message,
      });
      recordTaskBacklogMetric(context.metricsCollector, context.taskQueue);
    }
    return;
  }
  console.error(
    `[weft] Failed to persist oversized task result rejection for task "${result.operationId}":`,
    rejected.reason,
  );
}

async function submitValidatedTaskResult(
  context: ServerContext,
  options: ServeOptions,
  result: ValidatedTaskResult,
  queue: string,
): Promise<Response> {
  const record = decodeRemoteTaskRecord(
    await options.engine.storage.get(taskLedgerKey(result.operationId)),
  );
  const authorization = isLongPollCompletionAuthorized(record, result, queue);
  if (!authorization.ok) {
    return taskResultForbiddenResponse(
      result.operationId,
      result.attemptToken,
      authorization.reason,
    );
  }

  const payloadError = taskResultPayloadSizeError(
    {
      status: result.status,
      ...(result.status === 'completed' ? { value: result.value } : { error: result.error }),
    },
    context.payloadSizeMaxBytes,
  );
  if (payloadError !== null) {
    await applyOversizedTaskResult(context, options, result, payloadError);
    return payloadSizeExceededResponse(payloadError);
  }

  const applied = await applyTaskResult(context, options, result);
  if (applied.ok) {
    return Response.json({ ok: true, disposition: applied.disposition });
  }
  console.error(
    `[weft] Failed to commit task result for "${result.operationId}" through the durable ledger:`,
    applied.reason,
  );
  // Mirrors the WebSocket transport's correlated `protocolError` (protocol
  // v7): the error body carries `operationId`/`attemptToken` plus, when
  // this is the one named ledger-commit outcome (`applied.reasonCode`,
  // e.g. `'conflicting-content'`), a machine-distinguishable `reason` too
  // (COR-237) — `LongPollWorker`'s own result-delivery logic reads it to
  // decide whether this rejection is permanent (drop the buffered result)
  // or a generic, potentially-transient commit failure worth retrying.
  return taskResultForbiddenResponse(result.operationId, result.attemptToken, applied.reasonCode);
}

export async function handleTaskResultRequest(
  context: ServerContext,
  options: ServeOptions,
  request: Request,
  url: URL,
  principal?: Principal,
): Promise<Response | null> {
  if (request.method !== 'POST') {
    return null;
  }

  const completeMatch = TASK_RESULT_RE.exec(url.pathname);
  if (!completeMatch?.[1]) {
    return null;
  }
  const queue = decodeURIComponent(completeMatch[1]);

  const authorizationResponse = authorizeWorkerPrincipal(principal);
  if (authorizationResponse !== null) return authorizationResponse;

  const recoveryResponse = await awaitTaskLedgerRecovery(context);
  if (recoveryResponse !== null) return recoveryResponse;

  const body = await parseTaskResultBody(
    request,
    options.maxRequestBodyBytes !== undefined ? { maxBodyBytes: options.maxRequestBodyBytes } : {},
  );
  if (body instanceof Response) {
    return body;
  }
  if (body === null) {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const validated = validateTaskResultBody(body);
  if (validated instanceof Response) {
    return validated;
  }
  return submitValidatedTaskResult(context, options, validated, queue);
}
