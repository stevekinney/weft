import type { DefinitionSchema } from './definition-schema.ts';
import type { QueryDefinition, SignalDefinition, UpdateDefinition } from './message-handles.ts';
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
  /** Statically registered signal definitions keyed by their public names. */
  signals?: Readonly<Record<string, Readonly<SignalDefinition<unknown>>>>;
  /** Statically registered update definitions keyed by their public names. */
  updates?: Readonly<Record<string, Readonly<UpdateDefinition<unknown>>>>;
  /** Statically registered query definitions keyed by their public names. */
  queries?: Readonly<Record<string, Readonly<QueryDefinition<unknown>>>>;
  /** Optional search attribute schema used for indexing and runtime validation. */
  searchAttributes?: SearchAttributeSchema;
  /** Optional start admission policy for this workflow type. */
  concurrency?: WorkflowConcurrencyOptions<TInput>;
  /**
   * Schema-only metadata for the workflow's definition-level finalizer
   * activity ({@link WorkflowDefinition.finalizer}), when registered. Carries
   * only `name`/`inputSchema`/`outputSchema` — never the finalizer's
   * `execute` handler — matching this interface's read-only introspection
   * contract (the workflow's own handler is likewise never exposed here).
   */
  finalizer?: Readonly<{
    name: string;
    inputSchema?: DefinitionSchema;
    outputSchema?: DefinitionSchema;
  }>;
}
