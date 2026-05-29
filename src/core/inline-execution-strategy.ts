/**
 * Inline execution strategy: runs workflows on the main thread.
 *
 * This strategy drives async generators directly in the calling context,
 * emitting {@link WorkerOutboundMessage} to the engine via a callback.
 * It is the default execution model and preserves the original behavior
 * where the engine manages generators, abort controllers, and contexts
 * in-process.
 *
 * @module core/inline-execution-strategy
 */

import type { ContextOperationRequest, ContextOptions } from './context.ts';
import { Context, setContextWorkflowInterceptor } from './context.ts';
import type { ExecutionStrategy } from './execution-strategy.ts';
import {
  classifyErrorAsFailureCategory,
  errorFromFailedOperationOutcome,
} from './failure-categories.ts';
import type { ComposedWorkflowInterceptor } from './interceptor.ts';
import type {
  FailureCategory,
  OperationOutcome,
  SearchAttributeSchema,
  WorkerOutboundMessage,
  WorkflowFunction,
} from './types.ts';

// ---------------------------------------------------------------------------
// Dependencies injected by the engine
// ---------------------------------------------------------------------------

export interface InlineExecutionDependencies {
  getRegistration: (workflowType: string) =>
    | {
        handler: WorkflowFunction;
        version: string;
        searchAttributes?: SearchAttributeSchema;
      }
    | undefined;
  getNow: () => number;
  resolveWorkflowType?: (target: string | Function) => string;
  maxNestingDepth: number;
  development?: boolean;
  getComposedWorkflowInterceptor?: () => ComposedWorkflowInterceptor | null;
  registerCancelHandler?: (workflowId: string, handler: () => Promise<void> | void) => () => void;
}

type InlineWorkflowRegistration = NonNullable<
  ReturnType<InlineExecutionDependencies['getRegistration']>
>;

type InlineStartWorkflowParameters = {
  workflowId: string;
  workflowType: string;
  input: unknown;
  checkpoint: ArrayBuffer | Uint8Array;
  nestingDepth?: number;
  executionStateOwnerId?: string;
  startedAt?: number;
  sleepReferenceTime?: number;
  deadline?: number;
  headers?: [string, string][];
};

function createInlineContextOptions(
  dependencies: InlineExecutionDependencies,
  registration: InlineWorkflowRegistration,
  parameters: InlineStartWorkflowParameters,
  workflowAbort: AbortController,
): ContextOptions {
  const { registerCancelHandler } = dependencies;
  return {
    workflowId: parameters.workflowId,
    workflowType: parameters.workflowType,
    startedAt: parameters.startedAt ?? dependencies.getNow(),
    abortController: workflowAbort,
    getNow: dependencies.getNow,
    nestingDepth: parameters.nestingDepth ?? 0,
    executionStateOwnerId: parameters.executionStateOwnerId ?? parameters.workflowId,
    ...(parameters.sleepReferenceTime !== undefined && {
      sleepReferenceTime: parameters.sleepReferenceTime,
    }),
    ...(dependencies.resolveWorkflowType !== undefined && {
      resolveWorkflowType: dependencies.resolveWorkflowType,
    }),
    ...(registration.searchAttributes && {
      searchAttributeSchema: registration.searchAttributes,
    }),
    ...(parameters.deadline !== undefined && { deadline: parameters.deadline }),
    ...(registerCancelHandler !== undefined && {
      registerCancelHandler: (handler) => registerCancelHandler(parameters.workflowId, handler),
    }),
  };
}

// ---------------------------------------------------------------------------
// InlineExecutionStrategy
// ---------------------------------------------------------------------------

export class InlineExecutionStrategy implements ExecutionStrategy {
  readonly #dependencies: InlineExecutionDependencies;
  readonly #generators: Map<string, AsyncGenerator>;
  readonly #abortControllers: Map<string, AbortController>;
  readonly #contexts: Map<string, Context>;
  readonly #workflowAdvances: Map<string, Promise<void>>;
  readonly #workflowTurns: Map<string, Promise<void>>;
  #messageHandler: ((message: WorkerOutboundMessage) => void | Promise<void>) | null;

  constructor(dependencies: InlineExecutionDependencies) {
    this.#dependencies = dependencies;
    this.#generators = new Map();
    this.#abortControllers = new Map();
    this.#contexts = new Map();
    this.#workflowAdvances = new Map();
    this.#workflowTurns = new Map();
    this.#messageHandler = null;
  }

  // -------------------------------------------------------------------------
  // ExecutionStrategy interface
  // -------------------------------------------------------------------------

  onMessage(handler: (message: WorkerOutboundMessage) => void | Promise<void>): void {
    this.#messageHandler = handler;
  }

  startWorkflow(parameters: InlineStartWorkflowParameters): void {
    const registration = this.#dependencies.getRegistration(parameters.workflowType);
    if (!registration) {
      this.#emit({
        type: 'failed',
        workflowId: parameters.workflowId,
        error: `No workflow registered with name "${parameters.workflowType}"`,
      });
      return;
    }

    const workflowAbort = new AbortController();
    this.#abortControllers.set(parameters.workflowId, workflowAbort);

    const context = new Context(
      createInlineContextOptions(this.#dependencies, registration, parameters, workflowAbort),
    );
    const workflowInterceptor = this.#dependencies.getComposedWorkflowInterceptor?.() ?? null;
    setContextWorkflowInterceptor(context, workflowInterceptor);

    if (this.#dependencies.development) {
      context.explain(true);
    }

    this.#contexts.set(parameters.workflowId, context);

    const generator = registration.handler(context, parameters.input);
    this.#generators.set(parameters.workflowId, generator);

    void this.#driveGenerator(parameters.workflowId, generator, undefined);
  }

  resumeWorkflow(parameters: {
    workflowId: string;
    checkpoint: ArrayBuffer | Uint8Array;
    operationResult: OperationOutcome;
  }): void {
    const generator = this.#generators.get(parameters.workflowId);
    if (!generator) {
      this.#emit({
        type: 'failed',
        workflowId: parameters.workflowId,
        error: `No active generator for workflow: ${parameters.workflowId}`,
      });
      return;
    }

    const result =
      parameters.operationResult.status === 'completed'
        ? parameters.operationResult.value
        : undefined;
    const operationFailureCategory =
      parameters.operationResult.status === 'failed'
        ? parameters.operationResult.failureCategory
        : undefined;
    const error =
      parameters.operationResult.status === 'failed'
        ? errorFromFailedOperationOutcome(parameters.operationResult)
        : undefined;

    if (error) {
      void this.#throwIntoGenerator(
        parameters.workflowId,
        generator,
        error,
        operationFailureCategory,
      );
    } else {
      void this.#driveGenerator(parameters.workflowId, generator, result);
    }
  }

  cancelWorkflow(workflowId: string): void {
    const abortController = this.#abortControllers.get(workflowId);
    if (abortController) {
      abortController.abort();
    }
    this.#cleanup(workflowId);
  }

  parkWorkflow(workflowId: string): void {
    this.#cleanup(workflowId);
  }

  // -------------------------------------------------------------------------
  // Context access (for the engine to look up active contexts)
  // -------------------------------------------------------------------------

  getContext(workflowId: string): Context | undefined {
    return this.#contexts.get(workflowId);
  }

  getAbortController(workflowId: string): AbortController | undefined {
    return this.#abortControllers.get(workflowId);
  }

  waitForWorkflowTurn(workflowId: string): Promise<void> | undefined {
    return this.#workflowTurns.get(workflowId);
  }

  waitForWorkflowAdvance(workflowId: string): Promise<void> | undefined {
    return this.#workflowAdvances.get(workflowId);
  }

  hasGenerator(workflowId: string): boolean {
    return this.#generators.has(workflowId);
  }

  /**
   * Resume the generator with a value (used by the engine after inline
   * operation processing like timers, signals, etc.).
   */
  continueWorkflow(workflowId: string, value: unknown): void {
    const generator = this.#generators.get(workflowId);
    if (!generator) return;
    void this.#driveGenerator(workflowId, generator, value);
  }

  /**
   * Throw an error into the generator (used by the engine for propagating
   * activity failures, etc.).
   */
  throwIntoWorkflow(
    workflowId: string,
    error: unknown,
    operationFailureCategory?: FailureCategory,
  ): void {
    const generator = this.#generators.get(workflowId);
    if (!generator) return;
    void this.#throwIntoGenerator(workflowId, generator, error, operationFailureCategory);
  }

  /**
   * Store a context and generator that were created externally (used by
   * the engine's resume() path where context setup is more complex).
   */
  adoptWorkflow(
    workflowId: string,
    generator: AsyncGenerator,
    context: Context,
    abortController: AbortController,
  ): void {
    this.#generators.set(workflowId, generator);
    this.#contexts.set(workflowId, context);
    this.#abortControllers.set(workflowId, abortController);
  }

  // -------------------------------------------------------------------------
  // Disposal
  // -------------------------------------------------------------------------

  [Symbol.dispose](): void {
    this.#generators.clear();
    this.#abortControllers.clear();
    this.#contexts.clear();
    this.#workflowAdvances.clear();
    this.#workflowTurns.clear();
    this.#messageHandler = null;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this[Symbol.dispose]();
  }

  // -------------------------------------------------------------------------
  // Private: generator driving
  // -------------------------------------------------------------------------

  #driveGenerator(
    workflowId: string,
    generator: AsyncGenerator,
    lastResult: unknown,
  ): Promise<void> {
    return this.#trackWorkflowAdvance(
      workflowId,
      (async () => {
        try {
          const abortController = this.#abortControllers.get(workflowId);
          if (abortController?.signal.aborted) return;

          const iterationResult = await generator.next(lastResult);

          if (iterationResult.done) {
            this.#cleanup(workflowId, {
              preserveTrackedAdvance: true,
              preserveTrackedTurn: true,
            });
            this.#emit({
              type: 'completed',
              workflowId,
              result: iterationResult.value,
            });
            return;
          }

          // The yielded value is a ContextOperationRequest. Emit it as a
          // checkpoint message so the engine can process the operation.
          const operation = iterationResult.value as ContextOperationRequest;
          this.#emit({
            type: 'checkpoint',
            workflowId,
            checkpoint: new ArrayBuffer(0),
            operationRequest: operation as never,
          });
        } catch (error) {
          this.#cleanup(workflowId, {
            preserveTrackedAdvance: true,
            preserveTrackedTurn: true,
          });
          const failedMessage: WorkerOutboundMessage = {
            type: 'failed',
            workflowId,
            error: error instanceof Error ? error.message : String(error),
            failureCategory: classifyErrorAsFailureCategory(error, {
              defaultErrorCategory: 'application',
            }),
          };
          if (error instanceof Error && error.stack !== undefined) {
            failedMessage.errorStack = error.stack;
          }
          this.#emit(failedMessage);
        }
      })(),
    );
  }

  #throwIntoGenerator(
    workflowId: string,
    generator: AsyncGenerator,
    error: unknown,
    operationFailureCategory?: FailureCategory,
  ): Promise<void> {
    return this.#trackWorkflowAdvance(
      workflowId,
      (async () => {
        try {
          const abortController = this.#abortControllers.get(workflowId);
          if (abortController?.signal.aborted) return;

          const iterationResult = await generator.throw(error);

          if (iterationResult.done) {
            this.#cleanup(workflowId, {
              preserveTrackedAdvance: true,
              preserveTrackedTurn: true,
            });
            this.#emit({
              type: 'completed',
              workflowId,
              result: iterationResult.value,
            });
            return;
          }

          const operation = iterationResult.value as ContextOperationRequest;
          this.#emit({
            type: 'checkpoint',
            workflowId,
            checkpoint: new ArrayBuffer(0),
            operationRequest: operation as never,
          });
        } catch (innerError) {
          this.#cleanup(workflowId, {
            preserveTrackedAdvance: true,
            preserveTrackedTurn: true,
          });
          const failedMessage: WorkerOutboundMessage = {
            type: 'failed',
            workflowId,
            error: innerError instanceof Error ? innerError.message : String(innerError),
            failureCategory:
              operationFailureCategory ??
              classifyErrorAsFailureCategory(innerError, {
                defaultErrorCategory: 'application',
              }),
          };
          if (innerError instanceof Error && innerError.stack !== undefined) {
            failedMessage.errorStack = innerError.stack;
          }
          this.#emit(failedMessage);
        }
      })(),
    );
  }

  // -------------------------------------------------------------------------
  // Private: helpers
  // -------------------------------------------------------------------------

  #trackWorkflowAdvance(workflowId: string, pendingAdvance: Promise<void>): Promise<void> {
    const trackedAdvance = pendingAdvance.finally(() => {
      if (this.#workflowAdvances.get(workflowId) === trackedAdvance) {
        this.#workflowAdvances.delete(workflowId);
      }
    });
    void trackedAdvance.catch(() => {});
    this.#workflowAdvances.set(workflowId, trackedAdvance);
    return trackedAdvance;
  }

  #trackWorkflowTurn(workflowId: string, pendingTurn: Promise<void>): Promise<void> {
    const trackedTurn = pendingTurn.finally(() => {
      if (this.#workflowTurns.get(workflowId) === trackedTurn) {
        this.#workflowTurns.delete(workflowId);
      }
    });
    // Most callers do not observe these turns directly. Mark the promise as
    // observed so handler failures stay contained.
    void trackedTurn.catch(() => {});
    this.#workflowTurns.set(workflowId, trackedTurn);
    return trackedTurn;
  }

  #emit(message: WorkerOutboundMessage): void {
    const result = this.#messageHandler?.(message);
    if (result instanceof Promise) {
      void this.#trackWorkflowTurn(message.workflowId, result);
      return;
    }

    this.#workflowTurns.delete(message.workflowId);
  }

  #cleanup(
    workflowId: string,
    options?: { preserveTrackedAdvance?: boolean; preserveTrackedTurn?: boolean },
  ): void {
    this.#generators.delete(workflowId);
    this.#abortControllers.delete(workflowId);
    this.#contexts.delete(workflowId);
    if (!options?.preserveTrackedAdvance) {
      this.#workflowAdvances.delete(workflowId);
    }
    if (!options?.preserveTrackedTurn) {
      this.#workflowTurns.delete(workflowId);
    }
  }
}
