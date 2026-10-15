/**
 * Records each answered `taskResult` submission into the operation's durable
 * delivery history (COR-1366) and announces the non-`applied` ones with
 * {@link TaskResultDeliveryEvent}.
 *
 * Called by both worker transports at the point where they answer a
 * submission — `websocket-worker.ts` (a `taskResultAck` or a correlated
 * `protocolError`) and `task-result-submission.ts` (a `200` with a
 * disposition, or a correlated `403`) — so the history reflects what the
 * worker was actually told.
 *
 * **Bounded and owned by the ledger record.** An entry is written only while
 * the operation's ledger record exists, and the write is fenced on the exact
 * ledger bytes just read. A submission for an operation that was never
 * dispatched, or whose record was purged, is not recorded: the
 * `operationId` is worker-supplied, and recording it would let any
 * authenticated worker create storage keys for arbitrary identifiers. The
 * fence also means a purge that races this write wins, and no orphaned
 * history survives it. Retention purge and dead-letter clearing delete the
 * history key in the same batch as the ledger record.
 *
 * **Best effort.** Recording never changes the answer the worker gets. It
 * can delay a long-poll answer, which waits for the write; a WebSocket answer
 * is sent first (see `documentation/guides/remote-task-recovery.md`). A
 * storage failure is logged and dropped; a lost compare-and-swap is retried a
 * bounded number of times against fresh state.
 *
 * @module server/runtime/task-result-delivery-recorder
 */

import { TaskResultDeliveryEvent } from '../../core/events.ts';
import { isBoundedIdentifier } from '../../core/task-ledger/task-ledger-codec.ts';
import { decodeRemoteTaskRecord, taskLedgerKey } from '../../core/task-ledger/task-ledger.ts';
import {
  appendTaskResultDelivery,
  boundTaskResultDeliveryReason,
  decodeTaskResultDeliveryHistory,
  encodeTaskResultDeliveryHistory,
  taskResultDeliveryKey,
  type TaskResultDeliveryDisposition,
  type TaskResultDeliveryEntry,
  type TaskResultDeliveryRejectionCode,
  type TaskResultDeliveryTransport,
} from '../../core/task-ledger/task-result-delivery.ts';
import { storageConditionalBatch, type Storage } from '../../storage/interface.ts';
import { sha256Hex } from '../../worker/manifest/content-digest.ts';
import type { ServeOptions } from '../index.ts';

const RECORD_MAX_ATTEMPTS = 3;

/** Replaces the raw attempt token wherever it appears in recorded rejection text. */
export const REDACTED_ATTEMPT_TOKEN = '[attempt token redacted]';

type TaskResultDeliverySubmission = Readonly<{
  operationId: string;
  attemptToken: string;
  transport: TaskResultDeliveryTransport;
  workerId: string | undefined;
  submittedStatus: 'completed' | 'failed' | 'cancelled';
}>;

export type TaskResultDeliveryAnswer =
  | Readonly<{
      outcome: 'acknowledged';
      disposition: TaskResultDeliveryDisposition;
      oversizedPayload?: boolean;
    }>
  | Readonly<{
      outcome: 'rejected';
      /** `'unknown-operation'` is accepted for caller convenience and never recorded. */
      rejectionCode: TaskResultDeliveryRejectionCode | 'unknown-operation';
      reason: string;
    }>;

type RecordableAnswer =
  | Extract<TaskResultDeliveryAnswer, { outcome: 'acknowledged' }>
  | Readonly<{
      outcome: 'rejected';
      rejectionCode: TaskResultDeliveryRejectionCode;
      reason: string;
    }>;

function isRecordableAnswer(answer: TaskResultDeliveryAnswer): answer is RecordableAnswer {
  return answer.outcome === 'acknowledged' || answer.rejectionCode !== 'unknown-operation';
}

async function buildEntry(
  submission: TaskResultDeliverySubmission,
  answer: RecordableAnswer,
): Promise<TaskResultDeliveryEntry> {
  const common = {
    attemptTokenDigest: await sha256Hex(submission.attemptToken),
    transport: submission.transport,
    ...(isBoundedIdentifier(submission.workerId) ? { workerId: submission.workerId } : {}),
    submittedStatus: submission.submittedStatus,
    receivedAt: Date.now(),
  };
  if (answer.outcome === 'acknowledged') {
    return {
      ...common,
      outcome: 'acknowledged',
      disposition: answer.disposition,
      ...(answer.oversizedPayload === true ? { oversizedPayload: true as const } : {}),
    };
  }
  const redacted =
    submission.attemptToken === ''
      ? answer.reason
      : answer.reason.replaceAll(submission.attemptToken, REDACTED_ATTEMPT_TOKEN);
  return {
    ...common,
    outcome: 'rejected',
    rejectionCode: answer.rejectionCode,
    reason: boundTaskResultDeliveryReason(redacted),
  };
}

function dispatchDeliveryEvent(
  options: ServeOptions,
  operationId: string,
  rawLedger: Uint8Array,
  entry: TaskResultDeliveryEntry,
): void {
  if (entry.outcome === 'acknowledged' && entry.disposition === 'applied') return;
  const record = decodeRemoteTaskRecord(rawLedger);
  if (record === null) return;
  options.engine.dispatchEvent(
    new TaskResultDeliveryEvent({
      operationId,
      workflowId: record.workflowId,
      activityName: record.activityName,
      queue: record.queue,
      workerId: entry.workerId,
      transport: entry.transport,
      attemptTokenDigest: entry.attemptTokenDigest,
      outcome: entry.outcome,
      ...(entry.outcome === 'acknowledged'
        ? { disposition: entry.disposition === 'applied' ? undefined : entry.disposition }
        : { rejectionCode: entry.rejectionCode }),
    }),
  );
}

async function appendFenced(
  storage: Storage,
  operationId: string,
  entry: TaskResultDeliveryEntry,
): Promise<Uint8Array | null> {
  const ledgerKey = taskLedgerKey(operationId);
  const historyKey = taskResultDeliveryKey(operationId);
  for (let attempt = 1; attempt <= RECORD_MAX_ATTEMPTS; attempt++) {
    const rawLedger = await storage.get(ledgerKey);
    if (rawLedger === null) return null;
    const rawHistory = await storage.get(historyKey);
    const next = appendTaskResultDelivery(
      decodeTaskResultDeliveryHistory(rawHistory),
      operationId,
      entry,
    );
    const committed = await storageConditionalBatch(
      storage,
      [
        { key: ledgerKey, expectedValue: rawLedger },
        { key: historyKey, expectedValue: rawHistory },
      ],
      [{ type: 'put', key: historyKey, value: encodeTaskResultDeliveryHistory(next) }],
    );
    if (committed) return rawLedger;
  }
  throw new Error(`lost the compare-and-swap race after ${String(RECORD_MAX_ATTEMPTS)} attempt(s)`);
}

/**
 * Append one answered submission to its operation's delivery history. Never
 * throws: see this module's "Best effort" note.
 */
export async function recordTaskResultDelivery(
  options: ServeOptions,
  submission: TaskResultDeliverySubmission,
  answer: TaskResultDeliveryAnswer,
): Promise<void> {
  if (!isRecordableAnswer(answer)) return;
  try {
    const entry = await buildEntry(submission, answer);
    const rawLedger = await appendFenced(options.engine.storage, submission.operationId, entry);
    if (rawLedger !== null) {
      dispatchDeliveryEvent(options, submission.operationId, rawLedger, entry);
    }
  } catch (error) {
    console.error(
      `[weft] Failed to record task result delivery for "${submission.operationId}":`,
      error,
    );
  }
}
