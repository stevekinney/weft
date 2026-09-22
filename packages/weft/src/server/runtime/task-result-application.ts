/**
 * Single result-application implementation shared by the WebSocket
 * (`onTaskResultMessage`, `websocket-worker.ts`) and HTTP long-poll
 * (`applyTaskResult`/`handleTaskResultRequest`, `task-polling.ts`)
 * completion paths (COR-240, acceptance criterion 12).
 *
 * Both transports authorize a `taskResult` differently before reaching this
 * point — the WebSocket path through `WorkerRegistry` ownership/attempt
 * checks, long-poll through a direct read of the durable ledger record — and
 * each keeps its own transport-specific bookkeeping around the call
 * (`WorkerRegistry.completeTask`/`cleanupWorkflowIndex`/capacity metric for
 * WebSocket; `TaskQueue.complete`/backlog metric for long-poll, and never for
 * a dead-lettered result on either transport). What both transports do
 * identically — commit through {@link commitTaskLedgerCompletion}, record the
 * execution-latency metric exactly once (only for a first-time `applied`
 * commit, never for a `duplicate` or a `dead-lettered` resend), and dispatch
 * {@link TaskResultDeadLetteredEvent} when the ledger dead-letters the result
 * — lives here.
 *
 * @module server/runtime/task-result-application
 */

import type { MetricsCollector } from '../../observability/metrics.ts';
import type { ServeOptions } from '../index.ts';
import { bridgeRemoteActivityResult } from './remote-activity-result-bridge.ts';
import {
  commitTaskLedgerCompletion,
  dispatchTaskDeadLetteredEvent,
  type TaskLedgerCompletionInput,
  type TaskResultDisposition,
} from './task-ledger-completion.ts';
import { recordTaskExecutionLatencyMetric } from './task-metrics.ts';

export type TaskResultApplicationResult =
  | Readonly<{ ok: true; disposition: TaskResultDisposition }>
  | Readonly<{ ok: false; reason: string }>;

/**
 * COR-152: deliver the real value/error a worker just sent to whichever
 * workflow's `ctx.run()` is parked on this `operationId`, if any — see
 * `remote-activity-result-bridge.ts`'s module doc comment. Only reached for
 * a genuinely FRESH `applied`/`resolved` commit; a `duplicate` resend (the
 * outcome was already delivered by the first delivery) and a
 * `dead-lettered` result (nothing to deliver) are both skipped.
 */
async function bridgeIfResolvedApplied(
  options: ServeOptions,
  input: TaskLedgerCompletionInput,
  committed: Awaited<ReturnType<typeof commitTaskLedgerCompletion>>,
): Promise<void> {
  if (!committed.ok || committed.disposition !== 'applied') return;
  if (committed.terminal?.disposition !== 'resolved') return;
  await bridgeRemoteActivityResult(
    options.engine,
    input.operationId,
    committed.terminal.status === 'completed'
      ? { status: 'completed', value: input.value }
      : { status: 'failed', error: committed.terminal.error ?? 'Remote activity failed' },
  );
}

/**
 * Apply an already-authorized task result through the durable ledger.
 *
 * A ledger-level "dead-lettered" outcome — whether from a fresh persistence
 * failure or an idempotent resend of a previously dead-lettered attempt —
 * is reported here as `ok: true` with disposition `'dead-lettered'`: the
 * *submission* succeeded in the sense that the caller now has a definitive,
 * ack-worthy answer, even though the result itself was not durably resolved
 * as `completed`/`failed`. `ok: false` is reserved for the hard rejections
 * `commitTaskLedgerCompletion` never turns into an ack — unknown operation,
 * stale attempt, conflicting content under one attempt token, or a
 * queued/newer attempt already in progress — which callers surface as
 * `protocolError` (WebSocket) or `403` (long-poll), exactly as before v4.
 */
export async function applyWorkerTaskResult(
  options: ServeOptions,
  metricsCollector: MetricsCollector | undefined,
  input: TaskLedgerCompletionInput,
  workerId: string | undefined,
): Promise<TaskResultApplicationResult> {
  const committed = await commitTaskLedgerCompletion(options.engine.storage, input);

  if (committed.ok) {
    if (committed.disposition === 'applied' && committed.completing !== undefined) {
      recordTaskExecutionLatencyMetric(
        metricsCollector,
        { startedAt: committed.completing.startedAt },
        Date.now(),
      );
    }
    await bridgeIfResolvedApplied(options, input, committed);
    return { ok: true, disposition: committed.disposition };
  }

  if (committed.deadLettered !== undefined) {
    dispatchTaskDeadLetteredEvent(options, input.operationId, committed.deadLettered, workerId);
    return { ok: true, disposition: 'dead-lettered' };
  }

  return { ok: false, reason: committed.reason };
}
