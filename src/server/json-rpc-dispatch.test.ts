import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
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
import { makeOperation as makeOp } from './json-rpc-operation.test-support.ts';
import { createOperationRegistry } from './operation-catalog.ts';
import { anonymousPrincipal } from './principal.ts';

const fakeEngine = {} as unknown;

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

  it('rejects long-lived operations before invoking them on the request-response path', async () => {
    let invoked = false;
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.subscribe',
        kind: 'subscription',
        inputSchema: z.object({}),
        outputSchema: z.object({ subscriptionId: z.string() }),
        eventSchema: z.object({ value: z.string() }),
        invoke: async () => {
          invoked = true;
          return {
            envelope: { subscriptionId: 'sub_test' },
            iterable: (async function* events() {
              yield { value: 'leaked' };
            })(),
            close: async () => {},
          };
        },
      }),
    ]);
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'weft.test.subscribe', id: 1 });
    const result = await dispatchJsonRpc(body, { ...baseContext(), registry });

    if (result.kind !== 'single') throw new Error('shape');
    if (!('error' in result.response)) throw new Error('expected error');
    const errorData = result.response.error.data;
    if (typeof errorData !== 'object' || errorData === null || !('weftCode' in errorData)) {
      throw new Error('expected Weft error data');
    }
    expect(errorData.weftCode).toBe('Unprocessable');
    expect(invoked).toBe(false);
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

  it('Batch requests are supported. The shared dispatcher validates and executes JSON-RPC batches without inventing transport-specific behavior.', async () => {
    const registry = registryOfTwo();
    const body = JSON.stringify([
      { jsonrpc: '2.0', method: 'weft.test.one', id: 1 },
      { jsonrpc: '2.0', method: 'weft.test.two', id: 2 },
    ]);

    const result = await dispatchJsonRpc(body, { ...baseContext(), registry });

    expect(result.kind).toBe('batch');
    if (result.kind !== 'batch') throw new Error(`expected batch, got ${result.kind}`);
    expect(result.responses).toHaveLength(2);
  });

  it('dispatches batch items SEQUENTIALLY (side-effect order matches request order)', async () => {
    // Track 8 decision 13 — batches are not concurrent. Use staggered
    // delays (first-slowest) so that a parallel `Promise.all`-style
    // implementation would produce the reversed order ['third',
    // 'second', 'first']. Only a sequential `for await` loop blocks
    // long enough for the delays to be observed in request order.
    const callOrder: string[] = [];
    const delays: Record<string, number> = { first: 30, second: 20, third: 10 };
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.seq',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({}),
        invoke: async ({ input }) => {
          await sleepForTesting(delays[input.id] ?? 0);
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

  it('returns kind=batch with all error responses when every item is invalid', async () => {
    // All items are invalid-request (missing jsonrpc). The dispatcher
    // must return `batch` (not `notification-batch`) because every
    // error response IS a response — notifications have no id AND
    // the item is a successful parse. Invalid-request items always
    // produce an error response, echoing the requestor's id (or
    // `null` if the id was invalid / absent).
    const registry = createOperationRegistry([]);
    const body = JSON.stringify([
      { method: 'no-version', id: 1 },
      { method: 'also-no-version', id: 2 },
    ]);
    const result = await dispatchJsonRpc(body, { ...baseContext(), registry });
    if (result.kind !== 'batch') throw new Error(`expected batch, got ${result.kind}`);
    expect(result.responses).toHaveLength(2);
    const first = result.responses[0];
    const second = result.responses[1];
    if (!first || !('error' in first)) throw new Error('expected error on first');
    if (!second || !('error' in second)) throw new Error('expected error on second');
    expect(first.error.code).toBe(-32600);
    expect(second.error.code).toBe(-32600);
    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
  });

  it('includes id:null error responses for invalid items with no parseable id (not dropped like notifications)', async () => {
    // Distinguishes an invalid-item-with-null-id (which IS in the
    // response array) from a valid notification (which is DROPPED).
    // Both can produce responses lacking a correlatable id, but only
    // the invalid item appears on the wire.
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
      { method: 'no-version' }, // invalid + no id
    ]);
    const result = await dispatchJsonRpc(body, { ...baseContext(), registry });
    if (result.kind !== 'batch') throw new Error(`expected batch, got ${result.kind}`);
    expect(result.responses).toHaveLength(2);
    const second = result.responses[1];
    if (!second || !('error' in second)) throw new Error('expected error on second');
    expect(second.id).toBeNull();
    expect(second.error.code).toBe(-32600);
  });

  it('classifies invoke throws as EngineFailure (no uncaught exception escapes)', async () => {
    // `executeOperation` catches all invoke exceptions via
    // `classifyEngineError`. The dispatcher has no try/catch of its
    // own — if executeOperation ever regresses and lets a throw
    // escape, this test would fail with an uncaught rejection rather
    // than a clean error response.
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.panic',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => {
          throw new Error('unexpected internal detail');
        },
      }),
    ]);
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'weft.test.panic', id: 1 });
    const result = await dispatchJsonRpc(body, { ...baseContext(), registry });
    if (result.kind !== 'single') throw new Error('shape');
    if (!('error' in result.response)) throw new Error('expected error response');
    expect(result.response.error.code).toBe(-32099);
    expect(result.response.id).toBe(1);
  });

  it('rejects a batch that exceeds MAX_JSON_RPC_BATCH_ITEMS', async () => {
    const registry = createOperationRegistry([]);
    const items = Array.from({ length: 101 }, (_, index) => ({
      jsonrpc: '2.0' as const,
      method: 'weft.test.x',
      id: index,
    }));
    const result = await dispatchJsonRpc(JSON.stringify(items), { ...baseContext(), registry });
    if (result.kind !== 'single') throw new Error('shape');
    if (!('error' in result.response)) throw new Error('expected error');
    expect(result.response.error.code).toBe(-32600);
    expect(result.response.error.message).toMatch(/batch size/i);
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
