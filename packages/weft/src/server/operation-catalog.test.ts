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
