/**
 * `weft.tasks.deadletters.retry` (COR-1973) — return one dead-lettered task to
 * `queued` under the same operation id so a worker claims it again.
 *
 * A dead letter is a task whose last attempt finished but whose result the
 * ledger could not persist (`task-ledger-transitions.ts`'s `commitDeadLetter`).
 * Retrying it does not delete anything. The dead attempt's `TaskAttemptRecord`
 * (disposition `deadLettered`, with its reason and timestamp) and the task's
 * delivery history stay readable through `weft.tasks.get` and
 * `weft.tasks.deliveries`; `requeueCount` is incremented; and the next claim
 * writes a new attempt record. What the retry replaces is the ledger record's
 * own result fields (`value`, `error`, `pendingResultDigest`,
 * `pendingStatus`), so `weft.tasks.deadletters.get` answers NotFound
 * afterwards. Clearing the dead letter and retrying it are alternatives: after
 * either, the other finds nothing to act on.
 *
 * @module server/operations/retry-task-dead-letter
 */

import { z } from 'zod';

import { defineOperation } from "../../embedded/backchannel/src/index.ts";
import type { UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import { decodeWorkflowState, isTerminalWorkflowStatus } from '../../core/engine/validation.ts';
import { commitTaskLedgerTransition } from '../../core/task-ledger/task-ledger-runtime.ts';
import {
  DEAD_LETTER_CHANGED_REASON,
  retryDeadLetteredTask,
} from '../../core/task-ledger/task-ledger-transitions-retry.ts';
import {
  decodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskQueued,
} from '../../core/task-ledger/task-ledger.ts';
import type { MetricsCollector } from '../../observability/metrics.ts';
import { KEYS } from '../../storage/keys.ts';
import { raiseFault } from '../operation-catalog/raise-fault.ts';
import { recordTaskRequeueMetric, recordTaskRetryMetric } from '../runtime/task-metrics.ts';
import { requireOperationStorage } from './operation-helpers.ts';
import { parseOptionalScheduleRestBodyRecord } from './schedule-rest-body.ts';

const retryTaskDeadLetterInput = z.object({
  operationId: z.string().min(1).describe('Id of the dead-lettered task operation to queue again.'),
  attemptTokenDigest: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Digest of the dead-lettered attempt the caller read (`attemptTokenDigest` on `weft.tasks.deadletters.get` or on the attempt in `weft.tasks.get`). Refused with Conflict when the dead letter is no longer that attempt. Omitted, whichever attempt is dead-lettered is retried.',
    ),
});
const retryTaskDeadLetterOutput = z
  .object({
    operationId: z.string(),
    state: z.literal('queued'),
    attempt: z.number().int().describe('The attempt number the next claim runs as.'),
    requeueCount: z.number().int().describe('Requeues this task has had, this retry included.'),
  })
  .strict();

export type RetryTaskDeadLetterInput = z.infer<typeof retryTaskDeadLetterInput>;
export type RetryTaskDeadLetterOutput = z.infer<typeof retryTaskDeadLetterOutput>;

/**
 * How many times the retry re-reads the task after losing a compare-and-swap
 * to another writer. A concurrent retry or clear is settled on the second
 * read; the extra pass absorbs one unrelated write to the owning workflow.
 */
const MAXIMUM_RETRY_PASSES = 3;

/**
 * Read the workflow run that owns a task and return the condition that fences
 * the retry on exactly the bytes read, or `null` when that run is gone or has
 * finished. A workflow id names every run started under it, and a task id is
 * the workflow id plus step and attempt, so a restarted run reuses the id. When
 * both execution tokens are known and differ, a newer run holds the id: the
 * activity's result would be dropped as stale and its side effects would repeat
 * for a run that already ended.
 */
async function readLiveOwningRun(
  storage: { get(key: string): Promise<Uint8Array | null> },
  workflowId: string,
  task: { workflowExecutionToken?: string | undefined },
): Promise<{ key: string; expectedValue: Uint8Array } | null> {
  const key = KEYS.workflow(workflowId);
  const bytes = await storage.get(key);
  if (bytes === null) return null;
  const state = decodeWorkflowState(bytes);
  if (isTerminalWorkflowStatus(state.status)) return null;
  const taskToken = task.workflowExecutionToken;
  const runToken = state.workflowExecutionToken;
  if (taskToken !== undefined && runToken !== undefined && taskToken !== runToken) return null;
  return { key, expectedValue: bytes };
}

export type RetryTaskDeadLetterOptions = {
  metricsCollector?: MetricsCollector | undefined;
  /**
   * Hand the queued record to the dispatcher right away. `serve()` supplies it.
   * Without it the record waits for the ledger sweep (`reconcileOrphanedRecords`),
   * which dispatches a queued record nothing is tracking.
   */
  redispatchQueuedTask?: ((record: RemoteTaskQueued) => void) | undefined;
};

/**
 * Build `weft.tasks.deadletters.retry`, optionally bound to the server's
 * metrics collector and dispatcher. With neither, the operation still
 * transitions the ledger; discovery-only registries never invoke it.
 */
export function createRetryTaskDeadLetterOperation(options?: RetryTaskDeadLetterOptions) {
  const metricsCollector = options?.metricsCollector;
  const redispatchQueuedTask = options?.redispatchQueuedTask;
  const operation = defineOperation({
    name: 'weft.tasks.deadletters.retry',
    mcpExposable: false,
    summary: 'Queue a dead-lettered task again',
    description:
      'Return a dead-lettered task to the queue under the same operation id: it becomes queued ' +
      'with a new attempt, and requeueCount is incremented. Nothing is deleted. The dead ' +
      "attempt's attempt record and the delivery history stay readable through weft.tasks.get " +
      'and weft.tasks.deliveries, but the retained result is replaced, so ' +
      'weft.tasks.deadletters.get answers NotFound afterwards. Pass attemptTokenDigest to retry ' +
      'only the attempt you read. The activity runs again: side effects the dead attempt ' +
      'already performed are repeated unless the activity is idempotent. retryPolicy.maxAttempts ' +
      'is not checked, so a task at the cap stays retryable, and the next automatic requeue may ' +
      'end it retryExhausted. Requires system:admin. Faults with NotFound when no task has the ' +
      'given operation id, and with Conflict (reason not-dead-lettered, dead-letter-changed, ' +
      'workflow-finished or concurrent-change) when the task cannot be retried; a refused retry ' +
      'changes nothing.',
    destructive: true,
    tags: ['Observability'],
    inputSchema: retryTaskDeadLetterInput,
    outputSchema: retryTaskDeadLetterOutput,
    access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['system:admin'] } },
    producibleFaults: ['NotFound', 'Conflict'],
    discoverable: true,
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    invoke: async ({ input, host: engine }): Promise<RetryTaskDeadLetterOutput> => {
      const storage = requireOperationStorage(engine, ['capabilities', 'get', 'conditionalBatch']);
      // Snapshot before the first await: the passes below read it after several.
      const { operationId, attemptTokenDigest } = input;
      const ledgerKey = taskLedgerKey(operationId);

      for (let pass = 1; pass <= MAXIMUM_RETRY_PASSES; pass++) {
        const current = decodeRemoteTaskRecord(await storage.get(ledgerKey));
        if (current === null) {
          raiseFault(operation, {
            code: 'NotFound',
            message: `No task found for operation "${operationId}"`,
            data: { resource: 'task', identifier: operationId },
          });
        }
        if (current.state !== 'deadLettered') {
          raiseFault(operation, {
            code: 'Conflict',
            message: `Task "${operationId}" is ${current.state}, not dead-lettered`,
            data: { reason: 'not-dead-lettered' },
          });
        }

        // The retry resumes the owning workflow's parked activity, so it needs a
        // workflow that is still running; the same transaction fences on the
        // exact workflow bytes read here, so the workflow cannot finish between
        // this read and the commit.
        const conditions = [];
        if (current.workflowId !== undefined) {
          const fence = await readLiveOwningRun(storage, current.workflowId, current);
          if (fence === null) {
            raiseFault(operation, {
              code: 'Conflict',
              message: `Workflow "${current.workflowId}" run that owns task "${operationId}" has finished`,
              data: { reason: 'workflow-finished' },
            });
          }
          conditions.push(fence);
        }

        const committed = await commitTaskLedgerTransition(
          storage,
          operationId,
          (record, now) =>
            retryDeadLetteredTask(
              record,
              attemptTokenDigest === undefined ? {} : { attemptTokenDigest },
              now,
            ),
          1,
          conditions,
        );
        if (committed.ok) {
          recordTaskRetryMetric(metricsCollector);
          recordTaskRequeueMetric(metricsCollector);
          redispatchQueuedTask?.(committed.record);
          return {
            operationId,
            state: 'queued',
            attempt: committed.record.attempt,
            requeueCount: committed.record.requeueCount,
          };
        }
        if (committed.reason === DEAD_LETTER_CHANGED_REASON) {
          raiseFault(operation, {
            code: 'Conflict',
            message: `The dead letter for task "${operationId}" is no longer the attempt that was read`,
            data: { reason: DEAD_LETTER_CHANGED_REASON },
          });
        }
        // Any other refusal is a lost race with another writer (a concurrent
        // retry, a clear, a workflow write): read again and let the fresh
        // record decide which fault, if any, applies.
      }

      return raiseFault(operation, {
        code: 'Conflict',
        message: `Task "${operationId}" kept changing while it was being retried; read it and try again`,
        data: { reason: 'concurrent-change' },
      });
    },
  });
  return operation;
}

/** Default discovery-only operation; live servers use `createRetryTaskDeadLetterOperation(...)`. */
export const retryTaskDeadLetterOperation = createRetryTaskDeadLetterOperation();

/** REST binding for `weft.tasks.deadletters.retry`; the body may carry `attemptTokenDigest`. */
export const retryTaskDeadLetterRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/tasks/detail/:operationId/dead-letter/retry',
  pathParamNames: ['operationId'],
  operationName: 'weft.tasks.deadletters.retry',
  inputSources: {
    operationId: { kind: 'path', pathParam: 'operationId' },
    attemptTokenDigest: { kind: 'body-field', bodyField: 'attemptTokenDigest' },
  },
  extractInput: async (request, pathParams, context) => {
    const body = await parseOptionalScheduleRestBodyRecord(request, context);
    // The path owns the operation id; any other body key reaches the schema,
    // which rejects it (`unknownKeyPolicy.http: 'reject'`).
    return { ...body, operationId: pathParams['operationId'] ?? '' };
  },
  success: { kind: 'json', status: 200 },
};
