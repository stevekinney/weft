import type {
  AwaitChildWorkflowOptions,
  ChildWorkflowHandle,
  ChildWorkflowOptions,
  ChildWorkflowTarget,
  WorkflowMapOptions,
  WorkflowPipeStage,
  WorkflowReduceInput,
  WorkflowReduceOptions,
} from '../types.ts';
import type { Context } from './index.ts';
import type { ContextInternals } from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';
import { captureCallerStack } from './validation.ts';

export function normalizePipeStage(
  internals: ContextInternals,
  stage: WorkflowPipeStage | ChildWorkflowTarget,
): {
  workflowType: string;
  options: AwaitChildWorkflowOptions | undefined;
} {
  if (typeof stage === 'object' && stage !== null && 'type' in stage) {
    return {
      workflowType: resolveChildWorkflowTarget(internals, stage.type),
      options: stage.options,
    };
  }

  return {
    workflowType: resolveChildWorkflowTarget(internals, stage),
    options: undefined,
  };
}

export function resolveChildWorkflowTarget<TInput = unknown, TOutput = unknown>(
  internals: ContextInternals,
  target: ChildWorkflowTarget<TInput, TOutput>,
): string {
  if (typeof target === 'string') {
    return target;
  }

  if (internals.resolveWorkflowType) {
    return internals.resolveWorkflowType(target);
  }

  throw new Error(
    'Workflow functions used in composition operators must be registered before use. ' +
      'Pass the registered workflow type string or register the function on the engine first.',
  );
}

export function resolveMapConcurrency(
  totalItems: number,
  requestedConcurrency: number | undefined,
): number {
  if (requestedConcurrency === undefined) {
    return totalItems;
  }

  if (
    !Number.isFinite(requestedConcurrency) ||
    !Number.isInteger(requestedConcurrency) ||
    requestedConcurrency < 1
  ) {
    throw new Error('ctx.map concurrency must be a positive integer');
  }

  return Math.min(requestedConcurrency, totalItems);
}

export function createCompositionToken(
  internals: ContextInternals,
  kind: 'map' | 'pipe' | 'reduce',
): string {
  return `${kind}:${internals.stepIndex}`;
}

export function createCompositionChildWorkflowOptions(
  internals: ContextInternals,
  token: string,
  index: number,
  options: AwaitChildWorkflowOptions | undefined = undefined,
): AwaitChildWorkflowOptions {
  assertCompositionAwaitsChildWorkflow(options);

  if (options?.id !== undefined) {
    return options;
  }

  return {
    ...options,
    id: `${internals.context.workflowId}:${token}:${index}`,
  };
}

export function createReduceChildWorkflowOptions(
  internals: ContextInternals,
  token: string,
  index: number,
  options: WorkflowReduceOptions | undefined,
): AwaitChildWorkflowOptions {
  if (options === undefined) {
    return createCompositionChildWorkflowOptions(internals, token, index);
  }

  const { idPrefix, ...childWorkflowOptions } = options;
  assertCompositionAwaitsChildWorkflow(childWorkflowOptions);
  return createCompositionChildWorkflowOptions(
    internals,
    token,
    index,
    idPrefix !== undefined
      ? {
          ...childWorkflowOptions,
          id: `${idPrefix}:${index}`,
        }
      : childWorkflowOptions,
  );
}

function assertCompositionAwaitsChildWorkflow(options: unknown): void {
  if (typeof options !== 'object' || options === null || !('parentClosePolicy' in options)) {
    return;
  }

  const parentClosePolicy = options.parentClosePolicy;
  if (parentClosePolicy === undefined || parentClosePolicy === 'await') {
    return;
  }

  throw new Error(
    'ctx.pipe, ctx.map, and ctx.reduce always await child workflow results. ' +
      'Use ctx.startChild() directly for parentClosePolicy: "abandon" or "request-cancel".',
  );
}

export function primeParallelOperations(
  operations: Generator<ContextOperationRequest, unknown, unknown>[],
): ContextOperationRequest[] {
  const subOperations: ContextOperationRequest[] = [];

  for (const generator of operations) {
    const yielded = generator.next();
    if (!yielded.done) {
      subOperations.push(yielded.value);
    }
  }

  return subOperations;
}

export function* startChild<TResult = unknown>(
  context: Context,
  internals: ContextInternals,
  workflowType: string,
  input: unknown,
  options?: ChildWorkflowOptions,
): Generator<ContextOperationRequest, TResult | ChildWorkflowHandle<TResult>, unknown> {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    if (internals.explainMode) {
      console.log(
        `[weft] ctx.startChild("${workflowType}") → Returning cached result from step ${step}`,
      );
    }
    return internals.accumulatedResults.get(step) as TResult;
  }

  if (internals.explainMode) {
    console.log(`[weft] ctx.startChild("${workflowType}", ${JSON.stringify(input)})`);
    console.log(`  → Creating checkpoint at step ${step}`);
    console.log(`  → Starting child workflow of type "${workflowType}"`);
  }

  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  const request: ContextOperationRequest = {
    type: 'child-workflow' as const,
    operationId,
    workflowType,
    input,
    callerStack,
    ...(options !== undefined ? { options } : {}),
  };
  const result = yield request;

  context.accumulatedResults.set(step, result);
  return result as TResult;
}

export function* pipe<TResult = unknown>(
  context: Context,
  internals: ContextInternals,
  stages: Array<WorkflowPipeStage | ChildWorkflowTarget>,
  input: unknown,
): Generator<ContextOperationRequest, TResult, unknown> {
  const pipelineToken = createCompositionToken(internals, 'pipe');
  let currentInput = input;

  for (const [index, stage] of stages.entries()) {
    const resolvedStage = normalizePipeStage(internals, stage);
    currentInput = yield* context.startChild(
      resolvedStage.workflowType,
      currentInput,
      createCompositionChildWorkflowOptions(internals, pipelineToken, index, resolvedStage.options),
    );
  }

  return currentInput as TResult;
}

export function* map<TItem, TResult>(
  context: Context,
  internals: ContextInternals,
  items: readonly TItem[],
  workflowType: ChildWorkflowTarget<TItem, TResult>,
  options?: WorkflowMapOptions,
): Generator<ContextOperationRequest, TResult[], unknown> {
  if (items.length === 0) {
    return [];
  }

  const mapToken = createCompositionToken(internals, 'map');
  const concurrency = resolveMapConcurrency(items.length, options?.concurrency);
  const resolvedWorkflowType = resolveChildWorkflowTarget(internals, workflowType);
  const results: TResult[] = [];

  for (let startIndex = 0; startIndex < items.length; startIndex += concurrency) {
    const batchItems = items.slice(startIndex, startIndex + concurrency);
    const batchResults = yield* context.all(
      batchItems.map((item, batchIndex) =>
        context.startChild<TResult>(
          resolvedWorkflowType,
          item,
          createCompositionChildWorkflowOptions(internals, mapToken, startIndex + batchIndex),
        ),
      ),
    );

    for (let batchIndex = 0; batchIndex < batchResults.length; batchIndex++) {
      results[startIndex + batchIndex] = batchResults[batchIndex]!;
    }
  }

  return results;
}

export function* reduce<TItem, TAccumulator>(
  context: Context,
  internals: ContextInternals,
  items: readonly TItem[],
  workflowType: ChildWorkflowTarget<WorkflowReduceInput<TAccumulator, TItem>, TAccumulator>,
  initialValue: TAccumulator,
  options?: WorkflowReduceOptions,
): Generator<ContextOperationRequest, TAccumulator, unknown> {
  if (items.length === 0) {
    return initialValue;
  }

  const reduceToken = createCompositionToken(internals, 'reduce');
  const resolvedWorkflowType = resolveChildWorkflowTarget(internals, workflowType);
  let accumulator = initialValue;

  for (const [index, item] of items.entries()) {
    accumulator = yield* context.startChild<TAccumulator>(
      resolvedWorkflowType,
      {
        accumulator,
        item,
        index,
      },
      createReduceChildWorkflowOptions(internals, reduceToken, index, options),
    );
  }

  return accumulator;
}
