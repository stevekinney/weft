/**
 * Tests for `dispatchJsonRpc` — the transport-neutral JSON-RPC dispatcher
 * that every JSON-RPC transport adapter (HTTP POST, WebSocket frame,
 * stdio session) funnels through. Parses the incoming body, resolves
 * each request against the operation registry via `executeOperation`,
 * and produces JSON-RPC response objects (or an empty batch when every
 * item is a notification).
 *
 * Batches dispatch SEQUENTIALLY in request order (Track 8 design
 * decision 13). Response order matches request order by construction.
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { dispatchJsonRpc } from './json-rpc-dispatch.ts';
import {
  createOperationRegistry,
  type ErasedOperation,
  type OperationDefinition,
} from './operation-catalog.ts';
import { anonymousPrincipal } from './principal.ts';

const fakeEngine = {} as unknown;

function makeOp<I, O>(
  overrides: Partial<OperationDefinition<I, O>> & {
    name: string;
    inputSchema: z.ZodType<I>;
    outputSchema: z.ZodType<O>;
    invoke: OperationDefinition<I, O>['invoke'];
  },
): ErasedOperation {
  return {
    summary: 'test op',
    tags: [],
    access: { kind: 'public' },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    ...overrides,
  } as unknown as ErasedOperation;
}

function baseContext() {
  return {
    principal: anonymousPrincipal(),
    engine: fakeEngine,
    transport: 'jsonRpcHttp' as const,
  };
}

describe('dispatchJsonRpc — body-level errors', () => {
  it('returns a parse-error response for malformed JSON', async () => {
    const registry = createOperationRegistry([]);
    const result = await dispatchJsonRpc('{"jsonrpc":"2.0"', { ...baseContext(), registry });
    expect(result.kind).toBe('single');
    if (result.kind !== 'single') throw new Error('shape');
    if (!('error' in result.response)) throw new Error('expected error response');
    expect(result.response.error.code).toBe(-32700);
    expect(result.response.id).toBeNull();
  });

  it('returns invalid-request for top-level non-object non-array', async () => {
    const registry = createOperationRegistry([]);
    const result = await dispatchJsonRpc('42', { ...baseContext(), registry });
    if (result.kind !== 'single') throw new Error('shape');
    if (!('error' in result.response)) throw new Error('expected error response');
    expect(result.response.error.code).toBe(-32600);
  });

  it('returns invalid-request for an empty batch', async () => {
    const registry = createOperationRegistry([]);
    const result = await dispatchJsonRpc('[]', { ...baseContext(), registry });
    if (result.kind !== 'single') throw new Error('shape');
    if (!('error' in result.response)) throw new Error('expected error response');
    expect(result.response.error.code).toBe(-32600);
  });
});

describe('dispatchJsonRpc — single request', () => {
  it('returns a success response for a valid request', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.echo',
        inputSchema: z.object({ value: z.string() }),
        outputSchema: z.object({ echoed: z.string() }),
        invoke: async ({ input }) => ({ echoed: input.value }),
      }),
    ]);
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'weft.test.echo',
      params: { value: 'hi' },
      id: 1,
    });
    const result = await dispatchJsonRpc(body, { ...baseContext(), registry });
    if (result.kind !== 'single') throw new Error('shape');
    if ('error' in result.response) throw new Error('expected success');
    expect(result.response.jsonrpc).toBe('2.0');
    expect(result.response.result).toEqual({ echoed: 'hi' });
    expect(result.response.id).toBe(1);
  });

  it('returns a MethodNotFound error for an unknown operation', async () => {
    const registry = createOperationRegistry([]);
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'weft.unknown.op', id: 1 });
    const result = await dispatchJsonRpc(body, { ...baseContext(), registry });
    if (result.kind !== 'single') throw new Error('shape');
    if (!('error' in result.response)) throw new Error('expected error');
    expect(result.response.error.code).toBe(-32601);
    expect(result.response.id).toBe(1);
  });

  it('returns UnsupportedTransport when the op is not available on this transport', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.wsonly',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => ({}),
        transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: true },
      }),
    ]);
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'weft.test.wsonly', id: 1 });
    const result = await dispatchJsonRpc(body, { ...baseContext(), registry });
    if (result.kind !== 'single') throw new Error('shape');
    if (!('error' in result.response)) throw new Error('expected error');
    expect(result.response.error.code).toBe(-32030);
  });

  it('returns no response for a notification (id absent)', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.note',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => ({}),
      }),
    ]);
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'weft.test.note' });
    const result = await dispatchJsonRpc(body, { ...baseContext(), registry });
    expect(result.kind).toBe('notification');
  });

  it('notifications still invoke the operation (side effects applied)', async () => {
    let invoked = false;
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.sidenote',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => {
          invoked = true;
          return {};
        },
      }),
    ]);
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'weft.test.sidenote' });
    await dispatchJsonRpc(body, { ...baseContext(), registry });
    expect(invoked).toBe(true);
  });

  it('rejects array-form params with InvalidRequest (named-params-only policy)', async () => {
    const registry = createOperationRegistry([]);
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'weft.test.echo',
      params: [1, 2, 3],
      id: 1,
    });
    const result = await dispatchJsonRpc(body, { ...baseContext(), registry });
    if (result.kind !== 'single') throw new Error('shape');
    if (!('error' in result.response)) throw new Error('expected error');
    expect(result.response.error.code).toBe(-32600);
  });
});

describe('dispatchJsonRpc — batch', () => {
  function registryOfTwo() {
    return createOperationRegistry([
      makeOp({
        name: 'weft.test.one',
        inputSchema: z.object({}),
        outputSchema: z.object({ tag: z.string() }),
        invoke: async () => ({ tag: 'one' }),
      }),
      makeOp({
        name: 'weft.test.two',
        inputSchema: z.object({}),
        outputSchema: z.object({ tag: z.string() }),
        invoke: async () => ({ tag: 'two' }),
      }),
    ]);
  }

  it('returns responses in request order', async () => {
    const registry = registryOfTwo();
    const body = JSON.stringify([
      { jsonrpc: '2.0', method: 'weft.test.two', id: 'b' },
      { jsonrpc: '2.0', method: 'weft.test.one', id: 'a' },
    ]);
    const result = await dispatchJsonRpc(body, { ...baseContext(), registry });
    expect(result.kind).toBe('batch');
    if (result.kind !== 'batch') throw new Error('shape');
    expect(result.responses).toHaveLength(2);
    expect(result.responses[0]?.id).toBe('b');
    expect(result.responses[1]?.id).toBe('a');
  });

  it('dispatches batch items SEQUENTIALLY (side-effect order matches request order)', async () => {
    // Track 8 decision 13 — batches are not concurrent.
    const callOrder: string[] = [];
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.seq',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({}),
        invoke: async ({ input }) => {
          callOrder.push(input.id);
          return {};
        },
      }),
    ]);
    const body = JSON.stringify([
      { jsonrpc: '2.0', method: 'weft.test.seq', params: { id: 'first' }, id: 1 },
      { jsonrpc: '2.0', method: 'weft.test.seq', params: { id: 'second' }, id: 2 },
      { jsonrpc: '2.0', method: 'weft.test.seq', params: { id: 'third' }, id: 3 },
    ]);
    await dispatchJsonRpc(body, { ...baseContext(), registry });
    expect(callOrder).toEqual(['first', 'second', 'third']);
  });

  it('drops notifications from the response array (mixed batch)', async () => {
    const registry = registryOfTwo();
    const body = JSON.stringify([
      { jsonrpc: '2.0', method: 'weft.test.one', id: 1 },
      { jsonrpc: '2.0', method: 'weft.test.two' }, // notification — no id
      { jsonrpc: '2.0', method: 'weft.test.one', id: 2 },
    ]);
    const result = await dispatchJsonRpc(body, { ...baseContext(), registry });
    if (result.kind !== 'batch') throw new Error('shape');
    expect(result.responses).toHaveLength(2);
    expect(result.responses.map((r) => r.id)).toEqual([1, 2]);
  });

  it('returns kind=notification-batch when every item is a notification', async () => {
    // Transport adapters translate this to HTTP 204 / nothing on the
    // wire. Spec-compliant — no response body for all-notification
    // batches.
    const registry = registryOfTwo();
    const body = JSON.stringify([
      { jsonrpc: '2.0', method: 'weft.test.one' },
      { jsonrpc: '2.0', method: 'weft.test.two' },
    ]);
    const result = await dispatchJsonRpc(body, { ...baseContext(), registry });
    expect(result.kind).toBe('notification-batch');
  });

  it('surfaces per-item invalid-request with the requestor id preserved', async () => {
    const registry = registryOfTwo();
    const body = JSON.stringify([
      { jsonrpc: '2.0', method: 'weft.test.one', id: 1 },
      { method: 'no-version', id: 2 }, // invalid — missing jsonrpc
    ]);
    const result = await dispatchJsonRpc(body, { ...baseContext(), registry });
    if (result.kind !== 'batch') throw new Error('shape');
    expect(result.responses).toHaveLength(2);
    expect(result.responses[0]?.id).toBe(1);
    expect(result.responses[1]?.id).toBe(2);
    const second = result.responses[1];
    if (!second || !('error' in second)) throw new Error('expected error');
    expect(second.error.code).toBe(-32600);
  });

  it('handles mixed success/error in the same batch', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.ok',
        inputSchema: z.object({}),
        outputSchema: z.object({ tag: z.string() }),
        invoke: async () => ({ tag: 'ok' }),
      }),
    ]);
    const body = JSON.stringify([
      { jsonrpc: '2.0', method: 'weft.test.ok', id: 1 },
      { jsonrpc: '2.0', method: 'weft.unknown', id: 2 },
    ]);
    const result = await dispatchJsonRpc(body, { ...baseContext(), registry });
    if (result.kind !== 'batch') throw new Error('shape');
    const first = result.responses[0];
    const second = result.responses[1];
    if (!first || 'error' in first) throw new Error('expected success on first');
    expect(first.result).toEqual({ tag: 'ok' });
    if (!second || !('error' in second)) throw new Error('expected error on second');
    expect(second.error.code).toBe(-32601);
  });
});
