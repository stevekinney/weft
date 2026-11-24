/**
 * A fault whose data holds a non-finite number is a programming error. The
 * wire projections must still answer the request (with the masked internal
 * error and the request's own id) instead of throwing past the transport,
 * which over WebSocket left the client waiting forever.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import { defineOperation } from "../embedded/backchannel/src/index.ts";
import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { Engine } from '../core/engine.ts';
import { serve, type WeftServer } from './index.ts';
import { openWebSocket, waitForMessage } from './json-rpc-websocket-client.test-support.ts';

const staleWithNaN = defineOperation({
  name: 'weft.test.stale.nan',
  mcpExposable: false,
  summary: 'Raises StaleRevision with a non-finite revision',
  destructive: false,
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  access: { kind: 'public' },
  producibleFaults: ['StaleRevision'],
  transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async () => {
    throw { code: 'StaleRevision', message: 'moved on', data: { currentRevision: Number.NaN } };
  },
});

let engine: Engine | undefined;
let server: WeftServer | undefined;

afterEach(async () => {
  await server?.stop();
  engine?.[Symbol.dispose]();
  server = undefined;
  engine = undefined;
});

function start(): WeftServer {
  engine = new Engine({ storage: new MemoryStorage() });
  server = serve({
    engine,
    port: 0,
    hostname: '127.0.0.1',
    publicOrigin: 'http://localhost',
    unauthenticatedAccess: 'allow',
    operations: [staleWithNaN],
  });
  return server;
}

describe('a fault with non-finite data', () => {
  it('is answered with the masked internal error and the request id over JSON-RPC HTTP', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const running = start();
      const response = await fetch(`${running.url}/jsonrpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'weft.test.stale.nan', params: {} }),
      });
      const body = (await response.json()) as { id: unknown; error: { data: unknown } };
      expect(body.id).toBe(1);
      expect(body.error.data).toEqual({
        weftCode: 'EngineFailure',
        httpStatus: 500,
        retryable: false,
      });
      expect(
        errors.mock.calls.some((call) => String(call[0]).includes('data.currentRevision')),
      ).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  it('gets a reply with its id over JSON-RPC WebSocket', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const running = start();
      const socket = await openWebSocket(`${running.url.replace('http://', 'ws://')}/jsonrpc`);
      try {
        const reply = waitForMessage(
          socket,
          (parsed) =>
            typeof parsed === 'object' && parsed !== null && 'id' in parsed && parsed.id === 2,
        );
        socket.send(
          JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'weft.test.stale.nan', params: {} }),
        );
        const message = (await reply) as { id: unknown; error: { data: unknown } };
        expect(message.id).toBe(2);
        expect(message.error.data).toEqual({
          weftCode: 'EngineFailure',
          httpStatus: 500,
          retryable: false,
        });
      } finally {
        socket.close();
      }
    } finally {
      errors.mockRestore();
    }
  });
});
