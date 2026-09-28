/**
 * Canonical RemoteWorker wire protocol version constants.
 *
 * Lives in a leaf module so both the parser implementation (`protocol.ts`) and
 * the JSON Schema declarations (`protocol-schemas.ts`) can depend on the
 * version without forming an import cycle.
 *
 * @module worker/protocol-version
 */

/**
 * Current RemoteWorker wire protocol version.
 *
 * **Version 8** (Automatic Keepalive, Heartbeat Details, and Cancellation
 * Reason — COR-226, COR-223) adds four OPTIONAL fields across three existing
 * messages:
 *
 *   - `activityHeartbeat.details` — mirrors {@link
 *     import('../core/types.ts').ActivityContext.heartbeat}'s `details`
 *     argument for a worker-executed activity. The server persists it as the
 *     attempt's `lastHeartbeatDetails` and never validates it beyond "valid
 *     JSON within the configured payload size limit" — the same bound
 *     `taskResult` values already carry.
 *   - `task.visibilityTimeout` — the lease duration this dispatch was claimed
 *     with, so {@link import('./index.ts').RemoteWorker} can derive its
 *     automatic per-attempt keepalive interval from it exactly as {@link
 *     import('./long-poll.ts').PolledTask.visibilityTimeout} already lets
 *     `LongPollWorker` do. Before v8, `RemoteWorker` sent no per-attempt
 *     `activityHeartbeat` at all — only `LongPollWorker` did — so a
 *     long-running WebSocket-dispatched activity whose real duration exceeded
 *     `visibilityTimeout` had its lease silently expire, get reassigned by
 *     `scanExpiredTasks`, and execute a SECOND time concurrently. This is a
 *     correctness fix, not merely new instrumentation.
 *   - `task.lastHeartbeatDetails` — echoes a redispatched attempt's
 *     predecessor's `lastHeartbeatDetails` back to the worker so a
 *     worker-executed activity's context can resume from it, mirroring the
 *     inline engine's `ActivityContext.lastHeartbeatDetails`.
 *   - `cancel.reason` — the durably recorded `cancellationReason` a `cancel`
 *     control is delivering, so the worker's `AbortSignal.reason` and
 *     reported cancellation error carry the real, operator-supplied reason
 *     instead of the generic literal `"Task cancelled"` every version before
 *     v8 always reported.
 *
 * This is a version bump, not a negotiated one, for the same reason v5's and
 * v6's were: a v7 worker silently keeps reporting the generic cancellation
 * literal and silently never resumes from heartbeat details against a v8
 * server (every new field is additive and a v7 field-by-field parser ignores
 * unknown properties), which is exactly the kind of silent regression a clean
 * protocol break exists to convert into a loud `registerError` instead.
 *
 * **Version 7** (Correlated Task-Result Rejections) adds two OPTIONAL fields,
 * `operationId` and `attemptToken`, to `protocolError`. They are present
 * exactly when the rejection concerns a specific `taskResult` submission the
 * server will never apply no matter how many times it is resent — unknown
 * operation, stale or foreign attempt, a workflow-revision mismatch, or
 * conflicting content resubmitted under one attempt token — and absent for
 * `invalid_json`, `unknown_message_type`, `registration_required`, and any
 * other malformed-frame rejection where no operation exists yet. Before v7 a
 * worker's `TaskResultOutbox` (COR-240) had no way to tell WHICH buffered
 * entry a `protocolError` was rejecting, so a permanently-unappliable result
 * could never be acknowledged and was resent on every reconnect forever,
 * eventually tripping `MAX_BUFFERED_TASK_RESULTS` and wedging the worker's
 * intake. This is a version bump, not a negotiated one, even though the new
 * fields are optional and a v6 worker's field-by-field parser silently
 * ignores unknown properties on a message it can already parse: the
 * documented wire contract (`REMOTE_WORKER_PROTOCOL_JSON_SCHEMA`) for
 * `protocolError` changes shape, and this repository's pre-release policy is
 * to make that a clean break rather than carry an implicit, undocumented
 * promise about when a v6 peer could have relied on the fields being
 * present. No compatibility parser is added for the retired version, matching
 * every prior bump's policy.
 *
 * **Version 6** (Reconnect, Shutdown, and Diagnostics, COR-220) adds a
 * session-generation handshake to `register`/`registerAck` so a reconnecting
 * worker can PROVE it is resuming its own prior session rather than merely
 * asserting the same `workerId`. `registerAck` now always carries
 * `sessionGeneration` (the {@link
 * import('./registry/types.ts').WorkerSessionIdentity.sessionGeneration}
 * value for the session just registered); a worker that reconnects while its
 * `workerId` still has a pending grace-period requeue echoes that generation
 * back as `register.resumeSessionGeneration`. A match is a PROVEN resume —
 * the server keeps the session's generation unchanged and its in-flight
 * attempts and their leases untouched. Anything else (no echo, a mismatched
 * echo, or a reconnect after the grace window already lapsed) is an
 * UNPROVEN reconnect: the server forfeits the worker's in-flight work (the
 * same requeue the grace timer would have run) before registering a brand
 * new session with an incremented generation. This is a version bump, not a
 * negotiated one, for the same reason v5's was: a v5 worker's in-grace
 * reconnect used to silently keep its in-flight work with no proof at all;
 * against a v6 server it would silently start forfeiting that work instead
 * (no `resumeSessionGeneration` echo, ever), which is exactly the silent
 * regression a clean protocol break exists to convert into a loud
 * `registerError` instead.
 *
 * **Version 5** (Session and Attempt Lease Model, COR-230) splits the single
 * `heartbeat` message's semantics into two independently-clocked messages: a
 * bare `heartbeat` (`workerId` only) renews ONLY the worker-session lease —
 * `WorkerRegistry.heartbeat()` — and a new `activityHeartbeat` (`workerId` +
 * `operationId` + `attemptToken`) renews ONLY that one attempt's
 * heartbeat-extendable visibility deadline, fenced by the same
 * `authorizeTaskResultForCurrentAttempt` identity check `taskResult` already
 * uses. Before v5, a bare `heartbeat` extended the visibility deadline of
 * every in-flight task assigned to the connection — an undocumented fan-out
 * that could not distinguish a live long-running attempt from one the
 * connection no longer actually owned. This is a version bump, not a
 * negotiated one, for the same reason v3's was: a v4 worker's bare
 * heartbeats silently stop keeping its long-running attempts alive against a
 * v5 server (they now renew the session only), which would otherwise regress
 * as a silent task timeout with no diagnostic rather than a clear
 * registration rejection. Every attempt also now carries an absolute
 * `attemptDeadline` (`task-ledger-transitions.ts`) that neither heartbeat
 * kind can extend.
 *
 * **Version 4** (Protocol and Outbox, COR-240) adds the server-to-worker
 * `taskResultAck` message, echoing back the operation's `attemptToken` with a
 * `disposition` of `applied`, `duplicate`, or `dead-lettered`. Pairing this
 * with the worker's outbox re-keyed to `(operationId, attemptToken)` closes
 * the ambiguous-send gap in version 3: a worker no longer discards a buffered
 * result on `WebSocket.send()` returning — only a matching `taskResultAck`
 * does. This is additive to the wire shape (every v3 message still parses
 * unchanged) but is still a version bump, not a negotiated one: version 3
 * peers never receive `taskResultAck` and their outbox never drains without
 * this package's SDK update, so this repository does not carry a second
 * compatibility parser for the retired version.
 *
 * **Version 3** (Canonical Worker Manifest, WFT-27) replaces the register
 * message's parallel top-level identity fields (`activities`, `queue`,
 * `deploymentName`, `buildId`, `runtimeVersion`, `gitSha`, `capabilities`)
 * with a single `manifest: WorkerManifest` field, and the ack echoes
 * `acceptedManifestDigest` plus `serverCapabilities` instead of echoing
 * `activities` back. Both directions of the handshake reshape — a strictly
 * larger change than version 2's same-shape/different-semantics bump — so
 * this is a clean break rather than a negotiated one: a v2 peer gets the
 * canonical `WorkerProtocolIncompatibleError`, not a confusing
 * `invalid_registration`.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_PROTOCOL_VERSION } from '@lostgradient/weft';
 *
 * const registration = { type: 'register', protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION };
 * ```
 */
export const REMOTE_WORKER_PROTOCOL_VERSION = 8;

/**
 * Lowest RemoteWorker protocol version accepted by this package.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_MIN_PROTOCOL_VERSION } from '@lostgradient/weft';
 *
 * const supportsCurrentVersion = REMOTE_WORKER_MIN_PROTOCOL_VERSION === 7;
 * ```
 */
export const REMOTE_WORKER_MIN_PROTOCOL_VERSION = 8;

/**
 * Highest RemoteWorker protocol version accepted by this package.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_MAX_PROTOCOL_VERSION } from '@lostgradient/weft';
 *
 * const canUseRequestedVersion = 7 <= REMOTE_WORKER_MAX_PROTOCOL_VERSION;
 * ```
 */
export const REMOTE_WORKER_MAX_PROTOCOL_VERSION = 8;

/**
 * Explicit supported RemoteWorker protocol versions.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS } from '@lostgradient/weft';
 *
 * const supported = REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS.includes(7);
 * ```
 */
export const REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS = [REMOTE_WORKER_PROTOCOL_VERSION] as const;

/**
 * RemoteWorker protocol version accepted by this package.
 *
 * @example
 * ```ts
 * import type { RemoteWorkerProtocolVersion } from '@lostgradient/weft';
 *
 * const version: RemoteWorkerProtocolVersion = 8;
 * ```
 */
export type RemoteWorkerProtocolVersion =
  (typeof REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS)[number];
