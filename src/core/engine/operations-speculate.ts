import type { ContextOperationRequest } from '../context.ts';
import type { WorkflowTimelineOperationDetail } from '../types.ts';
import { finalizeAndUnwrap } from './deferred-consume-envelope.ts';
import type { EngineInternals } from './internals.ts';
import { assertSupportedSignalBranches } from './operations-coordination.ts';
import type { OperationWithCallerStack } from './operations-router.ts';
import { SpeculativeExecutionState } from './speculative-execution-state.ts';
import {
  operationTimelineDetail,
  recordTimelineSpeculation,
} from './timeline-coordinator-detail.ts';

type SpeculateOperation = Extract<ContextOperationRequest, { type: 'speculate' }>;
type SpeculativeOperationGenerator =
  | Generator<ContextOperationRequest, unknown, unknown>
  | AsyncGenerator<ContextOperationRequest, unknown, unknown>;

export type SpeculateOperationCallbacks = {
  runOperationWithResult: (
    workflowId: string,
    operation: OperationWithCallerStack,
    execute: () => Promise<unknown>,
  ) => Promise<void>;
  executeSubOperation: (
    workflowId: string,
    operation: ContextOperationRequest,
    signal?: AbortSignal,
    speculativeState?: SpeculativeExecutionState,
  ) => Promise<unknown>;
};

export async function processSpeculateOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: SpeculateOperation,
  callbacks: SpeculateOperationCallbacks,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, () =>
    executeSpeculativeBranch(internals, workflowId, operation, callbacks),
  );
}

export async function executeSpeculativeBranch(
  internals: EngineInternals,
  workflowId: string,
  operation: SpeculateOperation,
  callbacks: Pick<SpeculateOperationCallbacks, 'executeSubOperation'>,
): Promise<unknown> {
  const inlineStrategy = internals.inlineStrategy;
  if (!inlineStrategy) {
    throw new Error('ctx.speculate() requires inline execution mode');
  }

  const parentContext = inlineStrategy.getContext(workflowId);
  if (!parentContext) {
    throw new Error(`No active inline context for workflow "${workflowId}"`);
  }

  const speculativeContext = parentContext.createSpeculativeChild();
  const speculativeState = new SpeculativeExecutionState();
  const generator = createSpeculativeOperationGenerator(operation, speculativeContext);
  const children: WorkflowTimelineOperationDetail[] = [];

  try {
    const result = await driveSpeculativeGenerator(
      workflowId,
      generator,
      speculativeState,
      callbacks,
      (child, index, error) => {
        children.push(
          operationTimelineDetail(
            child,
            index,
            error === undefined ? 'fulfilled' : 'rejected',
            error === undefined ? {} : { error },
          ),
        );
      },
    );
    await speculativeState.drainVerifications();
    parentContext.commitSpeculativeChild(speculativeContext);
    recordTimelineSpeculation(internals, workflowId, children, 'committed');
    return result;
  } catch (error) {
    try {
      await speculativeState.rollback();
    } finally {
      recordTimelineSpeculation(internals, workflowId, children, 'rolled-back');
    }
    throw error;
  }
}

function createSpeculativeOperationGenerator(
  operation: SpeculateOperation,
  speculativeContext: Parameters<SpeculateOperation['execute']>[0],
): SpeculativeOperationGenerator {
  // Context.speculate() only accepts workflows that yield ContextOperationRequest
  // values; the stored operation type is wider for async generators.
  return operation.execute(speculativeContext) as SpeculativeOperationGenerator;
}

export async function driveSpeculativeGenerator(
  workflowId: string,
  generator: SpeculativeOperationGenerator,
  speculativeState: SpeculativeExecutionState,
  callbacks: Pick<SpeculateOperationCallbacks, 'executeSubOperation'>,
  observeChild?: (operation: ContextOperationRequest, index: number, error?: unknown) => void,
): Promise<unknown> {
  let childIndex = 0;
  const advance = async (
    lastResult: unknown,
    errorToThrow: Error | undefined,
  ): Promise<unknown> => {
    const iterationResult =
      errorToThrow === undefined
        ? await generator.next(lastResult)
        : await generator.throw(errorToThrow);

    if (iterationResult.done) {
      return iterationResult.value;
    }

    const nextOperation = iterationResult.value;
    const currentChildIndex = childIndex++;
    try {
      // The top-level `processRaceOperation` / `processParallelOperation`
      // reject a `race` / `all` whose branches wait on the same signal name
      // (a shared waiter key would clobber). The speculate driver routes a
      // yielded `race` / `parallel` straight to the nested executors, which
      // never run that check — so enforce it here, on the input op, BEFORE
      // dispatch (the clobbering registration happens inside execute) and
      // INSIDE the try (so a throw routes through `generator.throw` and
      // surfaces at the workflow's `yield*`, matching top-level catchability).
      // `assertSupportedSignalBranches` walks nested race/parallel recursively,
      // so one call covers the whole subtree.
      if (nextOperation.type === 'race' || nextOperation.type === 'parallel') {
        assertSupportedSignalBranches(nextOperation.operations);
      }
      const nextResult = await callbacks.executeSubOperation(
        workflowId,
        nextOperation,
        undefined,
        speculativeState,
      );
      // This driver is a top-level coordinator: a `race` / `parallel` sub-operation
      // yielded here resolves with an unfinalized deferred-consume envelope (or an
      // array of them, from a nested coordinator) when a `wait-signal` branch wins,
      // because only the TOP coordinator finalizes. There is no outer
      // `processRaceOperation` wrapping this — `executeSubOperation` routes straight
      // to the nested executors — so the speculate driver IS the linearization
      // point of "this yielded op produced this result". Finalize-and-unwrap before
      // feeding the value to the generator, both so the workflow sees the payload
      // (not a `{ finalize }` function) and so the winner's durable signal is
      // consumed exactly once. `finalizeAndUnwrap` is idempotent on non-envelope
      // values and the envelope is Symbol-branded, so applying it unconditionally is
      // safe for every operation type. The consume is a durable effect that, like an
      // uncompensated speculative activity write, persists even if the speculation
      // later rolls back.
      const finalizedResult = await finalizeAndUnwrap(nextResult);
      observeChild?.(nextOperation, currentChildIndex);
      return advance(finalizedResult, undefined);
    } catch (error) {
      observeChild?.(nextOperation, currentChildIndex, error);
      return advance(lastResult, error instanceof Error ? error : new Error(String(error)));
    }
  };

  return advance(undefined, undefined);
}
