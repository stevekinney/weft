import type { ActivityDefinition, SearchAttributeSchema, SearchAttributeValue } from '../types.ts';
import type { WorkflowLogRecord } from '../types/workflow-log.ts';

/**
 * A single step in a saga: an activity definition and the input to pass to it.
 *
 * `TInput` and `TOutput` are inferred from the definition so that `compensate`
 * receives correctly-typed arguments at the definition site. At the array
 * boundary inside `ctx.saga`, types are erased to `unknown` — the
 * implementation guarantees that the input passed to `execute` and `compensate`
 * always matches what was supplied in the original step object.
 *
 * @example
 * ```ts
 * import { activity, type SagaStep, type WorkflowContext } from '@lostgradient/weft';
 *
 * const chargeCard = activity({
 *   name: 'chargeCard',
 *   execute: async (input: unknown) => ({ chargeId: 'ch-123' }),
 *   compensate: async (_input, _output) => { return; },
 * });
 *
 * const step: SagaStep<unknown, { chargeId: string }> = {
 *   definition: chargeCard,
 *   input: { amount: 99 },
 * };
 * void step;
 * ```
 */
export interface SagaStep<TInput = unknown, TOutput = unknown> {
  definition: ActivityDefinition<TInput, TOutput>;
  input: TInput;
}

// Method-syntax declarations use bivariant parameter checking under
// strictFunctionTypes, which lets ActivityDefinition<string, string>.execute
// be assigned to this erased interface.
export interface ErasedActivityDefinition {
  name: string;
  execute(input: unknown, context?: unknown): unknown;
  compensate?(input: unknown, output?: unknown): unknown;
}

export interface ErasedSagaStep {
  definition: ErasedActivityDefinition;
  input: unknown;
}

/**
 * Reference returned by `ctx.offload(key, fn)`. Store this in a local
 * variable or pass it downstream — the engine keeps the heavy payload in
 * storage and only checkpoints the lightweight reference. Retrieve the
 * original value with `ctx.load(reference)`. Offload references are plain
 * JSON-shaped objects, so they survive structured cloning, MessagePack
 * encoding, and worker postMessage transfers — return them as workflow
 * results or store them in attributes.
 *
 * @example
 * ```ts
 * import { workflow, activity, Engine, type OffloadReference, type WorkflowContext } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(
 *   workflow({ name: 'heavy' }).execute(async function* (ctx: WorkflowContext, input: unknown) {
 *     const ref: OffloadReference = yield* ctx.offload(
 *       'large-payload',
 *       async () => ({ data: 'x'.repeat(100_000) }),
 *     );
 *     console.log(ref.sizeBytes);
 *     const payload = yield* ctx.load(ref);
 *     return payload;
 *   }),
 * );
 * void engine;
 * ```
 */
export interface OffloadReference {
  key: string;
  workflowId: string;
  sizeBytes: number;
}

/**
 * Reference to a multi-chunk stream stored via `ctx.stream(key, fn)`. Contains
 * the storage key, workflow ID, chunk count, and total byte size.
 *
 * @example
 * ```ts
 * import { workflow, Engine, type StreamReference, type WorkflowContext } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(
 *   workflow({ name: 'streamer' }).execute(async function* (ctx: WorkflowContext) {
 *     const ref: StreamReference = yield* ctx.stream('tokens', async function* () {
 *       yield 'hello';
 *     });
 *     return ref.chunkCount;
 *   }),
 * );
 * ```
 */
export interface StreamReference {
  key: string;
  workflowId: string;
  chunkCount: number;
  totalSizeBytes: number;
}

/**
 * A single chunk persisted by `ctx.stream`. The `sequence` field is the
 * zero-based chunk index used to reassemble the stream in order on replay.
 */
export interface StoredStreamChunk<T = unknown> {
  sequence: number;
  value: T;
}

/**
 * Callback object passed to the async generator function inside `ctx.stream`.
 * Call `sink.heartbeat()` periodically to extend the stream's visibility
 * timeout and prevent the engine from marking it as stalled.
 *
 * @example
 * ```ts
 * import { workflow, Engine, type StreamSink, type WorkflowContext } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(
 *   workflow({ name: 'streamer' }).execute(async function* (ctx: WorkflowContext) {
 *     yield* ctx.stream('tokens', async function* (sink: StreamSink) {
 *       sink.heartbeat({ chunk: 0 });
 *       yield 'hello';
 *     });
 *   }),
 * );
 * ```
 */
export interface StreamSink {
  heartbeat(details?: unknown): void;
}

/**
 * Construction options for the {@link Context} class. Populated by the engine
 * before invoking a workflow generator; advanced consumers may construct
 * `Context` directly with these options.
 *
 * @example
 * ```ts
 * import { Context, type ContextOptions } from '@lostgradient/weft';
 *
 * const controller = new AbortController();
 * const options: ContextOptions = {
 *   workflowId: 'wf-demo',
 *   workflowType: 'demo',
 *   startedAt: Date.now(),
 *   abortController: controller,
 * };
 * const ctx = new Context(options);
 * void ctx;
 * ```
 */
export interface ContextOptions {
  workflowId: string;
  workflowExecutionToken?: string;
  workflowType: string;
  startedAt: number;
  abortController: AbortController;
  deadline?: number;
  initialStep?: number;
  accumulatedResults?: Map<number, unknown>;
  locals?: Record<string, unknown>;
  searchAttributes?: Record<string, SearchAttributeValue>;
  searchAttributeSchema?: SearchAttributeSchema;
  getNow?: () => number;
  nestingDepth?: number;
  /**
   * Owner identifier for `ctx.state.execution()`. Defaults to the workflow id.
   * Child workflows inherit the parent's owner so execution-scoped state is
   * shared across a durable execution tree.
   */
  executionStateOwnerId?: string;
  /**
   * Reference timestamp used to compute `scheduledFireAt` for sleep operations.
   * When resuming from a checkpoint, this should be the checkpoint's `createdAt`.
   */
  sleepReferenceTime?: number;
  resolveWorkflowType?: (target: string | Function) => string;
  /**
   * Called by `ctx.onCancel()` to keep the handler in engine memory outside
   * the transient context instance. The handler survives inline parking, but
   * it is not persisted or restored after engine restart.
   */
  registerCancelHandler?: (handler: () => Promise<void> | void) => () => void;
  /**
   * Host-supplied, per-run capabilities exposed as `ctx.services`. Never
   * checkpointed; held only for this run and re-provided on recovery via the
   * engine's `resolveWorkflowServices` resolver.
   */
  services?: unknown;
  /**
   * Host sink for `ctx.log` records (`EngineOptions.onLog`). When set, non-replayed
   * records route here instead of the console; when absent, the default console
   * behavior is preserved. Never checkpointed.
   */
  logSink?: (record: WorkflowLogRecord) => void;
  /**
   * Called by `ctx.setFinalizerState(value)` (#446) to durably record the payload
   * the engine passes to the workflow's `finalizer` activity on cancel/timeout
   * teardown. The engine stages it as a pending atomic side-effect so it commits
   * with the next checkpoint or the terminal batch. Absent for worker-mode and
   * speculative contexts, where `ctx.setFinalizerState` is unsupported.
   */
  recordFinalizerState?: (value: unknown) => void;
}
