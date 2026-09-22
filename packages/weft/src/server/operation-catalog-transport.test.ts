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

async function* streamFixture() {
  yield { chunk: 'should-not-run' };
}

describe('executeOperation — step 2: transport availability', () => {
  it('transport not in availability -> UnsupportedTransport fault', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.subscribeonly',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => ({}),
        transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: true },
      }),
    ]);
    const result = await executeOperation(
      'weft.test.subscribeonly',
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

  it('non-unary stream operation -> Unprocessable before invoke', async () => {
    let invokeCount = 0;
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.streamoverrequest',
        kind: 'stream',
        eventSchema: z.object({ chunk: z.string() }),
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => {
          invokeCount += 1;
          return streamFixture();
        },
      }),
    ]);
    const result = await executeOperation(
      'weft.test.streamoverrequest',
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
    expect(result.fault.code).toBe('Unprocessable');
    expect(result.fault.message).toBe('operation "weft.test.streamoverrequest" is not unary');
    expect(result.fault.data).toEqual({ reason: 'operation kind is "stream"' });
    expect(invokeCount).toBe(0);
  });
});
