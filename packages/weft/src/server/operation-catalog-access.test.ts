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
import { anonymousPrincipal, principalFromApiKey } from './principal.ts';

const fakeEngine: Parameters<typeof executeOperation>[2]['engine'] = {};

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
