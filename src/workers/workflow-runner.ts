import { WorkflowAtomicStateHandle } from '../core/context/state-namespace.ts';
import { classifyErrorAsFailureCategory } from '../core/failure-categories.ts';
import type { TenantContext } from '../core/tenant.ts';
import type {
  OperationOutcome,
  OperationRequest,
  WorkerOutboundMessage,
  WorkflowAtomicStateOptions,
  WorkflowContext,
  WorkflowSessionState,
  WorkflowStateNamespace,
} from '../core/types.ts';

// ---------------------------------------------------------------------------
// Worker-side workflow context
// ---------------------------------------------------------------------------

/**
 * Subset of {@link WorkflowContext} that the worker-side runner can build
 * locally from the `run` message. Engine-side fields (`executionTimeRemaining`
 * in particular) are stub values because the worker has no clock authority —
 * any user code reading them will see static numbers, not live deadlines. The
 * tenant field is the load-bearing one: it's how multi-tenant agent handlers
 * see their tenant inside worker mode.
 */
export type WorkerWorkflowContext = Pick<
  WorkflowContext,
  'workflowId' | 'tenant' | 'signal' | 'startedAt'
> & {
  readonly state: WorkflowStateNamespace;
};

interface RunMessageShape {
  workflowId: string;
  workflowType: string;
  input: unknown;
  executionStateOwnerId?: string;
  tenant?: TenantContext;
  deadline?: number;
  headers?: [string, string][];
}

/**
 * Construct the worker-side `ctx` argument that gets passed as the first
 * positional parameter to a registered workflow handler. Engine-side fields
 * not represented in the `run` message are intentionally omitted — only the
 * `Pick`-ed subset above is populated.
 */
export function createWorkerWorkflowContext(
  message: RunMessageShape,
  controller: AbortController,
): WorkerWorkflowContext {
  return {
    workflowId: message.workflowId,
    tenant: message.tenant,
    signal: controller.signal,
    startedAt: Date.now(),
    state: createWorkerStateNamespace(message),
  };
}

function createWorkerStateNamespace(message: RunMessageShape): WorkflowStateNamespace {
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
    workflow: <T>(key: string, options?: WorkflowAtomicStateOptions<T>) => {
      const tenantId = requireWorkerTenantId(message, 'ctx.state.workflow()');
      return new WorkflowAtomicStateHandle<T>(
        { type: 'workflow', tenantId, workflowType: message.workflowType },
        key,
        options,
      );
    },
    tenant: <T>(key: string, options?: WorkflowAtomicStateOptions<T>) => {
      const tenantId = requireWorkerTenantId(message, 'ctx.state.tenant()');
      return new WorkflowAtomicStateHandle<T>({ type: 'tenant', tenantId }, key, options);
    },
  };
}

function requireWorkerTenantId(message: RunMessageShape, methodName: string): string {
  const tenantId = message.tenant?.id;
  if (tenantId === undefined || tenantId.length === 0) {
    throw new Error(`${methodName} requires a tenant context.`);
  }
  return tenantId;
}

// ---------------------------------------------------------------------------
// Workflow runner context: holds live generator state for in-flight workflows
// ---------------------------------------------------------------------------

export interface WorkflowRunnerContext {
  generators: Map<string, AsyncGenerator>;
  abortControllers: Map<string, AbortController>;
}

export function createWorkflowRunnerContext(): WorkflowRunnerContext {
  return {
    generators: new Map(),
    abortControllers: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Handle "run" – instantiate a generator and advance to the first yield/return
// ---------------------------------------------------------------------------

export async function handleRunMessage(
  context: WorkflowRunnerContext,
  message: {
    workflowId: string;
    workflowType: string;
    input: unknown;
    executionStateOwnerId?: string;
    tenant?: TenantContext;
    deadline?: number;
    headers?: [string, string][];
  },
  getWorkflowHandler: (
    type: string,
  ) => ((ctx: WorkerWorkflowContext, input: unknown) => AsyncGenerator) | undefined,
): Promise<WorkerOutboundMessage> {
  const handler = getWorkflowHandler(message.workflowType);

  if (!handler) {
    return {
      type: 'failed',
      workflowId: message.workflowId,
      error: `Unknown workflow type: ${message.workflowType}`,
      failureCategory: 'system',
    };
  }

  const controller = new AbortController();
  context.abortControllers.set(message.workflowId, controller);

  const workerContext = createWorkerWorkflowContext(message, controller);
  const generator = handler(workerContext, message.input);

  try {
    const step = await generator.next();
    return processGeneratorStep(context, message.workflowId, generator, step);
  } catch (error) {
    cleanup(context, message.workflowId);
    return {
      type: 'failed',
      workflowId: message.workflowId,
      error: formatError(error),
      failureCategory: classifyErrorAsFailureCategory(error, {
        defaultErrorCategory: 'application',
      }),
    };
  }
}

// ---------------------------------------------------------------------------
// Handle "resume" – feed an operation result back into a suspended generator
// ---------------------------------------------------------------------------

export async function handleResumeMessage(
  context: WorkflowRunnerContext,
  message: { workflowId: string; result: unknown; operationResult?: OperationOutcome },
): Promise<WorkerOutboundMessage> {
  const generator = context.generators.get(message.workflowId);

  if (!generator) {
    return {
      type: 'failed',
      workflowId: message.workflowId,
      error: `No active generator for workflow: ${message.workflowId}`,
      failureCategory: 'system',
    };
  }

  const operationFailureCategory =
    message.operationResult?.status === 'failed'
      ? message.operationResult.failureCategory
      : undefined;

  try {
    // If the operation failed, throw the error into the generator so the
    // workflow can handle it via try/catch rather than silently continuing.
    const outcome = message.operationResult;
    const step =
      outcome?.status === 'failed'
        ? await generator.throw(errorFromOperationOutcome(outcome))
        : await generator.next(message.result);
    return processGeneratorStep(context, message.workflowId, generator, step);
  } catch (error) {
    cleanup(context, message.workflowId);
    return {
      type: 'failed',
      workflowId: message.workflowId,
      error: formatError(error),
      failureCategory:
        operationFailureCategory ??
        classifyErrorAsFailureCategory(error, { defaultErrorCategory: 'application' }),
    };
  }
}

// ---------------------------------------------------------------------------
// Handle "cancel" – abort the controller and tear down state
// ---------------------------------------------------------------------------

/**
 * Handle a `cancel` message: abort the workflow's {@link AbortController},
 * run the generator's `finally` blocks by calling `generator.return()`, and
 * tear down the runner's in-memory state. The `return()` call is wrapped in a
 * try/catch because a well-behaved workflow's `finally` block may still throw
 * on cancellation (e.g. a `using` disposer), and we must never let that
 * prevent the rest of cleanup from running.
 *
 * The function is async (it awaits `generator.return()` so the workflow's
 * `finally` blocks actually complete before cleanup), which opens a narrow
 * race window: while awaiting, the worker message loop can process another
 * message for the same workflow ID — most dangerously a `run` that installs
 * a brand-new generator and controller into the context maps. We must not
 * clobber that state when this cancel handler resumes. The cleanup below
 * therefore only deletes the cached entries if they still point at the
 * *same* generator/controller we captured before the await.
 */
export async function handleCancelMessage(
  context: WorkflowRunnerContext,
  message: { workflowId: string },
): Promise<void> {
  const capturedController = context.abortControllers.get(message.workflowId);
  const capturedGenerator = context.generators.get(message.workflowId);

  if (capturedController) {
    capturedController.abort();
  }

  if (capturedGenerator) {
    try {
      await capturedGenerator.return(undefined);
    } catch {
      // Swallow: a finalizer in the workflow's try/finally may throw on
      // cancel, but we still need to proceed to cleanup regardless.
    }
  }

  // Identity-compare before deleting: if a new `run` message arrived
  // during the await and replaced either entry, leave it alone.
  if (context.generators.get(message.workflowId) === capturedGenerator) {
    context.generators.delete(message.workflowId);
  }
  if (context.abortControllers.get(message.workflowId) === capturedController) {
    context.abortControllers.delete(message.workflowId);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function processGeneratorStep(
  context: WorkflowRunnerContext,
  workflowId: string,
  generator: AsyncGenerator,
  step: IteratorResult<unknown>,
): WorkerOutboundMessage {
  if (step.done) {
    cleanup(context, workflowId);
    return {
      type: 'completed',
      workflowId,
      result: step.value,
    };
  }

  // The yielded value is an OperationRequest describing the next operation
  context.generators.set(workflowId, generator);
  return {
    type: 'checkpoint',
    workflowId,
    checkpoint: new ArrayBuffer(0),
    operationRequest: step.value as OperationRequest,
  };
}

function cleanup(context: WorkflowRunnerContext, workflowId: string): void {
  context.generators.delete(workflowId);
  context.abortControllers.delete(workflowId);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function errorFromOperationOutcome(
  outcome: Extract<OperationOutcome, { status: 'failed' }>,
): Error {
  const error = new Error(outcome.error);
  if (outcome.errorName !== undefined) {
    error.name = outcome.errorName;
  }
  return error;
}
