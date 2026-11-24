/**
 * COR-1670 part 2: what a restarted caller needs from the peer client. `messageId` makes a repeated
 * send the peer's own idempotent retry, and `attach` follows a task the peer already holds without
 * sending anything.
 */
import { describe, expect, test } from 'bun:test';

import { rejectionOf, throwingRejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { A2APeerError } from './peer-client-types.ts';
import { createScriptedPeer, type ScriptedPeerOptions } from './peer-client.test-support.ts';
import { createA2APeerClient } from './peer-client.ts';

// load-proof: the client's injected sleep seam replaces its real backoff delay and the client under test awaits it, so it is an input to the code, not a test-side wait for state
const immediate = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const nonStreaming: ScriptedPeerOptions['card'] = (card) => {
  if (card.capabilities !== undefined) card.capabilities.streaming = false;
  return card;
};

function clientFor(peer: ReturnType<typeof createScriptedPeer>) {
  return createA2APeerClient({
    url: peer.url,
    fetch: peer.fetch,
    sleep: immediate,
    retryBaseDelayMs: 1,
    pollIntervalMs: 1,
    attempts: 2,
  });
}

type Client = ReturnType<typeof createA2APeerClient>;

/** Sends `request` and waits for the task to stop. */
async function sendAndWait(client: Client, request: Parameters<Client['send']>[0]) {
  const task = await client.send(request);
  return task.result();
}

/** Attaches to `request.taskId` and waits for the task to stop. */
async function attachAndWait(client: Client, request: Parameters<Client['attach']>[0]) {
  const task = await client.attach(request);
  return task.result();
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof A2APeerError) return error.code;
    throw error;
  }
  throw new Error('expected the promise to reject');
}

/** The `messageId` of every opening message the peer received. */
function recordMessageIds(): {
  ids: string[];
  intercept: NonNullable<ScriptedPeerOptions['intercept']>;
} {
  const ids: string[] = [];
  return {
    ids,
    async intercept(request, method) {
      if (method === 'SendMessage' || method === 'SendStreamingMessage') {
        const body = (await request.clone().json()) as {
          params?: { message?: { messageId?: string } };
        };
        ids.push(body.params?.message?.messageId ?? '');
      }
      return undefined;
    },
  };
}

describe('a send with a messageId', () => {
  for (const [label, card] of [
    ['streaming', undefined],
    ['polling', nonStreaming],
  ] as const) {
    test(`puts that identifier on the wire (${label})`, async () => {
      const recorded = recordMessageIds();
      const peer = createScriptedPeer({ intercept: recorded.intercept, card });
      const client = clientFor(peer);

      await sendAndWait(client, { text: 'hi', messageId: 'peer-call:abc' });
      await sendAndWait(client, { text: 'hi', messageId: 'peer-call:abc' });
      await sendAndWait(client, { text: 'hi' });

      expect(recorded.ids.slice(0, 2)).toEqual(['peer-call:abc', 'peer-call:abc']);
      expect(recorded.ids[2]).not.toBe('peer-call:abc');
      expect(recorded.ids[2]).not.toBe('');
    });
  }

  test('keeps it across a retried request', async () => {
    const recorded = recordMessageIds();
    let failed = false;
    const peer = createScriptedPeer({
      card: nonStreaming,
      async intercept(request, method, real) {
        await recorded.intercept(request, method, real);
        if (method === 'SendMessage' && !failed) {
          failed = true;
          return new Response('unavailable', { status: 503 });
        }
        return undefined;
      },
    });

    await sendAndWait(clientFor(peer), { text: 'hi', messageId: 'stable' });

    expect(recorded.ids).toEqual(['stable', 'stable']);
  });

  test('is refused when empty or not a string, before anything is sent', async () => {
    const peer = createScriptedPeer();
    const client = clientFor(peer);

    expect(await throwingRejectionOf(client.send({ text: 'hi', messageId: '' }))).toThrow(
      TypeError,
    );
    expect(
      await throwingRejectionOf(client.send({ text: 'hi', messageId: 7 as unknown as string })),
    ).toThrow(TypeError);
    expect(peer.methods().filter((method) => method.startsWith('Send'))).toEqual([]);
  });

  test('is refused without text, before anything is sent', async () => {
    const peer = createScriptedPeer();

    const refusal = await throwingRejectionOf(
      clientFor(peer).send({ text: undefined as unknown as string }),
    );

    expect(refusal).toThrow(TypeError);
    expect(peer.methods()).toEqual([]);
  });
});

describe('attach', () => {
  for (const [label, card] of [
    ['streaming', undefined],
    ['polling', nonStreaming],
  ] as const) {
    test(`returns a task that already finished, with no message sent (${label})`, async () => {
      const peer = createScriptedPeer({ card });
      const sent = await sendAndWait(clientFor(peer), { text: 'hi' });
      const before = peer.methods().length;

      // A new client: what a restarted process has.
      const task = await clientFor(peer).attach({ taskId: sent.taskId, contextId: sent.contextId });
      const outcome = await task.result();

      expect(outcome.state).toBe('completed');
      expect(outcome.taskId).toBe(sent.taskId);
      expect(outcome.contextId).toBe(sent.contextId);
      expect(outcome.provenance.taskId).toBe(sent.taskId);
      expect(outcome.untrusted).toBe(true);
      expect(peer.methods().slice(before)).toEqual(['card', 'GetTask']);
    });

    test(`follows a task still working until it finishes (${label})`, async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const peer = createScriptedPeer({ card, gate });
      const first = await clientFor(peer).send({ text: 'slow' });
      const before = peer.methods().length;

      const task = await clientFor(peer).attach({ taskId: first.taskId });
      release();
      const outcome = await task.result();

      expect(outcome.state).toBe('completed');
      expect(outcome.message).toBe('late');
      expect(peer.methods().slice(before)).not.toContain('SendMessage');
      expect(peer.methods().slice(before)).not.toContain('SendStreamingMessage');
    });
  }

  test('reports a task waiting for input as stopped', async () => {
    const peer = createScriptedPeer();
    const first = await sendAndWait(clientFor(peer), { text: 'ask' });

    const outcome = await attachAndWait(clientFor(peer), { taskId: first.taskId });

    expect(outcome.state).toBe('input-required');
    expect(outcome.message).toBe('first question');
  });

  test('fails with task-not-found when the peer does not know the task', async () => {
    const peer = createScriptedPeer();

    expect(await codeOf(clientFor(peer).attach({ taskId: 'gone' }))).toBe('task-not-found');
  });

  test('passes the task to onUpdate', async () => {
    const peer = createScriptedPeer();
    const first = await sendAndWait(clientFor(peer), { text: 'hi' });
    const states: string[] = [];

    await clientFor(peer).attach({
      taskId: first.taskId,
      onUpdate: (update) => states.push(`${update.state}:${update.taskId}`),
    });

    expect(states).toEqual([`completed:${first.taskId}`]);
  });

  test('cancels the remote task when the signal aborts after attaching', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const peer = createScriptedPeer({ gate });
    const first = await clientFor(peer).send({ text: 'slow' });
    const controller = new AbortController();

    const task = await clientFor(peer).attach({ taskId: first.taskId, signal: controller.signal });
    controller.abort('stop');
    const outcome = await task.result();
    release();

    expect(outcome.state).toBe('canceled');
    expect(peer.methods()).toContain('CancelTask');
  });

  test('sends nothing when the signal has already aborted', async () => {
    const peer = createScriptedPeer();
    const controller = new AbortController();
    controller.abort();

    const reason = await rejectionOf(
      clientFor(peer).attach({ taskId: 'any', signal: controller.signal }),
    );
    expect(reason).toBeDefined();
    expect(peer.methods()).not.toContain('GetTask');
  });

  test('is refused without a task identifier', async () => {
    const peer = createScriptedPeer();

    expect(await throwingRejectionOf(clientFor(peer).attach({ taskId: '' }))).toThrow(TypeError);
    expect(peer.methods()).not.toContain('GetTask');
  });

  test('fails with timeout when the opening GetTask never completes its body', async () => {
    const peer = createScriptedPeer({
      intercept(request, method) {
        if (method !== 'GetTask') return undefined;
        return new Response(
          new ReadableStream({
            start(controller) {
              request.signal.addEventListener('abort', () =>
                controller.error(request.signal.reason),
              );
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const client = createA2APeerClient({
      url: peer.url,
      fetch: peer.fetch,
      sleep: immediate,
      attempts: 1,
      taskTimeoutMs: 30,
    });

    expect(await codeOf(client.attach({ taskId: 'stalled' }))).toBe('timeout');
  });
});
