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

import type { ContextOperationRequest } from './context.ts';
import { Context } from './context.ts';
import type { ExecutionStrategy } from './execution-strategy.ts';
import type { TenantContext } from './tenant.ts';
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
  maxNestingDepth: number;
  development?: boolean;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify an error into a {@link FailureCategory} without importing the
 * concrete error classes (avoids cross-module circular imports). Uses `.name`
 * for class-based discrimination and falls back to `'system'`.
 *
 * Error names that map to specific categories:
 * - `'ToolSchemaValidationError'` → `'planning'` (LLM produced an invalid tool call)
 * - `'ToolCallReplayConflictError'` → `'action'` (tool replay conflict; execution-phase)
 * - `'MCPServerUnavailableError'`, `'MCPToolTimeoutError'` → `'action'` (tool execution)
 * - everything else → `'system'`
 */
function classifyErrorAsFailureCategory(error: unknown): FailureCategory {
  if (!(error instanceof Error)) {
    return 'system';
  }

  switch (error.name) {
    case 'ToolSchemaValidationError':
      return 'planning';
    case 'ToolCallReplayConflictError':
    case 'MCPServerUnavailableError':
    case 'MCPToolTimeoutError':
      return 'action';
    default:
      return 'system';
  }
}

// ---------------------------------------------------------------------------
// InlineExecutionStrategy
// ---------------------------------------------------------------------------

export class InlineExecutionStrategy implements ExecutionStrategy {
  readonly #dependencies: InlineExecutionDependencies;
  readonly #generators: Map<string, AsyncGenerator>;
  readonly #abortControllers: Map<string, AbortController>;
  readonly #contexts: Map<string, Context>;
  #messageHandler: ((message: WorkerOutboundMessage) => void) | null;

  constructor(dependencies: InlineExecutionDependencies) {
    this.#dependencies = dependencies;
    this.#generators = new Map();
    this.#abortControllers = new Map();
    this.#contexts = new Map();
    this.#messageHandler = null;
  }

  // -------------------------------------------------------------------------
  // ExecutionStrategy interface
  // -------------------------------------------------------------------------

  onMessage(handler: (message: WorkerOutboundMessage) => void): void {
    this.#messageHandler = handler;
  }

  startWorkflow(parameters: {
    workflowId: string;
    workflowType: string;
    input: unknown;
    checkpoint: ArrayBuffer | Uint8Array;
    nestingDepth?: number;
    deadline?: number;
    headers?: [string, string][];
    tenant?: TenantContext;
  }): void {
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

    const context = new Context({
      workflowId: parameters.workflowId,
      workflowType: parameters.workflowType,
      startedAt: this.#dependencies.getNow(),
      abortController: workflowAbort,
      getNow: this.#dependencies.getNow,
      nestingDepth: parameters.nestingDepth ?? 0,
      ...(registration.searchAttributes && {
        searchAttributeSchema: registration.searchAttributes,
      }),
      ...(parameters.deadline !== undefined && { deadline: parameters.deadline }),
      ...(parameters.tenant !== undefined && { tenant: parameters.tenant }),
    });

    if (this.#dependencies.development) {
      context.explain(true);
    }

    this.#contexts.set(parameters.workflowId, context);

    const generator = registration.handler(context, parameters.input);
    this.#generators.set(parameters.workflowId, generator);

    // Drive the generator (non-blocking)
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
    const error =
      parameters.operationResult.status === 'failed'
        ? new Error(parameters.operationResult.error)
        : undefined;

    if (error) {
      void this.#throwIntoGenerator(parameters.workflowId, generator, error);
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

  // -------------------------------------------------------------------------
  // Context access (for the engine to look up active contexts)
  // -------------------------------------------------------------------------

  getContext(workflowId: string): Context | undefined {
    return this.#contexts.get(workflowId);
  }

  getAbortController(workflowId: string): AbortController | undefined {
    return this.#abortControllers.get(workflowId);
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
  throwIntoWorkflow(workflowId: string, error: Error): void {
    const generator = this.#generators.get(workflowId);
    if (!generator) return;
    void this.#throwIntoGenerator(workflowId, generator, error);
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
    this.#messageHandler = null;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this[Symbol.dispose]();
  }

  // -------------------------------------------------------------------------
  // Private: generator driving
  // -------------------------------------------------------------------------

  async #driveGenerator(
    workflowId: string,
    generator: AsyncGenerator,
    lastResult: unknown,
  ): Promise<void> {
    try {
      const abortController = this.#abortControllers.get(workflowId);
      if (abortController?.signal.aborted) return;

      const iterationResult = await generator.next(lastResult);

      if (iterationResult.done) {
        this.#cleanup(workflowId);
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
      this.#cleanup(workflowId);
      const failedMessage: WorkerOutboundMessage = {
        type: 'failed',
        workflowId,
        error: error instanceof Error ? error.message : String(error),
        failureCategory: classifyErrorAsFailureCategory(error),
      };
      if (error instanceof Error && error.stack !== undefined) {
        failedMessage.errorStack = error.stack;
      }
      this.#emit(failedMessage);
    }
  }

  async #throwIntoGenerator(
    workflowId: string,
    generator: AsyncGenerator,
    error: Error,
  ): Promise<void> {
    try {
      const iterationResult = await generator.throw(error);

      if (iterationResult.done) {
        this.#cleanup(workflowId);
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
      this.#cleanup(workflowId);
      const failedMessage: WorkerOutboundMessage = {
        type: 'failed',
        workflowId,
        error: innerError instanceof Error ? innerError.message : String(innerError),
        failureCategory: classifyErrorAsFailureCategory(innerError),
      };
      if (innerError instanceof Error && innerError.stack !== undefined) {
        failedMessage.errorStack = innerError.stack;
      }
      this.#emit(failedMessage);
    }
  }

  // -------------------------------------------------------------------------
  // Private: helpers
  // -------------------------------------------------------------------------

  #emit(message: WorkerOutboundMessage): void {
    this.#messageHandler?.(message);
  }

  #cleanup(workflowId: string): void {
    this.#generators.delete(workflowId);
    this.#abortControllers.delete(workflowId);
    this.#contexts.delete(workflowId);
  }
}
