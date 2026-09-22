/**
 * TypeScript wire-shape declarations for the RemoteWorker WebSocket protocol.
 *
 * These types mirror the JSON Schema documents in `./protocol-schemas.ts`
 * field-for-field. The runtime parser guards in `./protocol.ts` enforce the
 * shapes described here at the trust boundary. They are re-exported from
 * `@lostgradient/weft` (via `./protocol.ts`) so the public surface remains
 * a single import path.
 *
 * @module worker/protocol-messages
 */

import type { RemoteWorkerProtocolVersion } from './protocol-version.ts';

/**
 * JSON value carried over the worker protocol.
 *
 * @example
 * ```ts
 * import type { RemoteWorkerJsonValue } from '@lostgradient/weft';
 *
 * const payload: RemoteWorkerJsonValue = { amount: 42, memo: null };
 * ```
 */
export type RemoteWorkerJsonValue =
  | null
  | boolean
  | number
  | string
  | RemoteWorkerJsonValue[]
  | { [key: string]: RemoteWorkerJsonValue };

/**
 * Optional capabilities advertised by a RemoteWorker at registration time.
 *
 * @example
 * ```ts
 * import type { RemoteWorkerCapabilities } from '@lostgradient/weft';
 *
 * const capabilities: RemoteWorkerCapabilities = { region: 'us-west', gpu: false };
 * ```
 */
export type RemoteWorkerCapabilities = Readonly<Record<string, RemoteWorkerJsonValue>>;

/**
 * Worker registration message sent immediately after opening a worker stream.
 *
 * Protocol v3 replaced the parallel top-level identity fields
 * (`activities`, `queue`, `deploymentName`, `buildId`, `runtimeVersion`,
 * `gitSha`, `capabilities`) with a single `manifest`. The server derives
 * routing activities from `manifest.workflows`, reads the queue from the
 * worker-stream URL rather than a field a worker could disagree with, and
 * validates every other identity claim through `parseWorkerManifest()`.
 * `manifest` is `unknown` here deliberately — this module only proves wire
 * shape; deep manifest validation happens where the manifest is accepted.
 *
 * `resumeSessionGeneration` (protocol v6, COR-220) is how a reconnecting
 * worker PROVES it is resuming its own prior session rather than merely
 * asserting the same `workerId`: it echoes the `sessionGeneration` the
 * server handed back on the `registerAck` for the session it is trying to
 * resume. Omitted on a fresh connect — there is no prior session to prove
 * continuity with. The server treats a reconnect as a PROVEN resume only
 * when this echo matches the still-pending session's generation; anything
 * else (omitted, or mismatched) is an unproven reconnect and forfeits
 * in-flight work exactly as an unanswered grace period would.
 *
 * @example
 * ```ts
 * import type { RegisterMessage } from '@lostgradient/weft';
 *
 * const message: RegisterMessage = {
 *   type: 'register',
 *   protocolVersion: 6,
 *   workerId: 'worker-1',
 *   manifest: { manifestVersion: 1 },
 * };
 * ```
 */
export type RegisterMessage = {
  readonly type: 'register';
  readonly protocolVersion: RemoteWorkerProtocolVersion;
  readonly workerId: string;
  readonly manifest: unknown;
  readonly concurrency?: number;
  readonly startedAt?: number;
  readonly resumeSessionGeneration?: number;
};

/**
 * Worker heartbeat message.
 *
 * @example
 * ```ts
 * import type { HeartbeatMessage } from '@lostgradient/weft';
 *
 * const message: HeartbeatMessage = { type: 'heartbeat', workerId: 'worker-1' };
 * ```
 */
export type HeartbeatMessage = {
  readonly type: 'heartbeat';
  readonly workerId: string;
};

/**
 * Per-attempt worker heartbeat (COR-230, protocol v5).
 *
 * Distinct from {@link HeartbeatMessage}: a bare `heartbeat` renews only the
 * worker-SESSION lease (`WorkerRegistry.heartbeat()`); `activityHeartbeat`
 * renews only the named attempt's heartbeat-extendable visibility deadline,
 * fenced by `operationId` + `attemptToken` through the same
 * `authorizeTaskResultForCurrentAttempt` identity check `taskResult` uses. A
 * worker sends one of these per in-flight long-running attempt, in addition
 * to (not instead of) its periodic session `heartbeat`. Renewal is capped by
 * the attempt's absolute deadline (`RemoteTaskLeased.attemptDeadline`),
 * which no heartbeat of either kind can extend.
 *
 * @example
 * ```ts
 * import type { ActivityHeartbeatMessage } from '@lostgradient/weft';
 *
 * const message: ActivityHeartbeatMessage = {
 *   type: 'activityHeartbeat',
 *   workerId: 'worker-1',
 *   operationId: 'op-1',
 *   attemptToken: 'attempt-token',
 * };
 * ```
 */
export type ActivityHeartbeatMessage = {
  readonly type: 'activityHeartbeat';
  readonly workerId: string;
  readonly operationId: string;
  readonly attemptToken: string;
};

/**
 * Successful activity result message.
 *
 * @example
 * ```ts
 * import type { CompletedTaskResultMessage } from '@lostgradient/weft';
 *
 * const message: CompletedTaskResultMessage = {
 *   type: 'taskResult',
 *   operationId: 'op-1',
 *   status: 'completed',
 *   value: null,
 *   attemptToken: 'attempt-token',
 * };
 * ```
 */
export type CompletedTaskResultMessage = {
  readonly type: 'taskResult';
  readonly operationId: string;
  readonly status: 'completed';
  readonly value: RemoteWorkerJsonValue;
  /** Required per-dispatch token echoed from the {@link TaskMessage}. */
  readonly attemptToken: string;
  /**
   * Echo of {@link TaskMessage.workflowRevision} (WFT-20), when the dispatch
   * carried one. Missing-or-mismatched echo authorization is transport-specific
   * — see `remote-worker-protocol.md`'s revision-staleness section.
   */
  readonly workflowRevision?: string;
};

/**
 * Failed activity result message.
 *
 * @example
 * ```ts
 * import type { FailedTaskResultMessage } from '@lostgradient/weft';
 *
 * const message: FailedTaskResultMessage = {
 *   type: 'taskResult',
 *   operationId: 'op-1',
 *   status: 'failed',
 *   error: 'SMTP rejected the message',
 *   attemptToken: 'attempt-token',
 * };
 * ```
 */
export type FailedTaskResultMessage = {
  readonly type: 'taskResult';
  readonly operationId: string;
  readonly status: 'failed';
  readonly error: string;
  /** Required per-dispatch token echoed from the {@link TaskMessage}. */
  readonly attemptToken: string;
  /** Echo of {@link TaskMessage.workflowRevision} (WFT-20) — see {@link CompletedTaskResultMessage.workflowRevision}. */
  readonly workflowRevision?: string;
};

/**
 * Cancelled activity result message.
 *
 * @example
 * ```ts
 * import type { CancelledTaskResultMessage } from '@lostgradient/weft';
 *
 * const message: CancelledTaskResultMessage = {
 *   type: 'taskResult',
 *   operationId: 'op-1',
 *   status: 'cancelled',
 *   error: 'Task cancelled',
 *   cancelled: true,
 *   attemptToken: 'attempt-token',
 * };
 * ```
 */
export type CancelledTaskResultMessage = {
  readonly type: 'taskResult';
  readonly operationId: string;
  readonly status: 'cancelled';
  readonly error: string;
  readonly cancelled?: true;
  /** Required per-dispatch token echoed from the {@link TaskMessage}. */
  readonly attemptToken: string;
  /** Echo of {@link TaskMessage.workflowRevision} (WFT-20) — see {@link CompletedTaskResultMessage.workflowRevision}. */
  readonly workflowRevision?: string;
};

/**
 * Registration acknowledgement sent after a worker is accepted.
 *
 * `acceptedManifestDigest` is the digest of the canonical manifest the server
 * actually stored — a worker can confirm the server saw the manifest it
 * intended to send. `serverCapabilities` replaces echoing `activities` back
 * (the worker already knows what it sent); it is a bounded list of
 * server-side capability names, currently always empty.
 *
 * `sessionGeneration` (protocol v6, COR-220) is the {@link
 * import('./registry/types.ts').WorkerSessionIdentity.sessionGeneration}
 * value for the session just registered — always present, unlike
 * {@link RegisterMessage.resumeSessionGeneration}, since every accepted
 * registration belongs to some generation whether it proved a resume or
 * not. A worker caches this value and echoes it back as
 * `resumeSessionGeneration` on its next `register` if that connection is
 * ever lost, so the server can tell a proven resume from a fresh session.
 *
 * @example
 * ```ts
 * import type { RegisterAckMessage } from '@lostgradient/weft';
 *
 * const message: RegisterAckMessage = {
 *   type: 'registerAck',
 *   protocolVersion: 6,
 *   workerId: 'worker-1',
 *   queue: 'default',
 *   concurrency: 10,
 *   acceptedManifestDigest: 'sha256:41d0e2',
 *   serverCapabilities: [],
 *   sessionGeneration: 1,
 * };
 * ```
 */
export type RegisterAckMessage = {
  readonly type: 'registerAck';
  readonly protocolVersion: RemoteWorkerProtocolVersion;
  readonly workerId: string;
  readonly queue: string;
  readonly concurrency: number;
  readonly acceptedManifestDigest: string;
  readonly serverCapabilities: readonly string[];
  readonly sessionGeneration: number;
};

/**
 * Registration rejection sent before closing an unsupported worker stream.
 *
 * `deployment_conflict` means the manifest's `(deploymentName, buildId)` pair
 * was already registered with a different `artifactDigest`.
 * `registration_rejected` means a configured `WorkerAdmissionPolicy` refused
 * the worker. `supportedProtocolVersions` describes the *other* peer's
 * supported versions — for a worker parsing a rejection from a server
 * running a different release, that is deliberately not narrowed to
 * `RemoteWorkerProtocolVersion`.
 *
 * @example
 * ```ts
 * import type { RegisterErrorMessage } from '@lostgradient/weft';
 *
 * const message: RegisterErrorMessage = {
 *   type: 'registerError',
 *   code: 'unsupported_protocol_version',
 *   message: 'Unsupported RemoteWorker protocol version: 1',
 *   supportedProtocolVersions: [4],
 *   requestedProtocolVersion: 1,
 * };
 * ```
 */
export type RegisterErrorMessage = {
  readonly type: 'registerError';
  readonly code:
    | 'invalid_registration'
    | 'unsupported_protocol_version'
    | 'deployment_conflict'
    | 'registration_rejected';
  readonly message: string;
  readonly supportedProtocolVersions: readonly number[];
  readonly requestedProtocolVersion?: number;
};

/**
 * Protocol-level error sent before closing a malformed worker stream.
 *
 * @example
 * ```ts
 * import type { ProtocolErrorMessage } from '@lostgradient/weft';
 *
 * const message: ProtocolErrorMessage = {
 *   type: 'protocolError',
 *   code: 'invalid_message',
 *   message: 'taskResult.operationId must be a non-empty string',
 * };
 * ```
 */
export type ProtocolErrorMessage = {
  readonly type: 'protocolError';
  readonly code:
    'invalid_json' | 'invalid_message' | 'unknown_message_type' | 'registration_required';
  readonly message: string;
};

/**
 * Activity task dispatched by the server.
 *
 * @example
 * ```ts
 * import type { TaskMessage } from '@lostgradient/weft';
 *
 * const message: TaskMessage = {
 *   type: 'task',
 *   operationId: 'op-1',
 *   activityName: 'sendEmail',
 *   input: { to: 'user@example.com' },
 *   attemptToken: '550e8400-e29b-41d4-a716-446655440000',
 * };
 * ```
 */
export type TaskMessage = {
  readonly type: 'task';
  readonly operationId: string;
  readonly activityName: string;
  readonly input: RemoteWorkerJsonValue;
  readonly attempt?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Durable token for the workflow run that launched this activity, when known. */
  readonly workflowExecutionToken?: string;
  /**
   * The dispatching workflow run's persisted revision (WFT-20), when known.
   * A worker echoes this back on the resulting `taskResult`; the server
   * rejects a completion whose echoed revision disagrees with the run's
   * persisted revision as stale.
   */
  readonly workflowRevision?: string;
  /** Unique, unguessable token identifying this dispatch attempt. */
  readonly attemptToken: string;
};

/**
 * Activity cancellation request sent by the server.
 *
 * `attemptToken` (COR-230) fences which attempt this cancellation targets —
 * the worker's `AbortController` lookup is keyed by `(operationId,
 * attemptToken)`, not `operationId` alone, so a `cancel` for an attempt the
 * worker has already completed or superseded matches nothing rather than
 * aborting whatever now runs under that `operationId`.
 *
 * @example
 * ```ts
 * import type { CancelMessage } from '@lostgradient/weft';
 *
 * const message: CancelMessage = {
 *   type: 'cancel',
 *   operationId: 'op-1',
 *   attemptToken: 'attempt-token',
 * };
 * ```
 */
export type CancelMessage = {
  readonly type: 'cancel';
  readonly operationId: string;
  readonly attemptToken: string;
};

/**
 * Graceful worker shutdown request sent by the server.
 *
 * @example
 * ```ts
 * import type { ShutdownMessage } from '@lostgradient/weft';
 *
 * const message: ShutdownMessage = { type: 'shutdown' };
 * ```
 */
export type ShutdownMessage = {
  readonly type: 'shutdown';
};

/**
 * Server acknowledgement of a worker's `taskResult` (COR-240, protocol v4).
 *
 * Echoes the `operationId` and `attemptToken` from the `taskResult` this
 * acknowledges, so a worker can match it against its attempt-keyed outbox.
 * `disposition` reports how the durable ledger resolved the submission:
 * `applied` — this attempt's first successful commit; `duplicate` — the
 * ledger already held a terminal record for this exact `(operationId,
 * attemptToken)` and content, re-affirmed without a new write (a resend
 * after an ambiguous send, or after a process restart); `dead-lettered` —
 * the result could not be durably applied (or already wasn't) and was
 * recorded as a dead letter instead. A hard rejection (unknown operation,
 * stale attempt, conflicting content under one attempt token, or a
 * queued/newer attempt already in progress) never produces this message —
 * the worker instead sees `protocolError`, as before v4.
 *
 * Only a `taskResultAck` removes the matching entry from the worker's
 * outbox — `WebSocket.send()` returning is not enough, since the frame may
 * never have reached the server, or the server's own response may never
 * have reached the worker.
 *
 * @example
 * ```ts
 * import type { TaskResultAckMessage } from '@lostgradient/weft';
 *
 * const message: TaskResultAckMessage = {
 *   type: 'taskResultAck',
 *   operationId: 'op-1',
 *   attemptToken: 'attempt-token',
 *   disposition: 'applied',
 * };
 * ```
 */
export type TaskResultAckMessage = {
  readonly type: 'taskResultAck';
  readonly operationId: string;
  readonly attemptToken: string;
  readonly disposition: 'applied' | 'duplicate' | 'dead-lettered';
};
