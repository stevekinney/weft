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
import { Context, setContextWorkflowInterceptor } from './context.ts';
import type { ExecutionStrategy } from './execution-strategy.ts';
import {
  classifyErrorAsFailureCategory,
  errorFromFailedOperationOutcome,
} from './failure-categories.ts';
import type {
  InlineExecutionDependencies,
  InlineStartWorkflowParameters,
} from './inline-execution-strategy.context-options.ts';
import { createInlineContextOptions } from './inline-execution-strategy.context-options.ts';
import type { FailureCategory, OperationOutcome, WorkerOutboundMessage } from './types.ts';

// ---------------------------------------------------------------------------
// InlineExecutionStrategy
// ---------------------------------------------------------------------------

export class InlineExecutionStrategy implements ExecutionStrategy {
  readonly #dependencies: InlineExecutionDependencies;
  readonly #generators: Map<string, AsyncGenerator>;
  readonly #abortControllers: Map<string, AbortController>;
  readonly #contexts: Map<string, Context>;
  /** Contexts retained for parked workflows so `ctx.onQuery` handlers remain callable. */
  readonly #parkedContexts: Map<string, Context>;
  readonly #workflowAdvances: Map<string, Promise<void>>;
  readonly #workflowTurns: Map<string, Promise<void>>;
  #messageHandler: ((message: WorkerOutboundMessage) => void | Promise<void>) | null;

  constructor(dependencies: InlineExecutionDependencies) {
    this.#dependencies = dependencies;
    this.#generators = new Map();
    this.#abortControllers = new Map();
    this.#contexts = new Map();
    this.#parkedContexts = new Map();
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

  /**
   * Evict a workflow's in-memory execution state (generator, abort controller,
   * live context, tracked turns/advances).
   *
   * By default this is a hard eviction: nothing about the run stays reachable —
   * which is what the suspend/general teardown path requires. The inline
   * `waitForSignal` parking optimization opts into `retainContext: true` so the
   * run's Context survives in `#parkedContexts` and its `ctx.onQuery` handlers
   * stay callable while the run is parked. Retention is therefore strictly
   * opt-in at the one call site that wants it; every other caller gets eviction.
   */
  parkWorkflow(workflowId: string, options?: { retainContext?: boolean }): void {
    // On the retain path, fall back to an already-parked context so a second
    // retaining park (no intervening resume) is idempotent rather than dropping
    // the retained entry. The default (evict) path reads nothing — that is what
    // makes suspend/terminate a true hard eviction and must NOT consult
    // #parkedContexts, or the suspend-on-signal-parked leak returns.
    const context = options?.retainContext
      ? (this.#contexts.get(workflowId) ?? this.#parkedContexts.get(workflowId))
      : undefined;
    this.#cleanup(workflowId);
    if (context !== undefined) {
      this.#parkedContexts.set(workflowId, context);
    }
  }

  // -------------------------------------------------------------------------
  // Context access (for the engine to look up active contexts)
  // -------------------------------------------------------------------------

  /** Returns the live Context for a workflow, or `undefined` if not running. For parked workflows use {@link getParkedContext}. */
  getContext(workflowId: string): Context | undefined {
    return this.#contexts.get(workflowId);
  }

  /** Returns the retained Context for a parked workflow, or `undefined` if not parked or already cleaned up. */
  getParkedContext(workflowId: string): Context | undefined {
    return this.#parkedContexts.get(workflowId);
  }

  /**
   * Drop any retained parked Context for a workflow without touching the abort
   * controller or other live state. Terminal cleanup calls this so a workflow
   * that reached a terminal status while parked (e.g. a failed resume, or normal
   * completion of a run that had parked) cannot keep resolving `ctx.onQuery`
   * handlers from a stale parked Context — and so the Context is not retained
   * for the engine's lifetime.
   */
  clearParkedContext(workflowId: string): void {
    this.#parkedContexts.delete(workflowId);
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
   * Store a context and generator created externally (engine resume path).
   * Clears any retained parked context so a concurrent query sees the new
   * live context rather than the stale parked one.
   */
  adoptWorkflow(
    workflowId: string,
    generator: AsyncGenerator,
    context: Context,
    abortController: AbortController,
  ): void {
    this.#parkedContexts.delete(workflowId);
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
    this.#parkedContexts.clear();
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
    return this.#advanceGenerator(workflowId, () => generator.next(lastResult), undefined);
  }

  #throwIntoGenerator(
    workflowId: string,
    generator: AsyncGenerator,
    error: unknown,
    operationFailureCategory?: FailureCategory,
  ): Promise<void> {
    return this.#advanceGenerator(
      workflowId,
      () => generator.throw(error),
      operationFailureCategory,
    );
  }

  #advanceGenerator(
    workflowId: string,
    advance: () => Promise<IteratorResult<unknown, unknown>>,
    fallbackFailureCategory: FailureCategory | undefined,
  ): Promise<void> {
    return this.#trackWorkflowAdvance(
      workflowId,
      (async () => {
        try {
          const abortController = this.#abortControllers.get(workflowId);
          if (abortController?.signal.aborted) return;

          const iterationResult = await advance();

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
            failureCategory:
              fallbackFailureCategory ??
              classifyErrorAsFailureCategory(error, {
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
    this.#parkedContexts.delete(workflowId);
    if (!options?.preserveTrackedAdvance) {
      this.#workflowAdvances.delete(workflowId);
    }
    if (!options?.preserveTrackedTurn) {
      this.#workflowTurns.delete(workflowId);
    }
  }
}
