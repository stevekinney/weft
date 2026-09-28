/**
 * Context object passed to activity implementations executed by a
 * {@link RemoteWorker} or {@link LongPollWorker}. Carries the per-task
 * `AbortSignal` so a long-running activity can observe cancellation requested
 * from the server, and (COR-226) a `heartbeat`/`lastHeartbeatDetails` surface
 * mirroring {@link import('../core/types.ts').ActivityContext.heartbeat} /
 * `lastHeartbeatDetails` for the inline engine — the SAME public shape, not a
 * second heartbeat API, so an activity function written against
 * `ActivityContext` needs no changes to also run as a worker-executed remote
 * activity.
 *
 * Lives in its own leaf module so worker-side helpers (e.g. the qualified-name
 * activity binder) can depend on the type without pulling in the full
 * `RemoteWorker` class graph.
 *
 * @module worker/remote-activity-context
 */

/** Context passed to activity functions executed by a remote worker. */
export type RemoteActivityContext = {
  signal: AbortSignal;
  workflowExecutionToken?: string;
  activityAttemptToken?: string;
  /**
   * Record heartbeat progress for this attempt (COR-226). Sent to the server
   * as `activityHeartbeat.details` (WebSocket) or the long-poll heartbeat
   * request body's `details` field, in addition to (not instead of) the
   * worker's automatic per-attempt keepalive — calling this resets nothing
   * about the automatic interval, it just piggybacks details on the next
   * frame this call sends immediately. `details` must be JSON-serializable
   * and within the server's configured payload size limit; an unserializable
   * or oversized value is normalized to `null` client-side (mirroring
   * `normalizeWorkerJsonValue`'s handling of an activity's return value) or
   * rejected server-side, exactly like an oversized `taskResult`.
   */
  heartbeat: (details?: unknown) => void;
  /**
   * The heartbeat details the PREVIOUS attempt of this operation recorded
   * before it was redispatched, or `undefined` when no prior attempt ever
   * heartbeated with details (including a first attempt). Mirrors {@link
   * import('../core/types.ts').ActivityContext.lastHeartbeatDetails}'s
   * resumable-batch pattern for worker-executed activities — this package's
   * fix for the exact gap that field's own doc comment names as absent for
   * "worker-executed activities … which never observe this."
   */
  lastHeartbeatDetails?: unknown;
};
