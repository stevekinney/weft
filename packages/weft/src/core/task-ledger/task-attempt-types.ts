/**
 * Canonical per-attempt provenance record for the durable remote task ledger
 * (COR-205, "Canonical Provenance Types").
 *
 * `RemoteTaskRecord` (`task-ledger-types.ts`) holds exactly ONE current-state
 * record per `operationId` — every transition overwrites it in place. That is
 * correct for deciding what to do next, but it means an attempt's identity is
 * gone the instant a newer attempt (a retry, a requeue, a different worker or
 * build) supersedes it: only the counters (`retryCount`/`requeueCount`) and
 * the *latest* `executionIdentity` survive. A `TaskAttemptRecord` is the
 * durable, append-only history WFT-25 deliberately left out of scope —
 * exactly what acceptance criterion 9 needs ("a retry across builds displays
 * both attempt identities") and what criterion 6 needs ("resolved and
 * dead-lettered tasks remain attributable after worker disconnect and server
 * restart", independent of whatever the in-memory registry currently
 * believes).
 *
 * **Key.** `(operationId, attemptTokenDigest)` — never the bare `attempt`
 * number. The project brief is explicit about why: "the attempt number alone
 * is not safe under every recovery race" — a requeue, an unproven reconnect
 * forfeit, and startup recovery can all observe or produce the same `attempt`
 * value through different code paths, but never the same `attemptToken`
 * (`crypto.randomUUID()`, minted fresh at every claim). Keying by the token's
 * digest instead makes every legitimate write target an unambiguous slot and
 * makes a colliding write structurally impossible.
 *
 * **Never the raw token.** `attemptTokenDigest` is `sha256Hex(attemptToken)`
 * (`worker/manifest/content-digest.ts`) — the fencing secret itself is never
 * written here (acceptance criteria 8 and 10). Every runtime call site that
 * builds one of these records receives the digest, never the token, from
 * `server/runtime/task-attempt-runtime.ts`.
 *
 * **What it does NOT carry** (criterion 8): no `input`, no `headers`, no raw
 * `attemptToken`. `executionIdentity` and `executionRequirement` reuse the
 * exact same types `RemoteTaskRecord` already carries — see
 * `task-ledger-types.ts`'s `WorkerExecutionRequirementInput` and
 * `worker/manifest/types.ts`'s `WorkerExecutionIdentity` — rather than a
 * second, drifting provenance shape (criterion 14).
 *
 * @module server/task-attempt-types
 */

import type { WorkerExecutionIdentity } from '../../worker/manifest/types.ts';
import type { WorkerExecutionRequirementInput } from './task-ledger-types.ts';

export const TASK_ATTEMPT_RECORD_VERSION = 1;

/**
 * How an attempt's durable history entry currently stands. `'leased'` is the
 * only non-final value — every other disposition means some later event
 * (a requeue, a cooperative or forced cancellation, an ordinary result, a
 * dead letter, or retry exhaustion) has already superseded this specific
 * attempt. An attempt record's disposition, once moved off `'leased'`, never
 * moves again — each `(operationId, attemptTokenDigest)` pair is claimed
 * exactly once (criterion 2: a failed or conflicting claim never produces one
 * at all) and resolved exactly once.
 */
export type TaskAttemptDisposition =
  'leased' | 'requeued' | 'retryExhausted' | 'resolved' | 'cancelled' | 'deadLettered';

/**
 * Durable per-attempt provenance history entry (COR-205). One record per
 * successful claim — see this module's doc comment for why a failed or
 * conflicting claim never produces one (criterion 2), and why the key is
 * `(operationId, attemptTokenDigest)` rather than `(operationId, attempt)`.
 */
export type TaskAttemptRecord = Readonly<{
  recordVersion: 1;
  operationId: string;
  /**
   * The owning ledger record's authoritative attempt counter at claim time
   * (`RemoteTaskLeased.attempt`) — criterion 4: provenance rides on the
   * ledger's own counter, never a second, independently mutable one.
   */
  attempt: number;
  /** `sha256Hex(attemptToken)` — see this module's doc comment. Never the raw token. */
  attemptTokenDigest: string;
  /** The worker session (WebSocket `workerId`, or a long-poll synthetic session id) that claimed this attempt. */
  workerSessionId: string;
  /**
   * The claiming WebSocket worker's session generation at claim time
   * (`WorkerSessionIdentity.sessionGeneration`, `worker/registry/types.ts`),
   * when known. Provenance only (criterion 7) — recorded for audit, never
   * compared as a fence; see `task-result-authorization.ts`'s doc comment for
   * why attempt-token fencing alone, not a generation comparison, is what
   * actually protects a stale attempt from writing heartbeat/cancellation
   * evidence. Absent for a long-poll claim, which has no session generation.
   */
  sessionGeneration?: number;
  /**
   * The worker that actually claimed this attempt, when a manifest was
   * available to build one (criterion 1, 9) — absent under the exact same
   * condition `RemoteTaskLeased.executionIdentity` is absent (see that
   * field's doc comment in `task-ledger-types.ts`).
   */
  executionIdentity?: WorkerExecutionIdentity;
  /**
   * The routing requirement declared at dispatch time, copied from the
   * owning `RemoteTaskBase.executionRequirement` at claim time (criterion 3:
   * the *declared* routing constraint, preserved separately from
   * `executionIdentity`, the worker that *actually* executed the attempt).
   */
  executionRequirement?: WorkerExecutionRequirementInput;
  claimedAt: number;
  disposition: TaskAttemptDisposition;
  dispositionAt: number;
  /** Requeue reason, cancellation reason, error text, or persistence-failure reason — whichever produced `disposition`. Bounded like every other free-text ledger reason. */
  dispositionReason?: string;
  /** Last activity-heartbeat renewal observed for this attempt, when any arrived before it settled. */
  lastHeartbeatAt?: number;
}>;
