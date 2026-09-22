import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { makeOperation as makeOp } from './json-rpc-operation.test-support.ts';
import {
  executeOperation,
  type ErasedOperation,
  type OperationRegistry,
} from './operation-catalog.ts';
import { dispatchUnary } from './operation-catalog/operation-dispatch.ts';
import type { OperationFault } from './operation-fault.ts';
import { anonymousPrincipal } from './principal.ts';

const fakeEngine: Parameters<typeof executeOperation>[2]['engine'] = {};
const ENGINE_FAILURE_FAULT = {
  code: 'EngineFailure',
  message: 'internal error',
  data: {},
} satisfies OperationFault;

function registryFor(operation: ErasedOperation): OperationRegistry {
  return {
    get: (name) => (name === operation.name ? operation : undefined),
    list: () => [operation],
  };
}

function malformedDispatchOperation(
  base: ErasedOperation,
  overrides: Record<string, unknown>,
): unknown {
  const operation: Record<string, unknown> = { ...base, ...overrides };
  operation['dispatch'] = (rawInput: unknown, context: unknown) =>
    Reflect.apply(dispatchUnary, undefined, [operation, { rawInput, context }]);
  return operation;
}

describe('executeOperation — defensive schema guards', () => {
  it('returns EngineFailure when malformed input and output schemas throw', async () => {
    const base = makeOp({
      name: 'weft.test.defensiveschema',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
    });
    let result = await executeOperation(
      'weft.test.defensiveschema',
      {},
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry: Reflect.apply(registryFor, undefined, [
          malformedDispatchOperation(base, { inputSchema: z.string() }),
        ]),
      },
    );
    expect(result).toEqual({ ok: false, fault: ENGINE_FAILURE_FAULT });

    result = await executeOperation(
      'weft.test.defensiveschema',
      {},
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry: Reflect.apply(registryFor, undefined, [
          malformedDispatchOperation(base, {
            outputSchema: {
              safeParse: () => {
                throw new Error('output parser exploded');
              },
            },
          }),
        ]),
      },
    );
    expect(result).toEqual({ ok: false, fault: ENGINE_FAILURE_FAULT });
  });
});
