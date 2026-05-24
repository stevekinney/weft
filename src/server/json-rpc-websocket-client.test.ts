/**
 * Unit tests for the WebSocket transport test-support helpers. These cover
 * the branches the integration suites cannot reach against a real server —
 * notably `waitForMessage` ignoring a frame that is not valid JSON.
 */

import { describe, expect, it } from 'bun:test';

import { waitForMessage } from './json-rpc-websocket-client.test-support.ts';

/**
 * Minimal stand-in that satisfies the `WebSocket` shape `waitForMessage`
 * touches: `addEventListener`/`removeEventListener` for the `message` event.
 * A real server only ever emits valid JSON, so the non-JSON path needs a
 * fake that can dispatch arbitrary frame data.
 */
function fakeWebSocket(): { ws: WebSocket; emit(data: string): void } {
  const target = new EventTarget();
  const ws = {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      target.addEventListener(type, listener),
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      target.removeEventListener(type, listener),
  } as unknown as WebSocket;
  return {
    ws,
    emit(data: string) {
      target.dispatchEvent(new MessageEvent('message', { data }));
    },
  };
}

describe('waitForMessage', () => {
  it('ignores frames that are not valid JSON and resolves on a later matching frame', async () => {
    const { ws, emit } = fakeWebSocket();

    const pending = waitForMessage(ws, (parsed: any) => parsed?.id === 7);

    // A non-JSON frame must be silently skipped, not throw or resolve.
    emit('this is not json');
    // A valid frame that fails the predicate must also be skipped.
    emit(JSON.stringify({ id: 1 }));
    // The matching frame resolves the promise.
    emit(JSON.stringify({ id: 7, ok: true }));

    const resolved = (await pending) as any;
    expect(resolved.id).toBe(7);
    expect(resolved.ok).toBe(true);
  });

  it('rejects after the timeout when no matching frame arrives', async () => {
    const { ws } = fakeWebSocket();

    await expect(waitForMessage(ws, () => false, 10)).rejects.toThrow(/timed out/i);
  });
});
