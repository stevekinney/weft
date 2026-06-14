/**
 * The worker-side `ctx.state` namespace. Built locally from a `run` message — worker
 * mode supports `execution`/`workflow` atomic state but rejects `session` state, which
 * needs the engine host. Extracted from `workflow-runner.ts` so that module stays under
 * the line cap.
 *
 * @module workers/worker-state-namespace
 */

import { WorkflowAtomicStateHandle } from '../core/context/state-namespace.ts';
import type {
  WorkflowAtomicStateOptions,
  WorkflowSessionState,
  WorkflowStateNamespace,
} from '../core/types.ts';

/** The `run`-message fields the state namespace needs to scope atomic state. */
export interface WorkerStateNamespaceScope {
  workflowId: string;
  workflowType: string;
  executionStateOwnerId?: string;
}

/**
 * Build the worker-side {@link WorkflowStateNamespace}. `execution` and `workflow`
 * scopes are supported; `session` throws because session state is an engine-host
 * capability the worker process cannot reach.
 */
export function createWorkerStateNamespace(
  message: WorkerStateNamespaceScope,
): WorkflowStateNamespace {
  return {
    session: <T>(_key: string): WorkflowSessionState<T> => {
      throw new Error(
        'ctx.state.session() is not supported in worker execution mode. ' +
          'Construct the engine without `workerExecution` to use session state.',
      );
    },
    execution: <T>(key: string, options?: WorkflowAtomicStateOptions<T>) =>
      new WorkflowAtomicStateHandle<T>(
        {
          type: 'execution',
          ownerWorkflowId: message.executionStateOwnerId ?? message.workflowId,
        },
        key,
        options,
      ),
    workflow: <T>(key: string, options?: WorkflowAtomicStateOptions<T>) =>
      new WorkflowAtomicStateHandle<T>(
        { type: 'workflow', workflowType: message.workflowType },
        key,
        options,
      ),
  };
}
