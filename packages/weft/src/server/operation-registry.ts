import type { z } from 'zod';

import {
  dispatchStream,
  dispatchSubscription,
  dispatchUnary,
} from './operation-catalog/operation-dispatch.ts';
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
> = Omit<
  OperationDefinitionBase<z.output<InputSchema>, z.input<OutputSchema>, z.output<OutputSchema>>,
  'tags' | 'inputSchema' | 'outputSchema' | 'authorize'
> & {
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
  readonly tags?: ReadonlyArray<string>;
  readonly authorize?: (
    context: OperationContext<NoInfer<z.output<InputSchema>>>,
  ) => Promise<AuthorizationDecision>;
};

type UnaryOperationInput<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
> = SchemaOperationInputBase<InputSchema, OutputSchema> & {
  readonly kind?: 'unary';
  readonly eventSchema?: never;
  readonly invoke: (
    context: OperationContext<NoInfer<z.output<InputSchema>>>,
  ) => Promise<NoInfer<z.input<OutputSchema>>>;
};

type StreamOperationInput<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
  EventSchema extends z.ZodType,
> = SchemaOperationInputBase<InputSchema, OutputSchema> & {
  readonly kind: 'stream';
  readonly eventSchema: EventSchema;
  readonly invoke: (
    context: OperationContext<NoInfer<z.output<InputSchema>>>,
  ) => Promise<
    NoInfer<z.input<OutputSchema>> | StreamOperationInvocation<NoInfer<z.input<EventSchema>>>
  >;
};

type SubscriptionOperationInput<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
  EventSchema extends z.ZodType,
> = SchemaOperationInputBase<InputSchema, OutputSchema> & {
  readonly kind: 'subscription';
  readonly eventSchema: EventSchema;
  readonly invoke: (
    context: OperationContext<NoInfer<z.output<InputSchema>>>,
  ) => Promise<
    SubscriptionOperationInvocation<NoInfer<z.input<EventSchema>>, NoInfer<z.input<OutputSchema>>>
  >;
};

export type OperationDefinitionInput<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
  EventSchema extends z.ZodType = never,
> =
  | UnaryOperationInput<InputSchema, OutputSchema>
  | StreamOperationInput<InputSchema, OutputSchema, EventSchema>
  | SubscriptionOperationInput<InputSchema, OutputSchema, EventSchema>;

type DispatchEntry<Result> = {
  readonly tags: ReadonlyArray<string>;
  readonly dispatch: (
    rawInput: unknown,
    context: DispatchContext,
  ) => Promise<DispatchResult<Result>>;
};

export type UnarySchemaOperationDefinition<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
> = UnaryOperationInput<InputSchema, OutputSchema> & DispatchEntry<z.input<OutputSchema>>;

export type StreamSchemaOperationDefinition<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
  EventSchema extends z.ZodType,
> = StreamOperationInput<InputSchema, OutputSchema, EventSchema> &
  DispatchEntry<z.input<OutputSchema> | StreamOperationInvocation<z.input<EventSchema>>>;

export type SubscriptionSchemaOperationDefinition<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
  EventSchema extends z.ZodType,
> = SubscriptionOperationInput<InputSchema, OutputSchema, EventSchema> &
  DispatchEntry<SubscriptionOperationInvocation<z.input<EventSchema>, z.input<OutputSchema>>>;

export type SchemaOperationDefinition<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
  EventSchema extends z.ZodType = never,
> =
  | UnarySchemaOperationDefinition<InputSchema, OutputSchema>
  | StreamSchemaOperationDefinition<InputSchema, OutputSchema, EventSchema>
  | SubscriptionSchemaOperationDefinition<InputSchema, OutputSchema, EventSchema>;

/** Derive authoring contracts from schemas and capture one immutable dispatch policy. */
export function defineOperation<InputSchema extends z.ZodObject, OutputSchema extends z.ZodType>(
  input: UnaryOperationInput<InputSchema, OutputSchema>,
): UnarySchemaOperationDefinition<InputSchema, OutputSchema>;
export function defineOperation<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
  EventSchema extends z.ZodType,
>(
  input: StreamOperationInput<InputSchema, OutputSchema, EventSchema>,
): StreamSchemaOperationDefinition<InputSchema, OutputSchema, EventSchema>;
export function defineOperation<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodType,
  EventSchema extends z.ZodType,
>(
  input: SubscriptionOperationInput<InputSchema, OutputSchema, EventSchema>,
): SubscriptionSchemaOperationDefinition<InputSchema, OutputSchema, EventSchema>;
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
        dispatchStream(operation, { rawInput, context }),
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
        dispatchSubscription(operation, { rawInput, context }),
    });
  }
  const operation = Object.freeze({ ...fields, kind: 'unary' as const, invoke: input.invoke });
  return Object.freeze({
    ...operation,
    dispatch: (rawInput: unknown, context: DispatchContext) =>
      dispatchUnary(operation, { rawInput, context }),
  });
}
