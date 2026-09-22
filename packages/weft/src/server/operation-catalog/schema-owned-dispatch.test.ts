import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { defineOperation } from '../operation-registry.ts';
import { anonymousPrincipal, principalFromApiKey } from '../principal.ts';
import { createOperationRegistry } from './registry.ts';

const context = {
  principal: anonymousPrincipal(),
  engine: {},
  transport: 'jsonRpcHttp' as const,
  registry: createOperationRegistry([]),
};

describe('schema-owned operation dispatch', () => {
  it('parses once and gives the transformed input to authorization and invoke', async () => {
    let parses = 0;
    let authorizations = 0;
    let invocations = 0;
    let authorizedInput: { value: number } | undefined;
    let invokedInput: { value: number } | undefined;
    const transports = {
      http: false,
      jsonRpcHttp: true,
      jsonRpcWebSocket: false,
      jsonRpcStdio: false,
    };
    const operation = defineOperation({
      name: 'weft.schemaowned.parseonce',
      mcpExposable: false,
      summary: 'parse once',
      destructive: false,
      inputSchema: z.object({
        value: z.string().transform((value) => {
          parses += 1;
          return value.length;
        }),
      }),
      outputSchema: z.object({ value: z.number() }),
      access: { kind: 'public' as const },
      transports,
      unknownKeyPolicy: { http: 'reject' as const, jsonRpc: 'reject' as const },
      authorize: async ({ input }) => {
        authorizations += 1;
        authorizedInput = input;
        return input.value === 4 ? { allowed: true } : { allowed: false, reason: 'wrong value' };
      },
      invoke: async ({ input }) => {
        invocations += 1;
        invokedInput = input;
        return { value: input.value };
      },
    });

    transports.jsonRpcHttp = false;

    const result = await operation.dispatch({ value: 'four' }, context);

    expect(result).toEqual({ ok: true, value: { value: 4 } });
    expect(parses).toBe(1);
    expect(invokedInput).toBe(authorizedInput);
    expect(Reflect.set(operation.transports, 'jsonRpcHttp', false)).toBe(false);

    const markers: string[] = [];
    const malformed = await operation.dispatch(
      { value: 4 },
      { ...context, pipelineTrace: (marker) => markers.push(marker) },
    );
    expect(malformed.ok).toBe(false);
    expect(authorizations).toBe(1);
    expect(invocations).toBe(1);
    expect(invokedInput).toBe(authorizedInput);
    expect(markers).toEqual(['transport-checked', 'access-checked']);
  });

  it('returns a typed stream invocation after authorization', async () => {
    const operation = defineOperation({
      name: 'weft.schemaowned.stream',
      mcpExposable: false,
      destructive: false,
      kind: 'stream' as const,
      summary: 'stream',
      inputSchema: z.object({}),
      outputSchema: z.object({ started: z.boolean() }),
      eventSchema: z.string().transform((value) => value.length),
      access: { kind: 'public' as const },
      transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject' as const, jsonRpc: 'reject' as const },
      invoke: async () =>
        (async function* () {
          yield 'event';
        })(),
    });

    const result = await operation.dispatch({}, context);

    expect(result.ok).toBe(true);
    if (
      !result.ok ||
      typeof result.value !== 'object' ||
      result.value === null ||
      !(Symbol.asyncIterator in result.value) ||
      typeof result.value[Symbol.asyncIterator] !== 'function'
    ) {
      throw new Error('expected an async iterable result');
    }
    expect(await result.value[Symbol.asyncIterator]().next()).toEqual({
      done: false,
      value: 'event',
    });
  });

  it('shares frozen access metadata with dispatch and hides raw registry callbacks', async () => {
    const scopes: ['workflows:read'] = ['workflows:read'];
    const alternatives = [{ kind: 'allOf' as const, scopes }] as const;
    const operation = defineOperation({
      name: 'weft.schemaowned.policy',
      mcpExposable: false,
      summary: 'immutable policy',
      destructive: false,
      inputSchema: z.object({}),
      outputSchema: z.boolean(),
      access: { kind: 'scopedAlternatives', alternatives },
      transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      authorize: async () => ({ allowed: true }),
      invoke: async () => true,
    });
    const registry = createOperationRegistry([operation]);
    const entry = registry.get(operation.name);
    if (entry === undefined || operation.access.kind !== 'scopedAlternatives') {
      throw new Error('expected registered scope alternatives');
    }
    expect('invoke' in entry).toBe(false);
    expect('authorize' in entry).toBe(false);
    expect(entry.access).toBe(operation.access);
    expect(Reflect.set(operation.access, 'kind', 'public')).toBe(false);
    expect(Reflect.set(operation.access.alternatives, 'length', 0)).toBe(false);
    expect(Reflect.set(operation.access.alternatives[0].scopes, '0', 'system:admin')).toBe(false);
    expect(Reflect.set(scopes, 'length', 0)).toBe(true);
    expect(await entry.dispatch({}, { ...context, registry })).toMatchObject({ ok: false });
    expect(
      await entry.dispatch(
        {},
        {
          ...context,
          registry,
          principal: principalFromApiKey({ subject: 'reader', scopes: ['workflows:read'] }),
        },
      ),
    ).toEqual({ ok: true, value: true });
  });
});
