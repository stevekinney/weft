/**
 * Shared utility for executing activities through an optional interceptor chain.
 * Used by both RemoteWorker (WebSocket) and LongPollWorker (HTTP).
 */

import type { ActivityInterceptor } from '../core/interceptor.ts';
import { composeActivityInterceptors } from '../core/interceptor.ts';
import type { RemoteActivityContext } from './remote-activity-context.ts';

export interface TaskInfo {
  activityName: string;
  operationId: string;
  attempt?: number;
  input: unknown;
  headers?: Record<string, string>;
  workflowExecutionToken?: string;
  attemptToken: string;
  /**
   * The heartbeat details a PREVIOUS attempt of this operation recorded
   * before being redispatched (COR-226) — surfaced to the activity as
   * `context.lastHeartbeatDetails`. `undefined` when no prior attempt ever
   * heartbeated with details.
   */
  lastHeartbeatDetails?: unknown;
}

export interface ComposedInterceptor {
  execute: ReturnType<typeof composeActivityInterceptors>['execute'];
}

/**
 * Pre-compose interceptors once (at construction time) so the chain
 * is not rebuilt on every task execution.
 */
export function buildComposedInterceptor(
  interceptors: ActivityInterceptor[] | undefined,
): ComposedInterceptor | null {
  if (!interceptors || interceptors.length === 0) return null;
  return composeActivityInterceptors(interceptors);
}

/**
 * Execute an activity function, optionally wrapped by a pre-composed
 * interceptor chain. Provides a consistent `AbortSignal`, headers `Map`, and
 * (COR-226) `heartbeat`/`lastHeartbeatDetails` surface to the interception
 * context.
 *
 * `sendHeartbeat`, when supplied, is called with the activity's OWN
 * `context.heartbeat(details)` invocation — this function never calls it
 * itself. It is the caller's (`RemoteWorker`/`LongPollWorker`'s) job to send
 * the periodic AUTOMATIC keepalive; this seam only carries an on-demand,
 * details-bearing heartbeat the activity chooses to send.
 */
export async function executeWithInterceptors(
  activityFunction: (input: unknown, context?: RemoteActivityContext) => Promise<unknown>,
  task: TaskInfo,
  composed: ComposedInterceptor | null,
  signal?: AbortSignal,
  sendHeartbeat?: (details?: unknown) => void,
): Promise<unknown> {
  const activityContext = createActivityExecutionContext(task, signal, sendHeartbeat);
  if (!composed) {
    return activityFunction(task.input, activityContext);
  }

  const headers = new Map<string, string>(Object.entries(task.headers ?? {}));
  return composed.execute(
    {
      activityName: task.activityName,
      operationId: task.operationId,
      attempt: task.attempt ?? 1,
      input: task.input,
      headers,
      ...(signal && { signal }),
    },
    async (interception) => {
      return activityFunction(interception.input, activityContext);
    },
  );
}

function createActivityExecutionContext(
  task: TaskInfo,
  signal: AbortSignal | undefined,
  sendHeartbeat: ((details?: unknown) => void) | undefined,
): RemoteActivityContext | undefined {
  // Preserves the pre-COR-226 omission rule exactly: no context at all when
  // this call carries neither a signal nor a workflow execution token — the
  // isolated (non-worker) caller this serves has nothing execution-context
  // shaped to offer. Every REAL RemoteWorker/LongPollWorker dispatch always
  // passes a signal, so this omission never applies in production.
  if (signal === undefined && task.workflowExecutionToken === undefined) {
    return undefined;
  }

  return {
    signal: signal ?? new AbortController().signal,
    ...(task.workflowExecutionToken !== undefined && {
      workflowExecutionToken: task.workflowExecutionToken,
    }),
    activityAttemptToken: task.attemptToken,
    lastHeartbeatDetails: task.lastHeartbeatDetails,
    heartbeat: sendHeartbeat ?? (() => {}),
  };
}
