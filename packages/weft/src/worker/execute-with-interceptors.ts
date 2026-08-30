/**
 * Shared utility for executing activities through an optional interceptor chain.
 * Used by both RemoteWorker (WebSocket) and LongPollWorker (HTTP).
 */

import type { ActivityInterceptor } from '../core/interceptor.ts';
import { composeActivityInterceptors } from '../core/interceptor.ts';

export interface TaskInfo {
  activityName: string;
  operationId: string;
  attempt?: number;
  input: unknown;
  headers?: Record<string, string>;
  workflowExecutionToken?: string;
  attemptToken: string;
}

export interface ComposedInterceptor {
  execute: ReturnType<typeof composeActivityInterceptors>['execute'];
}

type ActivityExecutionContext = {
  signal: AbortSignal;
  workflowExecutionToken?: string;
  activityAttemptToken?: string;
};

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
 * Execute an activity function, optionally wrapped by a pre-composed interceptor chain.
 * Provides a consistent AbortSignal and headers Map to the interception context.
 */
export async function executeWithInterceptors(
  activityFunction: (input: unknown, context?: ActivityExecutionContext) => Promise<unknown>,
  task: TaskInfo,
  composed: ComposedInterceptor | null,
  signal?: AbortSignal,
): Promise<unknown> {
  const activityContext = createActivityExecutionContext(task, signal);
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
): ActivityExecutionContext | undefined {
  if (signal === undefined && task.workflowExecutionToken === undefined) {
    return undefined;
  }

  return {
    signal: signal ?? new AbortController().signal,
    ...(task.workflowExecutionToken !== undefined && {
      workflowExecutionToken: task.workflowExecutionToken,
    }),
    activityAttemptToken: task.attemptToken,
  };
}
