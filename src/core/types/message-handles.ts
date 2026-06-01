import {
  validateDefinitionSchemaMetadata,
  type DefinitionSchema,
  type InferSchemaOutput,
} from './definition-schema.ts';

// ---------------------------------------------------------------------------
// Message-shaped workflow handles
// ---------------------------------------------------------------------------

/**
 * Typed handle for a workflow signal. The runtime value is `{ name }` plus an
 * optional `inputSchema` carried for introspection and boundary validation;
 * the generic parameter exists to carry the payload type through call sites.
 *
 * @example
 * ```ts
 * import { signal, type SignalDefinition } from '@lostgradient/weft';
 *
 * declare const handle: {
 *   signal(definition: SignalDefinition<{ approved: boolean }>, input: { approved: boolean }): Promise<void>;
 * };
 * const approval: SignalDefinition<{ approved: boolean }> = signal('approval');
 * await handle.signal(approval, { approved: true });
 * ```
 */
export interface SignalDefinition<TInput = void> {
  readonly name: string;
  readonly inputSchema?: DefinitionSchema<unknown, TInput>;
  readonly _input?: (input: TInput) => void;
}

/**
 * Typed handle for a workflow update. Updates accept an input payload and
 * return a response to the caller. Optional `inputSchema` and `outputSchema`
 * carry validation metadata to the boundary.
 *
 * @example
 * ```ts
 * import { update, type UpdateDefinition } from '@lostgradient/weft';
 *
 * declare const handle: {
 *   update(
 *     definition: UpdateDefinition<{ orderId: string }, { status: string }>,
 *     input: { orderId: string },
 *   ): Promise<{ status: string }>;
 * };
 * const approveOrder: UpdateDefinition<{ orderId: string }, { status: string }> =
 *   update('approveOrder');
 * const result = await handle.update(approveOrder, { orderId: 'ord_123' });
 * void result.status;
 * ```
 */
export interface UpdateDefinition<TInput = void, TOutput = unknown> {
  readonly name: string;
  readonly inputSchema?: DefinitionSchema<unknown, TInput>;
  readonly outputSchema?: DefinitionSchema<unknown, TOutput>;
  readonly _input?: (input: TInput) => void;
  readonly _output?: () => TOutput;
}

/**
 * Typed handle for a workflow query. Queries are read-only accessors and may
 * optionally accept an input payload. Optional `inputSchema` and
 * `outputSchema` carry validation metadata to the boundary.
 *
 * @example
 * ```ts
 * import { query, type QueryDefinition } from '@lostgradient/weft';
 *
 * declare const handle: {
 *   query(
 *     definition: QueryDefinition<{ orderId: string }, { state: string }>,
 *     input: { orderId: string },
 *   ): Promise<{ state: string }>;
 * };
 * const orderStatus: QueryDefinition<{ orderId: string }, { state: string }> =
 *   query('orderStatus');
 * const status = await handle.query(orderStatus, { orderId: 'ord_123' });
 * void status.state;
 * ```
 */
export interface QueryDefinition<TInput = void, TOutput = unknown> {
  readonly name: string;
  readonly inputSchema?: DefinitionSchema<unknown, TInput>;
  readonly outputSchema?: DefinitionSchema<unknown, TOutput>;
  readonly _input?: (input: TInput) => void;
  readonly _output?: () => TOutput;
}

export type MessageDefinition =
  | QueryDefinition<unknown>
  | SignalDefinition<unknown>
  | UpdateDefinition<unknown>;

export type MessageName = string | { readonly name: string };

// ---------------------------------------------------------------------------
// signal()
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link signal} when declaring schema metadata.
 *
 * @example
 * ```ts
 * import type { SignalOptions } from '@lostgradient/weft';
 * import { z } from 'zod';
 *
 * const options: SignalOptions<{ approved: boolean }> = {
 *   inputSchema: z.object({ approved: z.boolean() }),
 * };
 * void options;
 * ```
 */
export interface SignalOptions<TInput = void> {
  readonly inputSchema?: DefinitionSchema<unknown, TInput>;
}

/**
 * Options accepted when sending a signal to a workflow.
 *
 * @example
 * ```ts
 * import type { SignalDeliveryOptions } from '@lostgradient/weft';
 *
 * const options: SignalDeliveryOptions = { signalId: 'approval-123' };
 * void options;
 * ```
 */
export interface SignalDeliveryOptions {
  readonly signalId?: string;
}

/**
 * Create a typed workflow signal handle. When an `inputSchema` is supplied
 * via options, the payload type is inferred from the schema's
 * `~standard.types.output` marker — no explicit generic required, and
 * transform schemas surface their parsed payload type.
 *
 * @example
 * ```ts
 * import { signal } from '@lostgradient/weft';
 * import { z } from 'zod';
 *
 * const approval = signal<{ approved: boolean }>('approval');
 *
 * const approval2 = signal('approval', { inputSchema: z.object({ approved: z.boolean() }) });
 * void approval2;
 * ```
 */
export function signal<TSchema extends DefinitionSchema<unknown, unknown>>(
  name: string,
  options: { inputSchema: TSchema },
): SignalDefinition<InferSchemaOutput<TSchema>>;
export function signal<TInput = void>(
  name: string,
  options?: SignalOptions<TInput>,
): SignalDefinition<TInput>;
export function signal(name: string, options?: SignalOptions<unknown>): SignalDefinition<unknown> {
  if (options?.inputSchema !== undefined) {
    validateDefinitionSchemaMetadata(options.inputSchema, `signal("${name}").inputSchema`);
  }
  // Phantom `_input` only exists in type space (it's a `_input?:` field that
  // is never written), so casting from the structural literal to
  // `SignalDefinition<unknown>` is the correct narrowing here.
  return {
    name,
    ...(options?.inputSchema !== undefined ? { inputSchema: options.inputSchema } : {}),
  } as SignalDefinition<unknown>;
}

// ---------------------------------------------------------------------------
// update()
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link update} when declaring schema metadata.
 *
 * @example
 * ```ts
 * import type { UpdateOptions } from '@lostgradient/weft';
 * import { z } from 'zod';
 *
 * const options: UpdateOptions<{ id: string }, { ok: true }> = {
 *   inputSchema: z.object({ id: z.string() }),
 *   outputSchema: z.object({ ok: z.literal(true) }),
 * };
 * void options;
 * ```
 */
export interface UpdateOptions<TInput = void, TOutput = unknown> {
  readonly inputSchema?: DefinitionSchema<unknown, TInput>;
  readonly outputSchema?: DefinitionSchema<unknown, TOutput>;
}

/**
 * Create a typed workflow update handle. When `inputSchema` and/or
 * `outputSchema` are supplied via options, payload types are inferred from
 * the schemas — no explicit generic required.
 *
 * @example
 * ```ts
 * import { update } from '@lostgradient/weft';
 * import { z } from 'zod';
 *
 * const approve = update<{ id: string }, { accepted: boolean }>('approve');
 *
 * const approve2 = update('approve', {
 *   inputSchema: z.object({ id: z.string() }),
 *   outputSchema: z.object({ accepted: z.boolean() }),
 * });
 * void approve2;
 * ```
 */
export function update<
  TInputSchema extends DefinitionSchema<unknown, unknown>,
  TOutputSchema extends DefinitionSchema<unknown, unknown>,
>(
  name: string,
  options: { inputSchema: TInputSchema; outputSchema: TOutputSchema },
): UpdateDefinition<InferSchemaOutput<TInputSchema>, InferSchemaOutput<TOutputSchema>>;
export function update<TInputSchema extends DefinitionSchema<unknown, unknown>>(
  name: string,
  options: { inputSchema: TInputSchema },
): UpdateDefinition<InferSchemaOutput<TInputSchema>>;
export function update<TInput = void, TOutput = unknown>(
  name: string,
  options?: UpdateOptions<TInput, TOutput>,
): UpdateDefinition<TInput, TOutput>;
export function update(name: string, options?: UpdateOptions<unknown>): UpdateDefinition<unknown> {
  if (options?.inputSchema !== undefined) {
    validateDefinitionSchemaMetadata(options.inputSchema, `update("${name}").inputSchema`);
  }
  if (options?.outputSchema !== undefined) {
    validateDefinitionSchemaMetadata(options.outputSchema, `update("${name}").outputSchema`);
  }
  // Phantom `_input` / `_output` only exist in type space; the structural
  // literal satisfies every overload's return shape, so narrowing via `as`
  // is the correct escape hatch.
  return {
    name,
    ...(options?.inputSchema !== undefined ? { inputSchema: options.inputSchema } : {}),
    ...(options?.outputSchema !== undefined ? { outputSchema: options.outputSchema } : {}),
  } as UpdateDefinition<unknown>;
}

// ---------------------------------------------------------------------------
// query()
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link query} when declaring schema metadata.
 *
 * @example
 * ```ts
 * import type { QueryOptions } from '@lostgradient/weft';
 * import { z } from 'zod';
 *
 * const options: QueryOptions<{ id: string }, { state: string }> = {
 *   inputSchema: z.object({ id: z.string() }),
 *   outputSchema: z.object({ state: z.string() }),
 * };
 * void options;
 * ```
 */
export interface QueryOptions<TInput = void, TOutput = unknown> {
  readonly inputSchema?: DefinitionSchema<unknown, TInput>;
  readonly outputSchema?: DefinitionSchema<unknown, TOutput>;
}

/**
 * Create a typed workflow query handle. When `inputSchema` and/or
 * `outputSchema` are supplied via options, payload types are inferred from
 * the schemas — no explicit generic required.
 *
 * @example
 * ```ts
 * import { query } from '@lostgradient/weft';
 * import { z } from 'zod';
 *
 * const status = query<void, { state: string }>('status');
 *
 * const status2 = query('status', {
 *   outputSchema: z.object({ state: z.string() }),
 * });
 * void status2;
 * ```
 */
export function query<
  TInputSchema extends DefinitionSchema<unknown, unknown>,
  TOutputSchema extends DefinitionSchema<unknown, unknown>,
>(
  name: string,
  options: { readonly inputSchema: TInputSchema; readonly outputSchema: TOutputSchema },
): QueryDefinition<InferSchemaOutput<TInputSchema>, InferSchemaOutput<TOutputSchema>>;
export function query<TOutputSchema extends DefinitionSchema<unknown, unknown>>(
  name: string,
  options: { readonly outputSchema: TOutputSchema },
): QueryDefinition<void, InferSchemaOutput<TOutputSchema>>;
export function query<TInputSchema extends DefinitionSchema<unknown, unknown>>(
  name: string,
  options: { readonly inputSchema: TInputSchema },
): QueryDefinition<InferSchemaOutput<TInputSchema>>;
export function query<TInput = void, TOutput = unknown>(
  name: string,
  options?: QueryOptions<TInput, TOutput>,
): QueryDefinition<TInput, TOutput>;
export function query(
  name: string,
  options?: QueryOptions<unknown>,
): QueryDefinition<unknown> | QueryDefinition {
  if (options?.inputSchema !== undefined) {
    validateDefinitionSchemaMetadata(options.inputSchema, `query("${name}").inputSchema`);
  }
  if (options?.outputSchema !== undefined) {
    validateDefinitionSchemaMetadata(options.outputSchema, `query("${name}").outputSchema`);
  }
  // The implementation return is a structural object satisfying every overload
  // shape; the union signals to the typechecker that overload 2's
  // `QueryDefinition<void, ...>` is also a valid return.
  return {
    name,
    ...(options?.inputSchema !== undefined ? { inputSchema: options.inputSchema } : {}),
    ...(options?.outputSchema !== undefined ? { outputSchema: options.outputSchema } : {}),
  } as QueryDefinition<unknown>;
}

// ---------------------------------------------------------------------------
// utilities
// ---------------------------------------------------------------------------

export function messageName(definition: MessageName): string {
  return typeof definition === 'string' ? definition : definition.name;
}
