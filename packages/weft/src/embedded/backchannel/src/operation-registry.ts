import type { z } from 'zod';

import { dispatchOperation } from './operation-catalog/operation-dispatch.ts';
import { snapshotOperationMetadata } from './operation-catalog/operation-metadata.ts';
import {
  validateOperationName,
  type AuthorizationDecision,
  type DispatchContext,
  type DispatchResult,
  type OperationContext,
  type OperationDefinitionBase,
  type StreamOperationInvocation,
  type SubscriptionOperationInvocation,
} from './operation-catalog/types.ts';

export { isValidOperationName, validateOperationName } from './operation-catalog/types.ts';

type SchemaOperationInputBase<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
  Host,
> = Omit<
  OperationDefinitionBase<
    z.output<InputSchema>,
    z.input<OutputSchema>,
    z.output<OutputSchema>,
    Host
  >,
  'tags' | 'inputSchema' | 'outputSchema' | 'authorize'
> & {
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
  readonly tags?: ReadonlyArray<string>;
  readonly authorize?: (
    context: OperationContext<NoInfer<z.output<InputSchema>>, Host>,
  ) => Promise<AuthorizationDecision>;
};

type UnaryOperationInput<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
  Host = unknown,
> = SchemaOperationInputBase<InputSchema, OutputSchema, Host> & {
  readonly kind?: 'unary';
  readonly eventSchema?: never;
  readonly invoke: (
    context: OperationContext<NoInfer<z.output<InputSchema>>, Host>,
  ) => Promise<NoInfer<z.input<OutputSchema>>>;
};

type StreamOperationInput<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
  EventSchema extends z.ZodType,
  Host = unknown,
> = SchemaOperationInputBase<InputSchema, OutputSchema, Host> & {
  readonly kind: 'stream';
  readonly eventSchema: EventSchema;
  readonly invoke: (
    context: OperationContext<NoInfer<z.output<InputSchema>>, Host>,
  ) => Promise<
    NoInfer<z.input<OutputSchema>> | StreamOperationInvocation<NoInfer<z.input<EventSchema>>>
  >;
};

type SubscriptionOperationInput<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
  EventSchema extends z.ZodType,
  Host = unknown,
> = SchemaOperationInputBase<InputSchema, OutputSchema, Host> & {
  readonly kind: 'subscription';
  readonly eventSchema: EventSchema;
  readonly invoke: (
    context: OperationContext<NoInfer<z.output<InputSchema>>, Host>,
  ) => Promise<
    SubscriptionOperationInvocation<NoInfer<z.input<EventSchema>>, NoInfer<z.input<OutputSchema>>>
  >;
};

/** What {@link defineOperation} accepts: the unary, stream or subscription authoring shape, selected by `kind`. */
export type OperationDefinitionInput<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
  EventSchema extends z.ZodType = never,
  Host = unknown,
> =
  | UnaryOperationInput<InputSchema, OutputSchema, Host>
  | StreamOperationInput<InputSchema, OutputSchema, EventSchema, Host>
  | SubscriptionOperationInput<InputSchema, OutputSchema, EventSchema, Host>;

type DispatchEntry<Host> = {
  readonly tags: ReadonlyArray<string>;
  readonly dispatch: (
    rawInput: unknown,
    context: DispatchContext<Host>,
  ) => Promise<DispatchResult<unknown>>;
};

/** The result of {@link defineOperation} for a `kind: 'unary'` operation. */
export type UnarySchemaOperationDefinition<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
  Host = unknown,
> = UnaryOperationInput<InputSchema, OutputSchema, Host> & DispatchEntry<Host>;

/** The result of {@link defineOperation} for a `kind: 'stream'` operation. */
export type StreamSchemaOperationDefinition<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
  EventSchema extends z.ZodType,
  Host = unknown,
> = StreamOperationInput<InputSchema, OutputSchema, EventSchema, Host> & DispatchEntry<Host>;

/** The result of {@link defineOperation} for a `kind: 'subscription'` operation. */
export type SubscriptionSchemaOperationDefinition<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
  EventSchema extends z.ZodType,
  Host = unknown,
> = SubscriptionOperationInput<InputSchema, OutputSchema, EventSchema, Host> & DispatchEntry<Host>;

/** The result of {@link defineOperation}: an operation of any kind, carrying its frozen metadata and its dispatch entry. */
export type SchemaOperationDefinition<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
  EventSchema extends z.ZodType = never,
  Host = unknown,
> =
  | UnarySchemaOperationDefinition<InputSchema, OutputSchema, Host>
  | StreamSchemaOperationDefinition<InputSchema, OutputSchema, EventSchema, Host>
  | SubscriptionSchemaOperationDefinition<InputSchema, OutputSchema, EventSchema, Host>;

/** Derive authoring contracts from schemas and capture one immutable dispatch policy. */
export function defineOperation<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
  Host = unknown,
>(
  input: UnaryOperationInput<InputSchema, OutputSchema, Host>,
): UnarySchemaOperationDefinition<InputSchema, OutputSchema, Host>;
/** Defines a stream operation. */
export function defineOperation<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
  EventSchema extends z.ZodType,
  Host = unknown,
>(
  input: StreamOperationInput<InputSchema, OutputSchema, EventSchema, Host>,
): StreamSchemaOperationDefinition<InputSchema, OutputSchema, EventSchema, Host>;
/** Defines a subscription operation. */
export function defineOperation<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
  EventSchema extends z.ZodType,
  Host = unknown,
>(
  input: SubscriptionOperationInput<InputSchema, OutputSchema, EventSchema, Host>,
): SubscriptionSchemaOperationDefinition<InputSchema, OutputSchema, EventSchema, Host>;
export function defineOperation(
  input: OperationDefinitionInput<z.ZodObject, z.ZodType, z.ZodType>,
): SchemaOperationDefinition<z.ZodObject, z.ZodType, z.ZodType> {
  validateOperationName(input.name);
  const metadata = snapshotOperationMetadata({ ...input, tags: input.tags ?? [] });
  const fields = {
    ...metadata,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    ...(input.authorize === undefined ? {} : { authorize: input.authorize }),
  };
  if (input.kind === 'stream') {
    const operation = Object.freeze({
      ...fields,
      kind: input.kind,
      eventSchema: input.eventSchema,
      invoke: input.invoke,
    });
    return Object.freeze({
      ...operation,
      dispatch: (rawInput: unknown, context: DispatchContext) =>
        dispatchOperation(operation, { rawInput, context }),
    });
  }
  if (input.kind === 'subscription') {
    const operation = Object.freeze({
      ...fields,
      kind: input.kind,
      eventSchema: input.eventSchema,
      invoke: input.invoke,
    });
    return Object.freeze({
      ...operation,
      dispatch: (rawInput: unknown, context: DispatchContext) =>
        dispatchOperation(operation, { rawInput, context }),
    });
  }
  const operation = Object.freeze({ ...fields, kind: 'unary' as const, invoke: input.invoke });
  return Object.freeze({
    ...operation,
    dispatch: (rawInput: unknown, context: DispatchContext) =>
      dispatchOperation(operation, { rawInput, context }),
  });
}
