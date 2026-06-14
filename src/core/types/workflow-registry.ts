import type { DefinitionSchema } from './definition-schema.ts';
import type { SearchAttributeSchema } from './search-attributes.ts';
import type { WorkflowConcurrencyOptions } from './workflow-concurrency.ts';

/**
 * Read-only metadata exposed by the engine for a registered workflow type.
 *
 * @example
 * ```ts
 * import { Engine, type RegisteredWorkflowDefinition } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * const definition: RegisteredWorkflowDefinition | undefined = engine.getWorkflowDefinition('greet');
 *
 * void definition;
 * ```
 */
export interface RegisteredWorkflowDefinition<TInput = unknown, TOutput = unknown> {
  /** Registered workflow type name. */
  type: string;
  /** Current registration version. */
  version: string;
  /** User-facing grouping tags for catalog and documentation surfaces. */
  tags: ReadonlyArray<string>;
  /** User-facing description for catalog, code generation, and tool surfaces. */
  description?: string;
  /** Optional input schema metadata for introspection; core execution does not validate input against it. */
  inputSchema?: DefinitionSchema<unknown, TInput>;
  /** Optional output schema metadata for introspection; core execution does not validate output against it. */
  outputSchema?: DefinitionSchema<unknown, TOutput>;
  /** Optional search attribute schema used for indexing and runtime validation. */
  searchAttributes?: SearchAttributeSchema;
  /** Optional start admission policy for this workflow type. */
  concurrency?: WorkflowConcurrencyOptions<TInput>;
}
