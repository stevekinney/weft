/**
 * Step-based workflow context — progressive disclosure API.
 *
 * Bridges plain async functions with the generator protocol used internally
 * by the engine. Users write `await ctx.step(name, fn)` and the compiler
 * produces a generator that yields one operation at a time.
 *
 * @module core/step-context
 */

import type { ContextOperationRequest } from './context.ts';
import type { StepWorkflowContext, WorkflowFunction } from './types.ts';

// ---------------------------------------------------------------------------
// Queued operation — one pending ctx.step() call
// ---------------------------------------------------------------------------

interface QueuedOperation {
  request: ContextOperationRequest;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

// ---------------------------------------------------------------------------
// StepContext
// ---------------------------------------------------------------------------

/**
 * Internal implementation of {@link StepWorkflowContext} for step-based
 * ("progressive disclosure") workflows. Wraps the generator protocol in a
 * queue so that plain `async function` workflows can be registered on the
 * engine without writing explicit generators. Build via
 * {@link compileStepWorkflow} rather than constructing directly.
 *
 * @example
 * ```ts
 * import { StepContext } from '@lostgradient/weft';
 *
 * const controller = new AbortController();
 * const ctx = new StepContext('wf-demo', controller.signal);
 * ctx.step('fetch', async () => ({ name: 'Alice' })).then(console.log);
 * void ctx;
 * ```
 */
export class StepContext implements StepWorkflowContext {
  readonly workflowId: string;
  readonly signal: AbortSignal;

  #queue: QueuedOperation[] = [];
  #notifyQueue: (() => void) | undefined;
  #done = false;

  constructor(workflowId: string, signal: AbortSignal) {
    this.workflowId = workflowId;
    this.signal = signal;
  }

  async step<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const operationId = crypto.randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();

    this.#queue.push({
      request: {
        type: 'activity',
        operationId,
        activityName: name,
        fn: fn as (input: unknown) => unknown,
        input: undefined,
      },
      resolve,
      reject,
    });

    this.#notifyQueue?.();

    return promise as Promise<T>;
  }

  /** Called by the generator loop to wait for the next operation. */
  async dequeue(): Promise<QueuedOperation | null> {
    if (this.#queue.length > 0) {
      return this.#queue.shift()!;
    }
    if (this.#done) return null;

    const { promise, resolve } = Promise.withResolvers<void>();
    this.#notifyQueue = resolve;
    await promise;
    this.#notifyQueue = undefined;

    if (this.#done && this.#queue.length === 0) return null;
    return this.#queue.shift() ?? null;
  }

  /** Unblocks dequeue() when the user function completes. */
  signalDone(): void {
    this.#done = true;
    this.#notifyQueue?.();
  }
}

// ---------------------------------------------------------------------------
// compileStepWorkflow — wraps a StepWorkflowFunction into a WorkflowFunction
// ---------------------------------------------------------------------------

/**
 * Wraps a {@link StepWorkflowFunction} (a plain `async function` using
 * `ctx.step`) into a durable {@link WorkflowFunction} generator that the
 * engine can register and persist. This bridges the "progressive disclosure"
 * API with the underlying generator protocol.
 *
 * @example
 * ```ts
 * import { workflow, Engine, compileStepWorkflow, type StepWorkflowContext } from '@lostgradient/weft';
 *
 * async function process(ctx: StepWorkflowContext, input: unknown) {
 *   const upper = await ctx.step('uppercase', () =>
 *     (input as string).toUpperCase(),
 *   );
 *   return upper;
 * }
 *
 * const engine = new Engine();
 * engine.register(workflow({ name: 'process' }).execute(compileStepWorkflow(process)));
 * const result = await (await engine.start('process', 'hello')).result();
 * console.log(result); // 'HELLO'
 * ```
 */
export function compileStepWorkflow<TInput = unknown, TOutput = unknown>(
  stepFunction: (context: StepWorkflowContext, input: TInput) => Promise<TOutput>,
): WorkflowFunction<TInput, TOutput> {
  return async function* (_rawContext, input) {
    // Extract workflowId and signal from the raw context
    const rawContext = _rawContext as { workflowId: string; signal: AbortSignal };
    const stepContext = new StepContext(rawContext.workflowId, rawContext.signal);

    let workflowResult: TOutput | undefined;
    let workflowError: unknown;

    // Start the user's async function concurrently
    const userPromise = stepFunction(stepContext, input)
      .then((result) => {
        workflowResult = result;
        stepContext.signalDone();
        return undefined;
      })
      .catch((error: unknown) => {
        workflowError = error;
        stepContext.signalDone();
      });

    // Generator loop: yield operations to the engine one at a time
    while (true) {
      const queued = await stepContext.dequeue();
      if (queued === null) break;

      try {
        const result = yield queued.request;
        queued.resolve(result);
      } catch (error) {
        queued.reject(error);
      }
    }

    // Wait for the user function to fully settle
    await userPromise;

    if (workflowError !== undefined) {
      if (workflowError instanceof Error) {
        throw workflowError;
      }
      throw new Error(
        typeof workflowError === 'string' ? workflowError : JSON.stringify(workflowError),
      );
    }

    return workflowResult as TOutput;
  };
}

// ---------------------------------------------------------------------------
// Detection helper
// ---------------------------------------------------------------------------

function* sampleSyncGenerator(): Generator<undefined> {
  yield undefined;
}

async function* sampleAsyncGenerator(): AsyncGenerator<undefined> {
  yield undefined;
}

function getGeneratorDetectionPrototypes(): {
  syncGeneratorFunctionPrototype: object;
  asyncGeneratorFunctionPrototype: object;
  syncGeneratorPrototype: object;
  asyncGeneratorPrototype: object;
} {
  const syncGeneratorResult = sampleSyncGenerator();
  syncGeneratorResult.next();

  const asyncGeneratorResult = sampleAsyncGenerator();
  void asyncGeneratorResult.next();

  return {
    syncGeneratorFunctionPrototype: Object.getPrototypeOf(sampleSyncGenerator),
    asyncGeneratorFunctionPrototype: Object.getPrototypeOf(sampleAsyncGenerator),
    syncGeneratorPrototype: Object.getPrototypeOf(sampleSyncGenerator.prototype),
    asyncGeneratorPrototype: Object.getPrototypeOf(sampleAsyncGenerator.prototype),
  };
}

const {
  syncGeneratorFunctionPrototype: SYNC_GENERATOR_FUNCTION_PROTOTYPE,
  asyncGeneratorFunctionPrototype: ASYNC_GENERATOR_FUNCTION_PROTOTYPE,
  syncGeneratorPrototype: SYNC_GENERATOR_PROTOTYPE,
  asyncGeneratorPrototype: ASYNC_GENERATOR_PROTOTYPE,
} = getGeneratorDetectionPrototypes();

/** Returns `true` if `fn` is a sync generator function (`function*`). */
export function isGeneratorFunction(fn: Function): boolean {
  return Object.getPrototypeOf(fn) === SYNC_GENERATOR_FUNCTION_PROTOTYPE;
}

/**
 * Returns `true` if `fn` is an async generator function (`async function*`).
 *
 * @example
 * ```ts
 * import { isAsyncGeneratorFunction } from '@lostgradient/weft';
 *
 * async function* myWorkflow() { yield 1; }
 * function* syncGen() { yield 1; }
 * async function asyncFn() { return 1; }
 *
 * console.log(isAsyncGeneratorFunction(myWorkflow)); // true
 * console.log(isAsyncGeneratorFunction(syncGen));    // false
 * console.log(isAsyncGeneratorFunction(asyncFn));    // false
 * ```
 */
export function isAsyncGeneratorFunction(fn: Function): boolean {
  return Object.getPrototypeOf(fn) === ASYNC_GENERATOR_FUNCTION_PROTOTYPE;
}

/**
 * Check if a value is a Generator or AsyncGenerator object (not just any iterable).
 * Arrays, Maps, Sets, etc. are NOT matched — only actual generator instances.
 *
 * The prototype chain for a generator instance is:
 *   gen -> genFn.prototype -> Generator.prototype
 * We compare the shared parent prototype so lookalike iterators do not match.
 */
export function isGeneratorResult(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const directPrototype = Object.getPrototypeOf(value);
  if (directPrototype === null) return false;

  const sharedPrototype = Object.getPrototypeOf(directPrototype);
  return (
    sharedPrototype === SYNC_GENERATOR_PROTOTYPE || sharedPrototype === ASYNC_GENERATOR_PROTOTYPE
  );
}
