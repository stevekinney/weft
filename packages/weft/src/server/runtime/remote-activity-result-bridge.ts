/**
 * Delivers a resolved remote-worker task result into a workflow's parked
 * `ctx.run()` operation (COR-152).
 *
 * **Durability (acceptance criterion 6).** The durable task ledger's
 * terminal record only ever carries a `resultDigest`
 * (`task-ledger-completion.ts`'s module doc comment) — never the real
 * value/error. Correctness therefore does NOT depend on this module running
 * before a crash: {@link buildTerminalResolutionWrites} builds the same
 * durable async-activity resolution record `completeAsyncActivity`/
 * `failAsyncActivity` themselves persist
 * (`core/engine/async-activity-records.ts`'s `buildAsyncActivityResolutionWrite`),
 * and every terminal-producing ledger transition — completion,
 * retry-exhaustion, and both cancellation paths — co-commits it in the SAME
 * `conditionalBatch` as the ledger transition itself (see
 * `task-ledger-completion.ts`, `task-reconciliation.ts`, and `task-dispatch.ts`'s
 * `cancelTask`). A crash strictly between the ledger commit and this
 * bridge's call therefore never loses the value: on recovery,
 * `recoverPendingAsyncActivities` reloads the resolution record and queues
 * it, and replay re-parking on the same deterministic token adopts it — the
 * exact mechanism an application's own `ctx.completeAsync()` callback
 * already relies on for the identical crash window.
 *
 * This module's `bridgeRemoteActivityResult` remains the LATENCY path: it
 * calls `engine.completeAsyncActivity`/`failAsyncActivity` immediately so a
 * live, in-process engine resumes the workflow without waiting for a future
 * `recoverAll()`. Gated by `isPendingAsyncActivityToken` (a live in-memory
 * check) so a standalone `WeftServer.dispatchTask` task with no workflow
 * behind it is untouched, exactly as before COR-152.
 *
 * @module server/runtime/remote-activity-result-bridge
 */

import type { RegistryAgnosticEngine } from '../../core/engine.ts';
import { buildAsyncActivityResolutionWrite } from '../../core/engine/async-activity-records.ts';
import { isPendingAsyncActivityToken } from '../../core/engine/pending-async-activity-token.ts';
import type { OperationOutcome } from '../../core/types.ts';
import type { BatchOperation } from '../../storage/interface.ts';

export type RemoteActivityResultOutcome =
  Readonly<{ status: 'completed'; value: unknown }> | Readonly<{ status: 'failed'; error: string }>;

/**
 * Build the extra batch operation(s) a terminal-producing ledger transition
 * must co-commit, in the SAME `conditionalBatch`, to durably carry the real
 * outcome for whichever workflow's `ctx.run()` this `operationId` belongs
 * to. Gated ONLY on `workflowId` being present on the record — not on
 * `isPendingAsyncActivityToken` — because the process committing the
 * terminal transition may not be (and after a crash, is never) the process
 * that holds the in-memory pending-token entry; the durable ledger and the
 * durable async-activity keyspace must agree independent of any one
 * process's live state.
 *
 * Safe to call unconditionally for a `workflowId`-carrying standalone
 * `dispatchTask` call with no matching `ctx.run()` token: the resulting
 * resolution record is a harmless orphan under that workflow's
 * `async-act:v1:` prefix — nothing ever derives that exact token to take
 * it, and normal terminal cleanup (`cleanupTerminalWorkflowDurableState`
 * sweeping `asyncActivityWorkflowPrefix`) removes it once the workflow
 * itself terminates.
 */
export function buildTerminalResolutionWrites(
  workflowId: string | undefined,
  operationId: string,
  outcome: OperationOutcome,
): readonly BatchOperation[] {
  if (workflowId === undefined) return [];
  return [buildAsyncActivityResolutionWrite(workflowId, operationId, outcome)];
}

/**
 * Deliver a resolved remote task's real value/error to the workflow parked
 * on it, if any, for immediate (same-process) resumption. A no-op (not an
 * error) when `operationId` is not currently a pending async-activity token
 * — either it is a standalone task with no workflow behind it, or (a
 * legitimate race) the token was already consumed by a concurrent delivery.
 */
export async function bridgeRemoteActivityResult(
  engine: RegistryAgnosticEngine,
  operationId: string,
  outcome: RemoteActivityResultOutcome,
): Promise<void> {
  if (!isPendingAsyncActivityToken(engine, operationId)) return;

  try {
    if (outcome.status === 'completed') {
      await engine.completeAsyncActivity(operationId, outcome.value);
    } else {
      await engine.failAsyncActivity(operationId, new Error(outcome.error));
    }
  } catch (error) {
    // `AsyncActivityTokenNotFoundError` (or any other rejection) means the
    // token was consumed between the check above and this call — a
    // legitimate race with a concurrent delivery of the SAME already-durable
    // result, not a lost outcome. Log and continue; the ledger's own
    // idempotent-resubmission handling already proved this result durable,
    // and the co-committed resolution record (above) already carries it.
    console.error(
      `[weft] Remote activity result bridge could not deliver operation "${operationId}" to its parked workflow:`,
      error,
    );
  }
}
