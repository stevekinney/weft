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
        name: 'weft.test.notfoundthrow',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        producibleFaults: ['NotFound'],
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
      'weft.test.notfoundthrow',
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
