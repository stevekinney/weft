import { afterEach, describe, expect, it } from 'bun:test';

import { jsonRpcEndpoint, sendJsonRpcRequest } from './json-rpc-client.ts';

type StubServer = { url: string; stop: () => void };

let stub: StubServer | undefined;

afterEach(() => {
  stub?.stop();
  stub = undefined;
});

function serveRaw(payload: Record<string, unknown>): StubServer {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json(payload),
  });
  return { url: server.url.toString(), stop: () => void server.stop(true) };
}

describe('sendJsonRpcRequest', () => {
  it('builds the /jsonrpc endpoint preserving a base path', () => {
    expect(jsonRpcEndpoint(new URL('http://host/base')).toString()).toBe(
      'http://host/base/jsonrpc',
    );
  });

  it('treats a success envelope with no result field as a void success', async () => {
    // Void operations (e.g. weft.workflows.cancel) serialize to an envelope
    // where `JSON.stringify` drops the `undefined` result key entirely.
    stub = serveRaw({ jsonrpc: '2.0', id: 'x' });
    const result = await sendJsonRpcRequest({ server: stub.url }, 'weft.workflows.cancel', {}, 'x');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.result).toBeUndefined();
  });

  it('surfaces a JSON-RPC error envelope', async () => {
    stub = serveRaw({
      jsonrpc: '2.0',
      error: { code: -32601, message: 'Method not found' },
      id: 'x',
    });
    const result = await sendJsonRpcRequest({ server: stub.url }, 'weft.unknown', {}, 'x');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error.code).toBe(-32601);
  });

  it('rejects an unrelated JSON object as an invalid response (not a valid JSON-RPC envelope)', async () => {
    // Objects that merely have a `jsonrpc` field but no `id` are not valid success envelopes.
    stub = serveRaw({ jsonrpc: '2.0', status: 'ok' });
    await expect(
      sendJsonRpcRequest({ server: stub.url }, 'weft.workflows.cancel', {}, 'x'),
    ).rejects.toThrow('Invalid JSON-RPC response');
  });
});
