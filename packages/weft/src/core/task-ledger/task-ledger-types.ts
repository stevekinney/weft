/**
 * The canonical durable remote task ledger type union (WFT-25).
 *
 * Replaces the fragmented `op:queued:` / `op:inflight:` / `op:resolved:` /
 * `op:dead-letter:` records in `task-state.ts` with one authoritative current
 * state per operation. Every transition between these states proves the
 * expected prior state and attempt identity through `storage.conditionalBatch`
 * — see `task-ledger-transitions.ts` for the pure precondition functions that
 * decide whether a transition is legal.
 *
 * This module defines the record shapes only. It does not read or write
 * storage, and it is not wired into the live dispatch path — `TaskQueue`,
 * `WorkerRegistry`, and the WebSocket/long-poll task handlers keep using
 * `task-state.ts` until "Queue and Claim Coordinator" (WFT-22), the project
 * slice that owns replacing that memory authority, lands.
 *
 * @module server/task-ledger-types
 */

import type { WorkerExecutionIdentity } from '../../worker/manifest/types.ts';
import type { JSONValue } from '../json.ts';
import type { RetryPolicy } from '../types.ts';

// ---------------------------------------------------------------------------
// Base envelope
// ---------------------------------------------------------------------------

/**
 * Fields common to every state a task record can occupy — the "complete
 * dispatch envelope" the project brief requires to survive queueing, lease,
 * retry, recovery, resolution, and dead letter.
 *
 * `workflowId` is optional, diverging from the project brief's literal
 * `workflowId: string`. `TaskDispatch.workflowId` (`server/index.ts`) and
 * every existing task record (`QueuedRecord`, `InflightRecord` in
 * `task-state.ts`) already treat it as optional, and `serve-internals.ts`'s
 * `rebuildWorkflowIndex` has a real, non-test code path that tolerates a
 * restored in-flight record with no `workflowId`. Making it required here
 * would silently break that existing, exercised behavior.
 *
 * `workflowExecutionToken` is optional for the same reason: the public
 * `TaskDispatch.workflowExecutionToken` (`server/index.ts`) is already
 * `string | undefined` for standalone remote-activity dispatch outside any
 * durable workflow run, and every other declaration of this field in the
 * codebase (`task-state.ts`, `task-queue-types.ts`, the core execution
 * strategies) is optional too. Absence means "not workflow-bound" and must
 * never be defaulted to an empty string — this field is documented
 * elsewhere as an external write fence, so a shared `''` sentinel would let
 * unrelated standalone tasks appear to hold the same fence.
 */
export type RemoteTaskBase = Readonly<{
  recordVersion: 1;
  operationId: string;
  workflowId?: string;
  workflowType: string;
  workflowExecutionToken?: string;
  /**
   * The dispatching workflow run's persisted revision (WFT-20), when the
   * `TaskDispatch` caller supplied one. Same optionality rationale as
   * `workflowExecutionToken` above — NOT the same field as
   * `executionRequirement.workflowRevision` (a client-declared routing
   * constraint carried by `WorkerExecutionRequirementInput`, unrelated to
   * this plain wire echo/validation field).
   */
  workflowRevision?: string;
  activityName: string;
  queue: string;
  input: JSONValue;
  headers: Readonly<Record<string, string>>;
  priority?: number;
  fairShareKey?: string;
  /** Preferred worker-affinity routing hint, derived from `sticky ? workflowId : undefined` at dispatch time. */
  stickyWorkflowId?: string;
  visibilityTimeoutMilliseconds: number;
  retryPolicy?: RetryPolicy;
  scheduleToCloseDeadline?: number;
  executionRequirement?: WorkerExecutionRequirementInput;
  createdAt: number;
  /** Monotonic counter incremented on every transition. Diagnostic/provenance surface — `conditionalBatch`'s whole-record byte equality is what actually enforces the CAS, but the precondition functions still check `generation` explicitly because it is the documented contract. */
  generation: number;
}>;

/**
 * Local alias for the manifest project's `WorkerExecutionRequirement` — kept
 * as a named alias (rather than importing it directly into every downstream
 * signature) so this module has one place documenting that the ledger reuses
 * WFT-26's routing-input vocabulary rather than defining its own.
 */
export type WorkerExecutionRequirementInput = Readonly<{
  deploymentName?: string;
  buildId?: string;
  artifactDigest?: string;
  workflowRevision?: string;
  activityContractHash?: string;
}>;

/**
 * Retry/requeue provenance carried by every non-terminal state so it survives
 * a lease → requeue → re-lease cycle intact — matching the existing
 * `TaskLifecycleFields.retryCount` / `requeueCount` semantics in
 * `task-state.ts` (`reassignOrExpireTask`'s `nextRetryCount` /
 * `requeueCount + 1` computation), which this ledger's requeue transition
 * reproduces.
 */
export type RemoteTaskAttemptFields = Readonly<{
  retryCount: number;
  requeueCount: number;
  lastRequeueReason?: string;
}>;

// ---------------------------------------------------------------------------
// Queued
// ---------------------------------------------------------------------------

export type RemoteTaskQueued = RemoteTaskBase &
  RemoteTaskAttemptFields &
  Readonly<{
    state: 'queued';
    attempt: number;
    /** Delayed retries are represented here, not by a process timer — `Queued` includes work delayed until `availableAt`. */
    availableAt: number;
    firstQueuedAt: number;
    lastQueuedAt: number;
    lastDispatchedAt?: number;
    /** First time any attempt of this operation began executing. Absent until the first claim; preserved across requeues. */
    startedAt?: number;
  }>;

// ---------------------------------------------------------------------------
// Leased
// ---------------------------------------------------------------------------

export type RemoteTaskLeased = RemoteTaskBase &
  RemoteTaskAttemptFields &
  Readonly<{
    state: 'leased';
    attemptToken: string;
    /**
     * Identifies the live worker connection/session holding the lease,
     * distinct from `executionIdentity.workerId` (the durable identity of
     * the worker *process*). No durable session concept exists in the
     * codebase today — `WorkerRegistry`'s grace-period reconnect logic
     * deliberately preserves in-flight ownership across sockets under one
     * `workerId`. This field exists so a later slice (WFT-22) can decide
     * whether lease renewal survives reconnect; that policy is out of this
     * slice's scope.
     */
    workerSessionId: string;
    /**
     * Complete observed identity of the worker holding the lease — see
     * `WorkerExecutionIdentity` in `worker/manifest/types.ts`. Optional
     * because `buildWorkerExecutionIdentity` returns `undefined` whenever the
     * claiming worker has no registered manifest entry for this
     * workflowType/activityName pair — which is the *only* case for every
     * long-poll claim (long-poll workers never call `WorkerRegistry.register`,
     * so they never have a manifest) and can also occur for a WebSocket
     * worker whose manifest doesn't cover the dispatched activity. Absence
     * here means "no verifiable provenance was available at claim time," not
     * "provenance was skipped" — nothing fabricates a placeholder identity.
     */
    executionIdentity?: WorkerExecutionIdentity;
    attempt: number;
    leaseDeadline: number;
    /**
     * Absolute deadline for this attempt (COR-230), set once at
     * {@link claimQueued} time from `ATTEMPT_DEADLINE_MULTIPLIER *
     * leaseDurationMilliseconds` and carried unchanged through every later
     * transition of this same attempt (`renewAttemptLease`,
     * `beginCompletion`, `recordCancellationIntent`'s leased-origin branch —
     * see `pickLeaseHolderFields`). Distinct from `leaseDeadline`: a
     * heartbeat (session or activity) can renew `leaseDeadline` up to, but
     * never past, this value — see `renewAttemptLease`'s doc comment.
     * Optional so the many hand-built fixtures in this module's tests need
     * not supply one; a `renewAttemptLease` call against a record without it
     * treats the cap as unbounded rather than rejecting.
     */
    attemptDeadline?: number;
    firstQueuedAt: number;
    lastQueuedAt: number;
    startedAt: number;
    lastHeartbeatAt: number;
  }>;

// ---------------------------------------------------------------------------
// Completing
// ---------------------------------------------------------------------------

export type RemoteTaskCompleting = RemoteTaskBase &
  RemoteTaskAttemptFields &
  Readonly<{
    state: 'completing';
    attemptToken: string;
    workerSessionId: string;
    executionIdentity?: WorkerExecutionIdentity;
    attempt: number;
    leaseDeadline: number;
    /** Carried over unchanged from the `Leased` record — see `RemoteTaskLeased.attemptDeadline`'s doc comment. */
    attemptDeadline?: number;
    firstQueuedAt: number;
    lastQueuedAt: number;
    startedAt: number;
    lastHeartbeatAt: number;
    pendingStatus: 'completed' | 'failed';
    /** Digest of the pending result, matched by "Commit terminal result" before it is applied. */
    pendingResultDigest: string;
  }>;

// ---------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------

export type RemoteTaskCancelling = RemoteTaskBase &
  RemoteTaskAttemptFields &
  Readonly<{
    state: 'cancelling';
    /**
     * Always present. Per the state diagram, `Cancelling` is reached only
     * from `Leased` (`Leased --> Cancelling: cancellation intent`) — a
     * cancellation recorded while a task is still `Queued` transitions
     * directly to `Terminal` (disposition `cancelled`, no attempt ever
     * existed) without passing through this state. The brief's transition
     * table phrase "attempt token matches when one exists" describes that
     * generic precondition-checking function across both origins; this
     * type only represents the leased-origin case.
     */
    attemptToken: string;
    workerSessionId: string;
    executionIdentity?: WorkerExecutionIdentity;
    attempt: number;
    leaseDeadline: number;
    /** Carried over unchanged from the `Leased` record — see `RemoteTaskLeased.attemptDeadline`'s doc comment. */
    attemptDeadline?: number;
    firstQueuedAt: number;
    lastQueuedAt: number;
    startedAt: number;
    lastHeartbeatAt: number;
    cancellationReason: string;
    cancellationRequestedAt: number;
    /**
     * Absolute deadline (COR-230, acceptance criterion 15) by which a
     * worker's cooperative `taskResult` (`status: "cancelled"`) must arrive
     * once cancellation intent is recorded. Set by `recordCancellationIntent`
     * from the caller-supplied cancellation grace period. `scanExpiredTasks`
     * (`task-reconciliation.ts`) settles the attempt as cancelled anyway once
     * this passes with no cooperative result — see
     * `RemoteTaskTerminalCancelled.uncertain`.
     */
    cancellationDeadline: number;
  }>;

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

/** Which lineage produced a terminal record. Every lineage carries `resultDigest` so "Mark workflow result adopted" can match uniformly regardless of disposition. */
export type RemoteTaskTerminalDisposition = 'resolved' | 'cancelled' | 'retryExhausted';

type RemoteTaskTerminalCommon = RemoteTaskBase &
  Readonly<{
    state: 'terminal';
    attempt: number;
    resultDigest: string;
    terminalAt: number;
    adopted: boolean;
    adoptedAt?: number;
    /** Matched by "Delete retained terminal task"; incremented if a record is re-terminalized (e.g. adoption retried after a partial cleanup). */
    retentionGeneration: number;
  }>;

export type RemoteTaskTerminalResolved = RemoteTaskTerminalCommon &
  Readonly<{
    disposition: 'resolved';
    attemptToken: string;
    status: 'completed' | 'failed';
    error?: string;
  }>;

export type RemoteTaskTerminalCancelled = RemoteTaskTerminalCommon &
  Readonly<{
    disposition: 'cancelled';
    /** Present when cancelled mid-attempt (via `Cancelling`); absent when cancelled directly from `Queued`. */
    attemptToken?: string;
    cancellationReason: string;
    /**
     * Present and `true` only when this cancellation settled because
     * `RemoteTaskCancelling.cancellationDeadline` passed with no cooperative
     * `taskResult` from the worker (COR-230, acceptance criterion 15) — a
     * non-cooperative, forced settlement committed by
     * `commitUncertainCancellation`. Absent (never `false`) for every other
     * cancelled disposition, including the ordinary case where the worker's
     * own `taskResult(status: "cancelled")` won the race. Distinct from a
     * generic failure: the terminal disposition here is still `'cancelled'`,
     * not `'resolved'` with a synthesized error, and callers that branch on
     * disposition (`get-task-detail.ts`, the client) can tell "the server
     * gave up waiting for confirmation" apart from "the activity itself
     * reported failure" without inferring it from `cancellationReason` text.
     */
    uncertain?: true;
  }>;

export type RemoteTaskTerminalRetryExhausted = RemoteTaskTerminalCommon &
  Readonly<{
    disposition: 'retryExhausted';
    attemptToken: string;
    error: string;
  }>;

export type RemoteTaskTerminal =
  RemoteTaskTerminalResolved | RemoteTaskTerminalCancelled | RemoteTaskTerminalRetryExhausted;

// ---------------------------------------------------------------------------
// Dead-lettered
// ---------------------------------------------------------------------------

export type RemoteTaskDeadLettered = RemoteTaskBase &
  RemoteTaskAttemptFields &
  Readonly<{
    state: 'deadLettered';
    attemptToken: string;
    attempt: number;
    pendingStatus: 'completed' | 'failed';
    pendingResultDigest: string;
    value?: JSONValue;
    error?: string;
    deadLetteredAt: number;
    persistenceFailureReason: string;
  }>;

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

export type RemoteTaskRecord =
  | RemoteTaskQueued
  | RemoteTaskLeased
  | RemoteTaskCompleting
  | RemoteTaskCancelling
  | RemoteTaskTerminal
  | RemoteTaskDeadLettered;

export const REMOTE_TASK_RECORD_VERSION = 1;

// ---------------------------------------------------------------------------
// Attempt lease view (COR-230)
// ---------------------------------------------------------------------------

/**
 * A read-only projection of one attempt's two lease-governed clocks —
 * `leaseDeadline` (heartbeat-renewable) and `attemptDeadline`
 * (heartbeat-immune) — plus the identity a heartbeat or completion must
 * match to touch it. Distinct from `WorkerSessionIdentity`
 * (`worker/registry/types.ts`): a `WorkerSessionIdentity` identifies a
 * worker's CONNECTION, independent of any task; an `ActivityAttemptLease`
 * identifies one ATTEMPT of one operation, fenced by `attemptToken`
 * independently of which session currently holds it. Projected from
 * `RemoteTaskLeased` by {@link activityAttemptLeaseFromRecord} — the only
 * state an activity heartbeat may renew (see `renewAttemptLease`'s
 * precondition).
 */
export interface ActivityAttemptLease {
  readonly operationId: string;
  readonly attemptToken: string;
  readonly workerSessionId: string;
  readonly leaseDeadline: number;
  readonly attemptDeadline?: number;
}

/**
 * `ActivityAttemptLease` view of a durable ledger record, or `undefined`
 * when the record is missing or not currently `leased` — every other state
 * (`queued`, `completing`, `cancelling`, terminal, dead-lettered) has either
 * no attempt yet or no attempt left to heartbeat.
 */
export function activityAttemptLeaseFromRecord(
  record: RemoteTaskRecord | null,
): ActivityAttemptLease | undefined {
  if (record === null || record.state !== 'leased') return undefined;
  return {
    operationId: record.operationId,
    attemptToken: record.attemptToken,
    workerSessionId: record.workerSessionId,
    leaseDeadline: record.leaseDeadline,
    ...(record.attemptDeadline !== undefined ? { attemptDeadline: record.attemptDeadline } : {}),
  };
}
