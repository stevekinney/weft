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
import { anonymousPrincipal } from './principal.ts';

const fakeEngine: Parameters<typeof executeOperation>[2]['engine'] = {};

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
