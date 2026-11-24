import { afterEach, describe, expect, it } from 'bun:test';

import { throwingRejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";

import type { WeftServer } from './index.ts';
import { collectWebSocketDeliveredEnvelopes } from './json-rpc-websocket-client.test-support.ts';

type FakeServer = ReturnType<typeof Bun.serve>;

const servers: FakeServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

/** A fake `/jsonrpc` endpoint whose per-frame behaviour the test scripts. */
function startFakeEndpoint(
  onMessage: (socket: Bun.ServerWebSocket<unknown>, text: string) => void,
) {
  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      return bunServer.upgrade(request)
        ? undefined
        : new Response('upgrade required', { status: 426 });
    },
    websocket: {
      message(socket, message) {
        onMessage(socket, String(message));
      },
    },
  });
  servers.push(server);
  return { url: `http://localhost:${server.port}` } as WeftServer;
}

describe('collectWebSocketDeliveredEnvelopes', () => {
  it('skips frames that are not JSON or not objects, then collects the delivered envelopes', async () => {
    const envelope = { kind: 'workflow:started', sequence: 0 };
    const server = startFakeEndpoint((socket, text) => {
      const request = JSON.parse(text) as { id: string };
      socket.send('this frame is not JSON');
      socket.send('"a bare string"');
      socket.send('null');
      socket.send(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { subscriptionId: 'sub-1' } }),
      );
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'weft.events.deliver',
          params: { subscriptionId: 'sub-1', envelope },
        }),
      );
    });

    const delivered = await collectWebSocketDeliveredEnvelopes(server, 'wf-1', 1, 'unused-key');

    expect(delivered).toEqual([envelope as never]);
  });

  it('resolves with nothing once the subscription is confirmed when no envelope is expected', async () => {
    const server = startFakeEndpoint((socket, text) => {
      const request = JSON.parse(text) as { id: string };
      socket.send(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { subscriptionId: 'sub-1' } }),
      );
    });

    expect(await collectWebSocketDeliveredEnvelopes(server, 'wf-1', 0, 'unused-key')).toEqual([]);
  });

  it('ignores deliveries that are not for its subscription or are malformed', async () => {
    const envelope = { kind: 'workflow:started', sequence: 0 };
    const deliver = (params: unknown): string =>
      JSON.stringify({ jsonrpc: '2.0', method: 'weft.events.deliver', params });
    const server = startFakeEndpoint((socket, text) => {
      const request = JSON.parse(text) as { id: string };
      // Before the subscription is confirmed, a delivery has no subscription to belong to.
      socket.send(deliver({ subscriptionId: 'sub-1', envelope: { early: true } }));
      socket.send(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { subscriptionId: 'sub-1' } }),
      );
      socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'weft.something.else', params: {} }));
      socket.send(deliver('not an object'));
      socket.send(deliver({ subscriptionId: 'sub-2', envelope: { other: true } }));
      socket.send(deliver({ subscriptionId: 'sub-1', envelope: 'not an object' }));
      socket.send(deliver({ subscriptionId: 'sub-1', envelope }));
    });

    const delivered = await collectWebSocketDeliveredEnvelopes(server, 'wf-1', 1, 'unused-key');

    expect(delivered).toEqual([envelope as never]);
  });

  it('rejects once the wait budget passes without enough envelopes', async () => {
    const server = startFakeEndpoint(() => {});

    expect(
      await throwingRejectionOf(
        collectWebSocketDeliveredEnvelopes(server, 'wf-1', 1, 'unused-key', 'timeout', 50),
      ),
    ).toThrow('collectWebSocketDeliveredEnvelopes timed out');
  });
});
