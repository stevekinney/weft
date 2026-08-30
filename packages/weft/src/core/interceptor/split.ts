import type {
  ActivityInterceptor,
  Interceptor,
  WorkflowInterceptor,
} from './interceptor-interfaces.ts';
import { WORKFLOW_INTERCEPTOR_HOOKS } from './interceptor-interfaces.ts';

/**
 * Split a unified interceptor list into the workflow and activity pipelines.
 *
 * Interceptors with both workflow-side hooks and `execute` appear in both
 * arrays. Interceptors without recognized callable hooks are skipped.
 */
export function splitInterceptors(list: readonly Interceptor[]): {
  workflow: WorkflowInterceptor[];
  activity: ActivityInterceptor[];
} {
  const workflow: WorkflowInterceptor[] = [];
  const activity: ActivityInterceptor[] = [];

  for (const interceptor of list) {
    if (WORKFLOW_INTERCEPTOR_HOOKS.some((hook) => hasCallableHook(interceptor, hook))) {
      workflow.push(interceptor);
    }

    if (hasCallableHook(interceptor, 'execute')) {
      activity.push(interceptor);
    }
  }

  return { workflow, activity };
}

function hasCallableHook(interceptor: Interceptor, hook: string): boolean {
  // Optional interface members are not indexable by dynamic hook names, so use a typed record view.
  return typeof (interceptor as Record<string, unknown>)[hook] === 'function';
}
