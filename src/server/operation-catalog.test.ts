/**
 * Tests for `OperationDefinition`, `executeOperation` pipeline, and
 * `classifyEngineError`. The pipeline is the single dispatch point that
 * REST, JSON-RPC HTTP, JSON-RPC WebSocket, and stdio transports all call —
 * the structural enforcement that prevents drift between transports per
 * Track 8 design decision 2.
 *
 * Pipeline order under test (each step has at least one passing and one
 * failing case):
 *   1. resolve operation by name
 *   2. transport availability
 *   3. access check (driven by AccessPolicy)
 *   4. zod parse (shape only, .passthrough() semantics)
 *   5. unknown-key policy enforcement
 *   6. authorize hook
 *   7. invoke
 *   8. catch + classify
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  classifyEngineError,
  createOperationRegistry,
  executeOperation,
  type ErasedOperation,
  type OperationDefinition,
} from './operation-catalog.ts';
import { anonymousPrincipal, principalFromApiKey } from './principal.ts';

// A trivial fake engine — these tests never need real workflow state.
const fakeEngine = {} as Parameters<typeof executeOperation>[2]['engine'];

function makeOp<Input, Output>(
  overrides: Partial<OperationDefinition<Input, Output>> & {
    name: string;
    inputSchema: z.ZodType<Input>;
    outputSchema: z.ZodType<Output>;
    invoke: OperationDefinition<Input, Output>['invoke'];
  },
): ErasedOperation {
  // Cast to the type-erased registry shape — the inputSchema's type
  // parameter is contravariant in `authorize`/`invoke` and exact-optional
  // checking blocks direct assignment without erasure. Tests are exempt
  // from the no-`as` rule per CLAUDE.md.
  return {
    summary: 'test op',
    tags: [],
    access: { kind: 'public' },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    ...overrides,
  } as unknown as ErasedOperation;
}

describe('executeOperation — happy path', () => {
  it('parses input, invokes, returns ok', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.echo',
        inputSchema: z.object({ value: z.string() }),
        outputSchema: z.object({ echoed: z.string() }),
        invoke: async ({ input }) => ({ echoed: input.value }),
      }),
    ]);
    const result = await executeOperation(
      'weft.test.echo',
      { value: 'hi' },
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    expect(result).toEqual({ ok: true, value: { echoed: 'hi' } });
  });
});

describe('executeOperation — step 1: resolve operation', () => {
  it('unknown operation -> MethodNotFound fault', async () => {
    const registry = createOperationRegistry([]);
    const result = await executeOperation(
      'weft.does-not-exist',
      {},
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('MethodNotFound');
    if (result.fault.code !== 'MethodNotFound') throw new Error('shape');
    expect(result.fault.data.method).toBe('weft.does-not-exist');
  });
});

describe('executeOperation — step 2: transport availability', () => {
  it('transport not in availability -> UnsupportedTransport fault', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.subscribeOnly',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => ({}),
        transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: true },
      }),
    ]);
    const result = await executeOperation(
      'weft.test.subscribeOnly',
      {},
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'jsonRpcHttp',
        registry,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('UnsupportedTransport');
    if (result.fault.code !== 'UnsupportedTransport') throw new Error('shape');
    expect(result.fault.data.transport).toBe('jsonRpcHttp');
    expect(result.fault.data.supported).toContain('jsonRpcWebSocket');
    expect(result.fault.data.supported).not.toContain('jsonRpcHttp');
  });
});

describe('executeOperation — step 3: access check', () => {
  const registry = createOperationRegistry([
    makeOp({
      name: 'weft.test.scoped',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
      access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['workflows:read'] } },
    }),
  ]);

  it('unauthenticated principal on scoped op -> Unauthorized fault', async () => {
    const result = await executeOperation(
      'weft.test.scoped',
      {},
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('Unauthorized');
  });

  it('authenticated principal without scope -> Forbidden fault', async () => {
    const result = await executeOperation(
      'weft.test.scoped',
      {},
      {
        principal: principalFromApiKey({ subject: 'k', scopes: [] }),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('Forbidden');
  });

  it('authenticated principal with scope -> proceeds', async () => {
    const result = await executeOperation(
      'weft.test.scoped',
      {},
      {
        principal: principalFromApiKey({ subject: 'k', scopes: ['workflows:read'] }),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    expect(result.ok).toBe(true);
  });
});

describe('executeOperation — step 4: zod parse', () => {
  const registry = createOperationRegistry([
    makeOp({
      name: 'weft.test.typed',
      inputSchema: z.object({ id: z.string(), count: z.number() }),
      outputSchema: z.object({}),
      invoke: async () => ({}),
    }),
  ]);

  it('invalid input -> InvalidParams fault with flattened issues', async () => {
    const result = await executeOperation(
      'weft.test.typed',
      { id: 'x', count: 'not-a-number' },
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('InvalidParams');
    if (result.fault.code !== 'InvalidParams') throw new Error('shape');
    expect(result.fault.data.issues.length).toBeGreaterThan(0);
    expect(result.fault.data.issues[0]?.path).toContain('count');
  });

  it('null input is rejected as InvalidParams', async () => {
    const result = await executeOperation('weft.test.typed', null, {
      principal: anonymousPrincipal(),
      engine: fakeEngine,
      transport: 'http-rest',
      registry,
    });
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('InvalidParams');
  });
});

describe('executeOperation — step 5: unknown-key policy', () => {
  function regWithPolicy(http: 'reject' | 'strip' | 'passthrough') {
    return createOperationRegistry([
      makeOp({
        name: 'weft.test.unknownKey',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ receivedKeys: z.array(z.string()) }),
        invoke: async ({ input }) => ({
          receivedKeys: Object.keys(input as object).toSorted(),
        }),
        unknownKeyPolicy: { http, jsonRpc: 'reject' },
      }),
    ]);
  }

  it('reject -> InvalidParams with unrecognized_keys', async () => {
    const result = await executeOperation(
      'weft.test.unknownKey',
      { id: 'x', extra: 'snuck-in' },
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry: regWithPolicy('reject'),
      },
    );
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('InvalidParams');
    if (result.fault.code !== 'InvalidParams') throw new Error('shape');
    const issue = result.fault.data.issues[0];
    expect(issue?.code).toBe('unrecognized_keys');
  });

  it('strip -> unknown keys dropped, invoke sees only schema fields', async () => {
    const result = await executeOperation(
      'weft.test.unknownKey',
      { id: 'x', extra: 'snuck-in' },
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry: regWithPolicy('strip'),
      },
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).toEqual({ receivedKeys: ['id'] });
  });

  it('passthrough -> unknown keys preserved into invoke', async () => {
    const result = await executeOperation(
      'weft.test.unknownKey',
      { id: 'x', extra: 'snuck-in' },
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry: regWithPolicy('passthrough'),
      },
    );
    if (!result.ok) throw new Error('expected ok');
    const value = result.value as { receivedKeys: string[] };
    expect(value.receivedKeys.toSorted()).toEqual(['extra', 'id']);
  });
});

describe('executeOperation — step 6: authorize hook', () => {
  it('hook denial -> Forbidden fault with reason', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.hooked',
        inputSchema: z.object({ workflowId: z.string() }),
        outputSchema: z.object({}),
        invoke: async () => ({}),
        access: { kind: 'authenticated' },
        authorize: async ({ input }) => {
          if (input.workflowId === 'forbidden') {
            return { allowed: false, reason: 'workflow not in tenant' };
          }
          return { allowed: true };
        },
      }),
    ]);
    const principal = principalFromApiKey({ subject: 'k', scopes: [] });

    const allowed = await executeOperation(
      'weft.test.hooked',
      { workflowId: 'allowed' },
      { principal, engine: fakeEngine, transport: 'http-rest', registry },
    );
    expect(allowed.ok).toBe(true);

    const denied = await executeOperation(
      'weft.test.hooked',
      { workflowId: 'forbidden' },
      { principal, engine: fakeEngine, transport: 'http-rest', registry },
    );
    if (denied.ok) throw new Error('expected fault');
    expect(denied.fault.code).toBe('Forbidden');
    if (denied.fault.code !== 'Forbidden') throw new Error('shape');
    expect(denied.fault.data.reason).toContain('workflow not in tenant');
  });

  it('hook throw -> EngineFailure (no internal detail leaked)', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.hookThrows',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => ({}),
        access: { kind: 'authenticated' },
        authorize: async () => {
          throw new Error('database password: hunter2');
        },
      }),
    ]);
    const result = await executeOperation(
      'weft.test.hookThrows',
      {},
      {
        principal: principalFromApiKey({ subject: 'k', scopes: [] }),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('EngineFailure');
    expect(result.fault.message).not.toContain('hunter2');
  });
});

describe('executeOperation — step 7+8: invoke + classify', () => {
  it('invoke throws Error -> classified as EngineFailure', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.boom',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => {
          throw new Error('something went wrong');
        },
      }),
    ]);
    const result = await executeOperation(
      'weft.test.boom',
      {},
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('EngineFailure');
  });

  it('invoke throws an OperationFault -> passed through unchanged', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.notFoundThrow',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => {
          throw {
            code: 'NotFound',
            message: 'workflow "wf-1" not found',
            data: { resource: 'workflow', identifier: 'wf-1' },
          };
        },
      }),
    ]);
    const result = await executeOperation(
      'weft.test.notFoundThrow',
      {},
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('NotFound');
    if (result.fault.code !== 'NotFound') throw new Error('shape');
    expect(result.fault.data.identifier).toBe('wf-1');
  });
});

describe('classifyEngineError', () => {
  it('classifies a thrown OperationFault by passing it through', () => {
    const fault = classifyEngineError({
      code: 'Conflict',
      message: 'dup',
      data: { reason: 'duplicate id' },
    });
    expect(fault.code).toBe('Conflict');
  });

  it('classifies an Error with "not found" message as NotFound with a generic public message', () => {
    const fault = classifyEngineError(new Error('workflow "wf-x" not found at /var/secret/path'));
    expect(fault.code).toBe('NotFound');
    // The original error message MUST NOT propagate to the wire — it can
    // contain internal details like file paths, query text, or secrets.
    expect(fault.message).toBe('not found');
    expect(fault.message).not.toContain('/var/secret/path');
  });

  it('classifies an Error with "already exists" message as Conflict with a generic message', () => {
    const fault = classifyEngineError(
      new Error('schedule with id "sched-1" already exists in tenant secret-tenant'),
    );
    expect(fault.code).toBe('Conflict');
    expect(fault.message).toBe('conflict');
    expect(fault.message).not.toContain('secret-tenant');
  });

  it('classifies an Error with "timeout" message as Timeout with a generic message', () => {
    const fault = classifyEngineError(new Error('update timeout exceeded after 30s'));
    expect(fault.code).toBe('Timeout');
    expect(fault.message).toBe('operation timed out');
  });

  it('classifies any unrecognized Error as EngineFailure with a generic message', () => {
    const fault = classifyEngineError(new Error('mysterious failure with internals'));
    expect(fault.code).toBe('EngineFailure');
    expect(fault.message).toBe('internal error');
  });

  it('classifies a thrown non-Error value as EngineFailure', () => {
    const fault = classifyEngineError('a string thrown for some reason');
    expect(fault.code).toBe('EngineFailure');
  });

  it('classifies a thrown null/undefined as EngineFailure', () => {
    expect(classifyEngineError(null).code).toBe('EngineFailure');
    expect(classifyEngineError(undefined).code).toBe('EngineFailure');
  });
});

describe('createOperationRegistry', () => {
  it('rejects duplicate operation names at construction time', () => {
    const op1 = makeOp({
      name: 'weft.dup',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
    });
    const op2 = makeOp({
      name: 'weft.dup',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
    });
    expect(() => createOperationRegistry([op1, op2])).toThrow(/duplicate operation name/i);
  });

  it('lookup returns undefined for unknown names (executeOperation handles the fault)', () => {
    const registry = createOperationRegistry([]);
    expect(registry.get('weft.unknown')).toBeUndefined();
  });

  it('rejects operations whose inputSchema is not a z.ZodObject', () => {
    const op = makeOp({
      name: 'weft.test.notObject',
      // A string schema isn't an object — unknown-key policy can't apply.
      inputSchema: z.string() as unknown as z.ZodType,
      outputSchema: z.object({}),
      invoke: async () => ({}),
    });
    expect(() => createOperationRegistry([op])).toThrow(/must be a z\.ZodObject/);
  });

  it('list returns all operations in registration order', () => {
    const op1 = makeOp({
      name: 'weft.a',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
    });
    const op2 = makeOp({
      name: 'weft.b',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
    });
    const registry = createOperationRegistry([op1, op2]);
    expect(registry.list().map((op) => op.name)).toEqual(['weft.a', 'weft.b']);
  });
});
