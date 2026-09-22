import { z } from 'zod';

import { defineOperation } from '../operation-registry.ts';
import { executeOperation } from './pipeline.ts';
import { executeStream, executeSubscription } from './stream-pipeline.ts';

const base = {
  name: 'weft.contract.output',
  mcpExposable: false,
  summary: 'output contract probe',
  destructive: false,
  inputSchema: z.object({}),
  access: { kind: 'public' as const },
  transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'reject' as const, jsonRpc: 'reject' as const },
};

const opaqueOperation = defineOperation({
  ...base,
  outputSchema: z.unknown(),
  invoke: async () => ({ domain: 'opaque' }),
});
void opaqueOperation;

const transformedOperation = defineOperation({
  ...base,
  outputSchema: z.string().transform((value) => value.length),
  invoke: async () => 'value',
});
void transformedOperation;

const inferredDefaultOperation = defineOperation({
  ...base,
  outputSchema: z.object({ count: z.number().default(0) }),
  invoke: async () => ({ count: 0 }),
});
type InferredDefaultOutput = z.output<typeof inferredDefaultOperation.outputSchema>;
const inferredDefaultOutput: InferredDefaultOutput = { count: 1 };
// @ts-expect-error The defaulted schema output is a number, not a string.
const invalidDefaultOutput: InferredDefaultOutput = { count: 'wrong' };
void inferredDefaultOutput;
void invalidDefaultOutput;

const transformedStreamEventSchema = z.string().transform((value) => value.length);
const transformedStream = defineOperation({
  ...base,
  kind: 'stream',
  outputSchema: z.unknown(),
  eventSchema: transformedStreamEventSchema,
  invoke: async () =>
    (async function* () {
      yield 'event';
    })(),
});
const parsedStreamElement: z.output<typeof transformedStreamEventSchema> = 5;
// @ts-expect-error The invocation element is a string while the parsed event is a number.
const invalidParsedStreamElement: z.output<typeof transformedStreamEventSchema> = 'event';
void transformedStream;
void parsedStreamElement;
void invalidParsedStreamElement;

const scalarStream = defineOperation({
  ...base,
  kind: 'stream',
  outputSchema: z.string(),
  eventSchema: z.string(),
  invoke: async () => 'scalar stream result',
});
void scalarStream;

const transformedSubscriptionEventSchema = z.object({ raw: z.string() }).transform((value) => ({
  length: value.raw.length,
}));
const transformedSubscription = defineOperation({
  ...base,
  kind: 'subscription',
  outputSchema: z.object({ id: z.string() }),
  eventSchema: transformedSubscriptionEventSchema,
  invoke: async () => ({
    envelope: { id: 'sub' },
    iterable: (async function* () {
      yield { raw: 'event' };
    })(),
    close: async () => {},
  }),
});
const parsedSubscriptionEvent: z.output<typeof transformedSubscriptionEventSchema> = { length: 5 };
const invalidParsedSubscriptionEvent: z.output<typeof transformedSubscriptionEventSchema> = {
  // @ts-expect-error The parsed subscription event requires the transformed object shape.
  raw: 'event',
};
void transformedSubscription;
void parsedSubscriptionEvent;
void invalidParsedSubscriptionEvent;

defineOperation({
  ...base,
  kind: 'subscription',
  outputSchema: z.unknown(),
  eventSchema: z.string(),
  // @ts-expect-error A subscription invoke must return an envelope, iterable, and close hook.
  invoke: async () => 'scalar subscription result',
});

const opaqueOutputSchema = z.unknown();
defineOperation({
  ...base,
  outputSchema: opaqueOutputSchema,
  invoke: async () => ({ domain: 'opaque' }),
});
const opaqueOutput: z.output<typeof opaqueOutputSchema> = { domain: 'opaque' };
// @ts-expect-error Opaque schema output is unknown and requires validation before domain use.
const unvalidatedDomainOutput: { domain: string } = opaqueOutput;
void unvalidatedDomainOutput;

const stringOutputOperation = defineOperation({
  ...base,
  outputSchema: z.string(),
  invoke: async () => 'value',
});
void stringOutputOperation;

// @ts-expect-error Name-only dispatch cannot accept a caller-invented output type.
const forgedDispatch = executeOperation<{ forged: true }>;
void forgedDispatch;

// @ts-expect-error Name-only stream dispatch cannot accept a caller-invented output type.
const forgedStreamDispatch = executeStream<{ forged: true }>;
void forgedStreamDispatch;

// @ts-expect-error Name-only subscription dispatch cannot accept a caller-invented output type.
const forgedSubscriptionDispatch = executeSubscription<{ forged: true }>;
void forgedSubscriptionDispatch;
