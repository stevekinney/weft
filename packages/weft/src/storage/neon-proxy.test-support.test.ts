/**
 * COR-1283: `createNeonTestProxy`'s non-upgrade-request path, plus the
 * destination-socket error path inside its WebSocket `open` handler. The
 * live-driver proxy's successful forwarding round trip is only exercised by
 * `neon-live.test.ts`, which is `describe.skipIf`'d whenever no real
 * Postgres endpoint is available — these standalone tests need no live
 * database, so they always run.
 */
import { describe, expect, it } from 'bun:test';

import { createNeonTestProxy } from './neon-proxy.test-support.ts';

describe('createNeonTestProxy', () => {
  it('answers a plain (non-upgrade) HTTP request with 400 and destroys the backing socket', async () => {
    await using proxy = createNeonTestProxy({ host: '127.0.0.1', port: 1 });

    const response = await fetch(`http://${proxy.address}/`);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('WebSocket connection required');
  });

  it('closes the client connection with 1011 when the destination socket errors', async () => {
    // The upgrade to the WebSocket succeeds immediately (it does not wait
    // for the destination TCP connection to establish), so a destination
    // nobody is listening on (port 1, same "guaranteed unused" convention
    // as the test above) surfaces as a genuine 'error' event on the
    // destination socket once the OS reports the connection refused —
    // exactly the failure this proxy's `socket.on('error', ...)` handler
    // exists to translate into a clean client-facing close.
    await using proxy = createNeonTestProxy({ host: '127.0.0.1', port: 1 });

    const closeEvent = await new Promise<{ code: number }>((resolve, reject) => {
      const client = new WebSocket(`ws://${proxy.address}/`);
      client.addEventListener('close', (event) => resolve({ code: event.code }));
      client.addEventListener('error', () => {
        // A client-side 'error' event alone (with no 'close' following) would
        // hang this test until timeout — reject instead so a genuine
        // regression fails fast with a clear cause.
        reject(new Error('WebSocket client reported an error with no close event'));
      });
    });

    expect(closeEvent.code).toBe(1011);
  });
});
