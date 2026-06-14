import { advanceCheckpoint, serializeCheckpoint } from '../core/checkpoint.ts';
import {
  createWorkerWorkflowLogger,
  type WorkerLoggerReplayState,
} from '../core/context/workflow-logger.ts';
import {
  classifyErrorAsFailureCategory,
  errorFromFailedOperationOutcome,
} from '../core/failure-categories.ts';
import type {
  Checkpoint,
  FailureCategory,
  OperationOutcome,
  OperationRequest,
  WorkerOutboundMessage,
  WorkflowContext,
  WorkflowLogger,
  WorkflowLogRecord,
  WorkflowStateNamespace,
} from '../core/types.ts';
import {
  createWorkerReplayOperationSignature,
  WORKER_PROTOCOL_VERSION,
  workerReplayOperationSignaturesEqual,
} from '../core/worker-protocol.ts';
import {
  createReplayState,
  recordOperationOutcome,
  type WorkerReplayState,
} from './worker-replay-state.ts';
import { createWorkerStateNamespace } from './worker-state-namespace.ts';

// ---------------------------------------------------------------------------
// Worker-side workflow context
// ---------------------------------------------------------------------------

/**
 * Subset of {@link WorkflowContext} that the worker-side runner can build
 * locally from the `run` message. Engine-side fields (`executionTimeRemaining`
 * in particular) are stub values because the worker has no clock authority —
 * any user code reading them will see static numbers, not live deadlines.
 */
export type WorkerWorkflowContext = Pick<
  WorkflowContext,
  'workflowId' | 'workflowType' | 'signal' | 'startedAt'
> & {
  readonly state: WorkflowStateNamespace;
  // Non-optional here (always populated at runtime) even though the public
  // WorkflowContext types it `log?` for structural implementors.
  readonly log: WorkflowLogger;
};

interface RunMessageShape {
  workflowId: string;
  workflowType: string;
  input: unknown;
  executionStateOwnerId?: string;
  deadline?: number;
  headers?: [string, string][];
}

/**
 * Construct the worker-side `ctx` argument that gets passed as the first
 * positional parameter to a registered workflow handler. Engine-side fields
 * not represented in the `run` message are intentionally omitted — only the
 * `Pick`-ed subset above is populated. `forwardLog`, when provided by the worker
 * entry (host has an `onLog` sink), routes `ctx.log` records to the host (#529).
 */
export function createWorkerWorkflowContext(
  message: RunMessageShape,
  controller: AbortController,
  // The structural slice the logger reads, not the full private `WorkerReplayState`
  // (a superset, so the real call site passes through unchanged).
  getReplayState: () => WorkerLoggerReplayState | undefined,
  forwardLog?: (record: WorkflowLogRecord) => void,
): WorkerWorkflowContext {
  return {
    workflowId: message.workflowId,
    workflowType: message.workflowType,
    signal: controller.signal,
    startedAt: Date.now(),
    state: createWorkerStateNamespace(message),
    // The logger reads replay state through the closure (not by value) so it sees
    // the live frontier at each emit as the runner advances `nextStepIndex`.
    log: createWorkerWorkflowLogger(
      message.workflowId,
      message.workflowType,
      getReplayState,
      forwardLog,
    ),
  };
}

/**
 * Posts a forwarded `ctx.log` message to the host, size-checking against the current
 * `maxProtocolMessageBytes`. Throwing on oversize is intentional — the shared logger
 * factory catches it and falls the record back to the worker console (#529).
 */
export type WorkerLogPoster = (
  message: Extract<WorkerOutboundMessage, { type: 'log' }>,
  maxProtocolMessageBytes: number | undefined,
) => void;

/**
 * Build the `ctx.log` → host forwarder for one workflow (#529). The record is wrapped in
 * a `log` outbound message and handed to the entry's `postLog`. Returns `undefined` when
 * the host has no sink. A throw (oversize/non-cloneable record makes `postMessage` throw)
 * is caught by the shared logger factory and falls the record back to the worker console.
 * The host gates delivery by worker-ownership of `workflowId` and matches the record's
 * identity, so the message carries no turn-protocol state.
 *
 * The size cap is CAPTURED here at construction, not read live from replay state: a
 * fire-and-forget log can resolve AFTER terminal cleanup deleted the replay state, and a
 * live read would then see `undefined` and let an oversized record reach the host. The
 * cap is fixed per engine config (identical across run/resume), so capturing it keeps the
 * "oversize log never reaches the host" contract even on the post-cleanup path.
 */
function buildLogForwarder(
  workflowId: string,
  maxProtocolMessageBytes: number | undefined,
  postLog: WorkerLogPoster | undefined,
): ((record: WorkflowLogRecord) => void) | undefined {
  if (postLog === undefined) return undefined;
  return (record: WorkflowLogRecord): void => {
    postLog(
      {
        type: 'log',
        protocolVersion: WORKER_PROTOCOL_VERSION,
        workflowId,
        record,
      },
      maxProtocolMessageBytes,
    );
  };
}

// ---------------------------------------------------------------------------
// Workflow runner context: holds live generator state for in-flight workflows
// ---------------------------------------------------------------------------

export interface WorkflowRunnerContext {
  generators: Map<string, AsyncGenerator>;
  abortControllers: Map<string, AbortController>;
  replayStates: Map<string, WorkerReplayState>;
}

export function createWorkflowRunnerContext(): WorkflowRunnerContext {
  return {
    generators: new Map(),
    abortControllers: new Map(),
    replayStates: new Map(),
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
    checkpoint?: ArrayBuffer;
    maxProtocolMessageBytes?: number;
    executionStateOwnerId?: string;
    deadline?: number;
    headers?: [string, string][];
  },
  getWorkflowHandler: (
    type: string,
  ) => ((ctx: WorkerWorkflowContext, input: unknown) => AsyncGenerator) | undefined,
  // Posts a forwarded `ctx.log` message to the host (#529); supplied by the worker
  // entry (which owns `postMessage`) only when the host installed an `onLog` sink. The
  // entry size-checks against `maxProtocolMessageBytes` and posts (or throws on oversize).
  postLog?: WorkerLogPoster,
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

  try {
    // Register the replay state before building the context or invoking the
    // handler, so `ctx.log`'s probe is replay-aware from the earliest point even
    // if a handler runs synchronous code before yielding.
    context.replayStates.set(message.workflowId, createReplayState(message));
    const workerContext = createWorkerWorkflowContext(
      message,
      controller,
      () => context.replayStates.get(message.workflowId),
      buildLogForwarder(message.workflowId, message.maxProtocolMessageBytes, postLog),
    );
    const generator = handler(workerContext, message.input);
    const step = await generator.next();
    return await processGeneratorStep(context, message.workflowId, generator, step);
  } catch (error) {
    cleanupWorkflowRunnerState(context, message.workflowId);
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
  message: {
    workflowId: string;
    result: unknown;
    operationResult?: OperationOutcome;
    maxProtocolMessageBytes?: number;
  },
): Promise<WorkerOutboundMessage> {
  const generator = context.generators.get(message.workflowId);
  const replayState = context.replayStates.get(message.workflowId);

  if (!generator || !replayState) {
    return {
      type: 'failed',
      workflowId: message.workflowId,
      error: `No active generator for workflow: ${message.workflowId}`,
      failureCategory: 'system',
    };
  }

  const outcome = operationOutcomeFromResumeMessage(message);
  const operationFailureCategory = operationFailureCategoryFromOutcome(outcome);

  try {
    // If the operation failed, throw the error into the generator so the
    // workflow can handle it via try/catch rather than silently continuing.
    recordOperationOutcome(replayState, outcome);
    if (message.maxProtocolMessageBytes !== undefined) {
      replayState.maxProtocolMessageBytes = message.maxProtocolMessageBytes;
    }
    const step = await resumeGeneratorWithOutcome(generator, outcome, message.result);
    return await processGeneratorStep(context, message.workflowId, generator, step);
  } catch (error) {
    cleanupWorkflowRunnerState(context, message.workflowId);
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

function operationOutcomeFromResumeMessage(message: {
  result: unknown;
  operationResult?: OperationOutcome;
}): OperationOutcome {
  return message.operationResult ?? { status: 'completed', value: message.result };
}

function operationFailureCategoryFromOutcome(
  outcome: OperationOutcome,
): FailureCategory | undefined {
  return outcome.status === 'failed' ? outcome.failureCategory : undefined;
}

async function resumeGeneratorWithOutcome(
  generator: AsyncGenerator,
  outcome: OperationOutcome,
  result: unknown,
): Promise<IteratorResult<unknown>> {
  if (outcome.status === 'failed') {
    return await generator.throw(errorFromFailedOperationOutcome(outcome));
  }
  return await generator.next(result);
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
  const capturedReplayState = context.replayStates.get(message.workflowId);

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
  if (context.replayStates.get(message.workflowId) === capturedReplayState) {
    context.replayStates.delete(message.workflowId);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function processGeneratorStep(
  context: WorkflowRunnerContext,
  workflowId: string,
  generator: AsyncGenerator,
  step: IteratorResult<unknown>,
): Promise<WorkerOutboundMessage> {
  const replayState = context.replayStates.get(workflowId)!;

  let currentStep = step;
  while (true) {
    if (currentStep.done) {
      cleanupWorkflowRunnerState(context, workflowId);
      return {
        type: 'completed',
        workflowId,
        result: currentStep.value,
      };
    }

    const operationRequest = currentStep.value as OperationRequest;
    const stepIndex = replayState.nextStepIndex;
    const signature = await createWorkerReplayOperationSignature(
      operationRequest,
      replayState.maxProtocolMessageBytes ?? Number.MAX_SAFE_INTEGER,
    );

    if (hasCachedWorkerOutcome(replayState, stepIndex)) {
      const persistedSignature = replayState.signatures.get(stepIndex);
      if (!persistedSignature) {
        cleanupWorkflowRunnerState(context, workflowId);
        return {
          type: 'failed',
          workflowId,
          error: `Worker checkpoint is missing replay signature for step ${stepIndex}`,
          failureCategory: 'system',
        };
      }
      if (!workerReplayOperationSignaturesEqual(signature, persistedSignature)) {
        cleanupWorkflowRunnerState(context, workflowId);
        return {
          type: 'failed',
          workflowId,
          error: `Worker checkpoint replay signature mismatch at step ${stepIndex}`,
          failureCategory: 'system',
        };
      }

      replayState.nextStepIndex = stepIndex + 1;
      currentStep = await replayGeneratorStep(generator, replayState, stepIndex);
      continue;
    }

    const persistedPendingSignature = replayState.signatures.get(stepIndex);
    if (persistedPendingSignature) {
      if (!workerReplayOperationSignaturesEqual(signature, persistedPendingSignature)) {
        cleanupWorkflowRunnerState(context, workflowId);
        return {
          type: 'failed',
          workflowId,
          error: `Worker checkpoint replay signature mismatch at pending step ${stepIndex}`,
          failureCategory: 'system',
        };
      }
    } else {
      replayState.signatures.set(stepIndex, signature);
      replayState.checkpoint = advanceWorkerCheckpoint(replayState);
    }
    replayState.pendingStepIndex = stepIndex;
    context.generators.set(workflowId, generator);
    return {
      type: 'checkpoint',
      workflowId,
      checkpoint: toArrayBuffer(serializeCheckpoint(replayState.checkpoint)),
      operationRequest,
    };
  }
}

function hasCachedWorkerOutcome(replayState: WorkerReplayState, stepIndex: number): boolean {
  return replayState.accumulatedResults.has(stepIndex) || replayState.failedOutcomes.has(stepIndex);
}

async function replayGeneratorStep(
  generator: AsyncGenerator,
  replayState: WorkerReplayState,
  stepIndex: number,
): Promise<IteratorResult<unknown>> {
  const failedOutcome = replayState.failedOutcomes.get(stepIndex);
  if (failedOutcome) {
    return await generator.throw(errorFromFailedOperationOutcome(failedOutcome));
  }
  return await generator.next(replayState.accumulatedResults.get(stepIndex));
}

function advanceWorkerCheckpoint(replayState: WorkerReplayState): Checkpoint {
  const advanced = advanceCheckpoint(replayState.checkpoint, replayState.checkpoint.locals, {
    accumulatedResults: [...replayState.accumulatedResults],
  });
  const workerReplayFailures = [...replayState.failedOutcomes];
  const advancedCheckpoint = { ...advanced };
  delete advancedCheckpoint.workerReplayFailures;
  return {
    ...advancedCheckpoint,
    workerReplaySignatures: [...replayState.signatures],
    ...(workerReplayFailures.length === 0 ? {} : { workerReplayFailures }),
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function cleanupWorkflowRunnerState(
  context: WorkflowRunnerContext,
  workflowId: string,
): void {
  context.generators.delete(workflowId);
  context.abortControllers.delete(workflowId);
  context.replayStates.delete(workflowId);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
