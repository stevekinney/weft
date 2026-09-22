/**
 * Tests for `OperationDefinition`, `executeOperation` pipeline, and
 * `classifyEngineError`. The pipeline is the single dispatch point that
 * REST, JSON-RPC HTTP, JSON-RPC WebSocket, and stdio transports all call —
 * the structural enforcement that prevents drift between transports in the
 * stable operation-catalog contract.
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

import { makeOperation as makeOp } from './json-rpc-operation.test-support.ts';
import { createOperationRegistry, executeOperation } from './operation-catalog.ts';
import { dispatchUnary } from './operation-catalog/operation-dispatch.ts';
import { anonymousPrincipal, principalFromApiKey } from './principal.ts';

const fakeEngine: Parameters<typeof executeOperation>[2]['engine'] = {};

describe('executeOperation — step 6: authorize hook', () => {
  it('rejects malformed authorize hook return values', async () => {
    const base = makeOp({
      name: 'weft.test.badhook',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
      access: { kind: 'authenticated' },
    });
    const malformed: Record<string, unknown> = { ...base, authorize: async () => undefined };
    malformed['dispatch'] = (rawInput: unknown, context: unknown) =>
      Reflect.apply(dispatchUnary, undefined, [malformed, { rawInput, context }]);
    const registry = Reflect.apply(createOperationRegistry, undefined, [[malformed]]);
    const result = await executeOperation(
      'weft.test.badhook',
      {},
      {
        principal: principalFromApiKey({ subject: 'k', scopes: [] }),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fault.code).toBe('EngineFailure');
  });

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
            return { allowed: false, reason: 'workflow not permitted' };
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
    expect(denied.fault.data.reason).toContain('workflow not permitted');
  });

  it('hook denial can classify unauthenticated callers as Unauthorized', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.hookunauthorized',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => ({}),
        access: { kind: 'public' },
        authorize: async () => ({
          allowed: false,
          classification: 'unauthorized',
          reason: 'authentication required',
        }),
      }),
    ]);

    const result = await executeOperation(
      'weft.test.hookunauthorized',
      {},
      { principal: anonymousPrincipal(), engine: fakeEngine, transport: 'http-rest', registry },
    );

    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('Unauthorized');
    if (result.fault.code !== 'Unauthorized') throw new Error('shape');
    expect(result.fault.data.reason).toBe('authentication required');
  });

  it('hook throw -> EngineFailure (no internal detail leaked)', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.hookthrows',
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
      'weft.test.hookthrows',
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
