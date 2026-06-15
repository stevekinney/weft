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
   * Definition-level teardown activity, driven by the engine to durable
   * completion after this workflow reaches a `cancelled` or `timed-out` terminal
   * state (issue #446). Unlike `ctx.onCancel` and saga compensation — which run
   * in memory and are lost on a hard cancel or crash — the finalizer is backed by
   * the full retry machinery and re-driven on recovery, so it guarantees
   * resource cleanup (e.g. destroying a paid sandbox) survives cancellation and
   * process death.
   *
   * The engine passes the value recorded by `ctx.setFinalizerState(value)` as the
   * finalizer's input. The finalizer is skipped entirely when no finalizer state
   * was recorded. Completed and failed workflows do not run the finalizer — place
   * those teardown steps as a normal `ctx.run` after the `try/finally`.
   *
   * **Idempotency is required.** Across a lease handoff or crash the finalizer may
   * run more than once; make it idempotent — destroying an already-destroyed
   * resource must succeed. Derive its `idempotencyKey` from the resource id.
   *
   * **Note**: Not supported in worker execution mode (`workerExecution`) until a
   * later release; registering a finalizer on a worker-mode engine throws.
   *
   * **Status**: the engine-driven teardown that runs this finalizer lands in a
   * follow-up release. Declaring it and recording state with
   * {@link WorkflowContext.setFinalizerState} are inert until that drive ships.
   */
  finalizer?: AnyActivityDefinition;
}
