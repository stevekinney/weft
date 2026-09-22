import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { defineOperation } from '../operation-registry.ts';
import { anonymousPrincipal } from '../principal.ts';
import {
  createOperationRegistry,
  executeOperation,
  executeStream,
  executeSubscription,
} from './index.ts';
import type { StreamOperationInvocation, SubscriptionOperationInvocation } from './types.ts';

const context = {
  principal: anonymousPrincipal(),
  engine: {},
  transport: 'http-rest' as const,
};

function operation<OS extends z.ZodType>(
  name: string,
  outputSchema: OS,
  invoke: () => Promise<z.input<OS>>,
) {
  return defineOperation({
    name,
    mcpExposable: false,
    summary: 'output contract test',
    destructive: false,
    tags: [],
    inputSchema: z.object({}),
    outputSchema,
    access: { kind: 'public' },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    invoke,
  });
}

function streamOperation<OS extends z.ZodType, ES extends z.ZodType>(
  name: string,
  outputSchema: OS,
  eventSchema: ES,
  invoke: () => Promise<z.input<OS> | StreamOperationInvocation<z.input<ES>>>,
) {
  return defineOperation({
    name,
    mcpExposable: false,
    summary: 'output contract test',
    destructive: false,
    tags: [],
    inputSchema: z.object({}),
    outputSchema,
    kind: 'stream',
    eventSchema,
    access: { kind: 'public' },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    invoke,
  });
}

function subscriptionOperation<OS extends z.ZodType, ES extends z.ZodType>(
  name: string,
  outputSchema: OS,
  eventSchema: ES,
  invoke: () => Promise<SubscriptionOperationInvocation<z.input<ES>, z.input<OS>>>,
) {
  return defineOperation({
    name,
    mcpExposable: false,
    summary: 'output contract test',
    destructive: false,
    tags: [],
    inputSchema: z.object({}),
    outputSchema,
    kind: 'subscription',
    eventSchema,
    access: { kind: 'public' },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    invoke,
  });
}

describe('operation output contract', () => {
  it('returns parsed transforms and defaults and rejects invalid output', async () => {
    const transformed = operation(
      'weft.contract.transformed',
      z.string().transform((value) => value.length),
      async () => 'abcd',
    );
    const defaulted = operation(
      'weft.contract.defaulted',
      z.object({ count: z.number().default(0) }),
      async () => ({}),
    );

    const transformedResult = await executeOperation(
      'weft.contract.transformed',
      {},
      {
        ...context,
        registry: createOperationRegistry([transformed]),
      },
    );
    const defaultedResult = await executeOperation(
      'weft.contract.defaulted',
      {},
      {
        ...context,
        registry: createOperationRegistry([defaulted]),
      },
    );

    expect(transformedResult).toEqual({ ok: true, value: 4 });
    expect(defaultedResult).toEqual({ ok: true, value: { count: 0 } });
  });

  it('enforces refinements through real dispatch', async () => {
    const refined = operation(
      'weft.contract.refined',
      z.number().refine((value) => value > 0),
      async () => 3,
    );
    const rejected = operation(
      'weft.contract.refinedrejected',
      z.number().refine((value) => value > 0),
      async () => -1,
    );
    const refinedResult = await executeOperation(
      'weft.contract.refined',
      {},
      { ...context, registry: createOperationRegistry([refined]) },
    );
    const rejectedResult = await executeOperation(
      'weft.contract.refinedrejected',
      {},
      { ...context, registry: createOperationRegistry([rejected]) },
    );

    expect(refinedResult).toEqual({ ok: true, value: 3 });
    expect(rejectedResult).toEqual({
      ok: false,
      fault: { code: 'EngineFailure', message: 'internal error', data: {} },
    });
  });

  it('parses transformed stream elements and rejects invalid elements', async () => {
    const stream = streamOperation(
      'weft.contract.stream',
      z.object({ started: z.boolean() }),
      z.string().transform((value) => value.length),
      async () =>
        (async function* () {
          yield 'event';
        })(),
    );
    const invalidStream = streamOperation(
      'weft.contract.streaminvalid',
      z.object({ started: z.boolean() }),
      z.string().refine((value) => value === 'expected'),
      async () =>
        (async function* () {
          yield 'wrong';
        })(),
    );
    const streamResult = await executeStream(
      'weft.contract.stream',
      {},
      { ...context, registry: createOperationRegistry([stream]) },
    );
    const invalidResult = await executeStream(
      'weft.contract.streaminvalid',
      {},
      { ...context, registry: createOperationRegistry([invalidStream]) },
    );

    expect(streamResult.ok).toBe(true);
    if (streamResult.ok) {
      const first = await streamResult.value[Symbol.asyncIterator]().next();
      expect(first).toEqual({ done: false, value: 5 });
    }
    expect(invalidResult.ok).toBe(true);
    if (invalidResult.ok) {
      try {
        await invalidResult.value[Symbol.asyncIterator]().next();
        throw new Error('expected stream element validation to reject');
      } catch (error) {
        expect(error).toMatchObject({ name: 'SubscriptionElementValidationError' });
      }
    }
  });

  it('parses transformed subscription envelope and events and preserves close', async () => {
    let closeCalls = 0;
    const subscription = subscriptionOperation(
      'weft.contract.subscription',
      z.object({ subscriptionId: z.string() }).transform((value) => ({
        id: value.subscriptionId,
      })),
      z.object({ value: z.string() }).transform((value) => ({
        length: value.value.length,
      })),
      async () => ({
        envelope: { subscriptionId: 'sub-1' },
        iterable: (async function* () {
          yield { value: 'event' };
        })(),
        close: async () => {
          closeCalls += 1;
        },
      }),
    );
    const result = await executeSubscription(
      'weft.contract.subscription',
      {},
      { ...context, registry: createOperationRegistry([subscription]) },
    );

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({ envelope: { id: 'sub-1' } }),
    });
    if (result.ok) {
      const first = await result.value.iterable[Symbol.asyncIterator]().next();
      expect(first).toEqual({
        done: false,
        value: { length: 5 },
      });
      await result.value.close();
    }
    expect(closeCalls).toBe(1);
  });
});
