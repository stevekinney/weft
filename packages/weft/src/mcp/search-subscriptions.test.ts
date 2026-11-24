import { describe, expect, it } from 'bun:test';

import { throwingRejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";

import { SearchSubscriptions } from './search-subscriptions.ts';

const SEARCH_URI = 'weft://workflows/search?status=running';

function listenRequest(resourceSubscriptions: unknown): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'mcp-method': 'subscriptions/listen' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'listen:0',
      method: 'subscriptions/listen',
      params: { notifications: { resourceSubscriptions } },
    }),
  });
}

function streamingResponse(): {
  response: Response;
  controller: ReadableStreamDefaultController<Uint8Array>;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
    },
  });
  return { response: new Response(body), controller };
}

describe('SearchSubscriptions', () => {
  it('tracks the search URIs of an open listen stream until the stream ends', async () => {
    const subscriptions = new SearchSubscriptions();
    const { response, controller } = streamingResponse();

    const served = await subscriptions.serve(
      listenRequest([SEARCH_URI, SEARCH_URI, 'weft://workflows/w1/state', 42]),
      1_024,
      async () => response,
    );
    // Only search URIs are tracked; exact workflow URIs reach the SDK's own filter.
    expect(subscriptions.uris()).toEqual([SEARCH_URI]);

    controller.enqueue(new TextEncoder().encode('event: message\n\n'));
    controller.close();
    expect(await served.text()).toBe('event: message\n\n');
    expect(subscriptions.uris()).toEqual([]);
  });

  it('counts overlapping streams and releases on cancellation and stream errors', async () => {
    const subscriptions = new SearchSubscriptions();
    const cancelled = streamingResponse();
    const failing = streamingResponse();

    const first = await subscriptions.serve(listenRequest([SEARCH_URI]), 1_024, async () => {
      return cancelled.response;
    });
    const second = await subscriptions.serve(listenRequest([SEARCH_URI]), 1_024, async () => {
      return failing.response;
    });
    expect(subscriptions.uris()).toEqual([SEARCH_URI]);

    await first.body?.cancel('client went away');
    expect(subscriptions.uris()).toEqual([SEARCH_URI]);

    failing.controller.error(new Error('stream broke'));
    expect(await throwingRejectionOf(second.text())).toThrow('stream broke');
    expect(subscriptions.uris()).toEqual([]);
  });

  it('releases the URIs when serving throws, and ignores other requests', async () => {
    const subscriptions = new SearchSubscriptions();

    expect(
      await throwingRejectionOf(
        subscriptions.serve(listenRequest([SEARCH_URI]), 1_024, async () => {
          throw new Error('handler failed');
        }),
      ),
    ).toThrow('handler failed');
    expect(subscriptions.uris()).toEqual([]);

    const bodyless = await subscriptions.serve(listenRequest([SEARCH_URI]), 1_024, async () => {
      return new Response(null, { status: 202 });
    });
    expect(bodyless.status).toBe(202);
    expect(subscriptions.uris()).toEqual([]);

    for (const request of [
      new Request('http://localhost/mcp', { method: 'GET' }),
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'mcp-method': 'subscriptions/listen' },
        body: '{not json',
      }),
      listenRequest('not-an-array'),
      listenRequest([SEARCH_URI]),
    ]) {
      const served = await subscriptions.serve(request, 16, async () => new Response('ok'));
      expect(await served.text()).toBe('ok');
    }
    expect(subscriptions.uris()).toEqual([]);
  });
});
