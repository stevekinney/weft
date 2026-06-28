/**
 * Context object passed to activity implementations executed by a
 * {@link RemoteWorker}. Carries the per-task `AbortSignal` so a long-running
 * activity can observe cancellation requested from the server.
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
};
