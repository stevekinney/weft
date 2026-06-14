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
}
