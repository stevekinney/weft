/**
 * The `WorkflowDefinition` type — the runtime shape produced by
 * `workflow({ name }).execute(fn)`. Carries the workflow name, the generator
 * handler, and the colocated metadata the engine reads at registration time
 * (version, schemas, retention, search attributes, domain constraints, tags,
 * description).
 */

import type { ConstraintDefinition } from '../constraint.ts';
import type { DefinitionSchema } from './definition-schema.ts';
import type { RetentionPolicy } from './retry-retention.ts';
import type { SearchAttributeSchema } from './search-attributes.ts';
import type { WorkflowConcurrencyOptions } from './workflow-concurrency.ts';
import type { WorkflowFunction } from './workflow-function.ts';
import type { AnyActivityDefinition } from './workflow-registries.ts';

/**
 * Named workflow definition returned by {@link workflow}. The runtime object
 * carries the workflow name, the generator handler, and optional metadata
 * (version, schemas, retention policy, workflow concurrency, search-attribute
 * schema, and domain constraints) that the engine reads at registration time.
 *
 * @example
 * ```ts
 * import { workflow, type WorkflowDefinition, type WorkflowContext } from '@lostgradient/weft';
 *
 * const greet: WorkflowDefinition<string, string> = workflow({ name: 'greet' })
 *   .execute(async function* (_ctx: WorkflowContext, input: string) {
 *     return `hello ${input}`;
 *   });
 * ```
 */
export interface WorkflowDefinition<
  TInput = unknown,
  TOutput = unknown,
  TName extends string = string,
  TServices = unknown,
> {
  /** Wire-safe workflow name; the registry key. */
  name: TName;
  /** Workflow generator function executed by the engine. */
  handler: WorkflowFunction<TInput, TOutput, TServices>;
  /** Version recorded with workflow state and checked during recovery. */
  version?: string;
  /** User-facing description for catalog, code generation, and tool surfaces. */
  description?: string;
  /** User-facing grouping tags for catalog and documentation surfaces. */
  tags?: ReadonlyArray<string>;
  /** Optional input schema metadata for introspection; registration validates metadata shape only. */
  inputSchema?: DefinitionSchema<unknown, TInput>;
  /** Optional output schema metadata for introspection; registration validates metadata shape only. */
  outputSchema?: DefinitionSchema<unknown, TOutput>;
  /** Search-attribute schema used to validate indexed workflow metadata. */
  searchAttributes?: SearchAttributeSchema;
  /** Retention policy for terminal workflow records. */
  retention?: RetentionPolicy;
  /** Start admission policy for this workflow type. */
  concurrency?: WorkflowConcurrencyOptions<TInput>;
  /**
   * Domain constraints evaluated at every checkpoint commit. When a constraint's
   * `check` returns false, the engine dispatches a `ConstraintViolatedEvent`
   * and reacts per `onViolation` ('fail' | 'compensate' | 'warn').
   *
   * **Note**: Constraints are only evaluated when using the default inline
   * execution strategy. Workflows running in a Web Worker
   * (`workerExecution` option) will silently skip constraint evaluation.
   */
  constraints?: ConstraintDefinition[];
  /**
   * Declares a definition-level teardown activity for durable, replay-safe
   * cancellation cleanup (issue #446) — for example destroying a paid sandbox
   * when a workflow is cancelled or times out.
   *
   * After a `cancelled` or `timed-out` terminal, the engine drives this finalizer
   * to durable completion, passing the value recorded by
   * {@link WorkflowContext.setFinalizerState} as its input. That teardown survives
   * a hard cancel and an engine crash: the engine schedules it durably, claims it
   * before running, retries failures with backoff, re-drives a stale claim after
   * recovery, and records a durable dead-letter once the attempt budget is
   * exhausted. The engine skips the finalizer entirely when the workflow never
   * recorded any finalizer state, and `completed`/`failed` workflows never run it
   * (only `cancelled`/`timed-out`).
   *
   * **The finalizer runs at least once and must be idempotent.** Bounded retries
   * and crash-recovery re-drive mean the same payload can reach it more than once,
   * so destroying an already-destroyed resource must succeed (or no-op) rather
   * than throw — the same contract as keying a destroy by `sandboxId`.
   *
   * A `finalizer` is trusted host code. **Registration** works in both inline and
   * worker execution modes, and the teardown **runs on the engine host** regardless
   * of execution mode (and regardless of whether `activityExecution` is configured):
   * worker execution mode isolates only the workflow generator in a Web Worker.
   *
   * Durable teardown, however, only fires when the workflow staged finalizer state
   * via {@link WorkflowContext.setFinalizerState} before terminating — and that
   * method is part of the inline workflow context, unavailable in a worker generator
   * (there is no host-side API to stage it on the workflow's behalf). So a worker-mode
   * workflow that needs durable finalizer teardown must run **inline** to record its
   * state; registering a `finalizer` on a worker-mode engine no longer throws, but a
   * worker generator cannot drive it. The inline-only alternatives are `ctx.onCancel`
   * (in-process, best-effort cleanup that need not survive a crash) and `ctx.saga`
   * (multi-step ordered rollback) — both are unavailable in worker mode, where
   * teardown must happen in the workflow body (a `ctx.run` destroy step in a
   * `try/finally`).
   */
  finalizer?: AnyActivityDefinition;
}
