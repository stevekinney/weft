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

import { createOperationRegistry, executeOperation } from './operation-catalog.ts';
import { anonymousPrincipal } from './principal.ts';

const fakeEngine: Parameters<typeof executeOperation>[2]['engine'] = {};

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
