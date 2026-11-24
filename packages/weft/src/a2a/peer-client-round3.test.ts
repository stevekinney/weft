import { describe, expect, test } from 'bun:test';

import { A2APeerError } from './peer-client-types.ts';
import { createScriptedPeer, type ScriptedPeerOptions } from './peer-client.test-support.ts';
import { createA2APeerClient } from './peer-client.ts';

// load-proof: the client's injected sleep seam replaces its real backoff delay and the client under test awaits it, so it is an input to the code, not a test-side wait for state
const immediate = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function connect(
  peerOptions: ScriptedPeerOptions = {},
  clientOptions: Partial<Parameters<typeof createA2APeerClient>[0]> = {},
) {
  const peer = createScriptedPeer(peerOptions);
  const client = createA2APeerClient({
    url: peer.url,
    fetch: peer.fetch,
    sleep: immediate,
    retryBaseDelayMs: 1,
    ...clientOptions,
  });
  return { peer, client };
}

const polling: ScriptedPeerOptions['card'] = (card) => {
  if (card.capabilities !== undefined) card.capabilities.streaming = false;
  return card;
};

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof A2APeerError) return error.code;
    throw error;
  }
  throw new Error('expected the promise to reject');
}

describe('A2A peer client review round 3', () => {
  test('reads the card under a base URL that has a path', async () => {
    const peer = createScriptedPeer();
    const seen: string[] = [];
    const cardPath = '/a2a/agent-name/.well-known/agent-card.json';
    const client = createA2APeerClient({
      url: 'https://peer.example/a2a/agent-name',
      allowedInterfaceOrigins: [new URL(peer.url).origin],
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method !== 'GET') return peer.fetch(request);
        seen.push(new URL(request.url).pathname);
        if (new URL(request.url).pathname !== cardPath) return new Response('', { status: 404 });
        return peer.fetch(`${new URL(peer.url).origin}/.well-known/agent-card.json`);
      }) as typeof fetch,
      sleep: immediate,
      attempts: 1,
    });
    const card = await client.card();
    expect(seen).toEqual([cardPath]);
    expect(card.cardUrl).toBe(`https://peer.example${cardPath}`);
  });

  test('a stream that never emits its first event fails with a timeout', async () => {
    const { client } = connect(
      {
        intercept: (_request, method) =>
          method === 'SendStreamingMessage'
            ? new Response(new ReadableStream({ start() {} }), {
                headers: { 'content-type': 'text/event-stream' },
              })
            : undefined,
      },
      { taskTimeoutMs: 30, attempts: 1 },
    );
    expect(await codeOf(client.send({ text: 'hi' }))).toBe('timeout');
  });

  test('send uses the request as it was when send was called', async () => {
    const bodies: string[] = [];
    const { client } = connect({
      intercept: async (request, method) => {
        if (method === 'card') await new Promise((resolve) => setTimeout(resolve, 20));
        else bodies.push(await request.clone().text());
        return undefined;
      },
    });
    const request = { text: 'original' };
    const pending = client.send(request);
    request.text = 'changed';
    const task = await pending;
    await task.result();
    expect(bodies.join('')).toContain('original');
    expect(bodies.join('')).not.toContain('changed');
  });

  test('card() hands out a frozen copy that cannot change later requests', async () => {
    const { client } = connect();
    const card = await client.card();
    expect(Object.isFrozen(card)).toBe(true);
    expect(Object.isFrozen(card.activeExtensions)).toBe(true);
    expect(await client.card()).not.toBe(card);
    expect(() => ((card as { streaming: boolean }).streaming = false)).toThrow();
    const again = await client.card();
    expect(again.streaming).toBe(true);
  });

  test('a failure while following the task drops the cached card', async () => {
    let cardReads = 0;
    const { client } = connect(
      {
        card: polling,
        intercept: async (request, method) => {
          if (method === 'card') cardReads += 1;
          if (method !== 'GetTask') return undefined;
          const body = (await request.clone().json()) as { id: number };
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32009, message: 'Version not supported' },
          });
        },
      },
      { attempts: 1 },
    );
    const task = await client.send({ text: 'slow' });
    expect(await codeOf(task.result())).toBe('version-not-supported');
    const before = cardReads;
    await client.send({ text: 'again' }).catch(() => undefined);
    expect(cardReads).toBeGreaterThan(before);
  });

  test('the first poll waits no longer than retryMaxDelayMs', async () => {
    const sleeps: number[] = [];
    const { client } = connect(
      { card: polling },
      {
        pollIntervalMs: 10_000,
        retryMaxDelayMs: 50,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    const task = await client.send({ text: 'hi' });
    await task.result();
    expect(Math.max(...sleeps, 0)).toBeLessThanOrEqual(50);
  });
});
