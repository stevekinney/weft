import { describe, expect, test } from 'bun:test';

import { type Artifact } from '@a2a-js/sdk';

import { A2APeerError } from './peer-client-types.ts';
import { createScriptedPeer, type ScriptedPeerOptions } from './peer-client.test-support.ts';
import { createA2APeerClient } from './peer-client.ts';
import { classifyPeerError } from './peer-errors.ts';
import { foldArtifactUpdate, mapArtifact } from './peer-parts.ts';
import { retryRequest } from './peer-retry.ts';
import { PeerTaskTracker } from './peer-task-tracker.ts';

const polling: ScriptedPeerOptions['card'] = (card) => {
  if (card.capabilities !== undefined) card.capabilities.streaming = false;
  return card;
};

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
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

function artifact(parts: Artifact['parts'], artifactId = 'a'): Artifact {
  return { artifactId, name: '', description: '', parts, metadata: undefined, extensions: [] };
}

const dataPart = (value: unknown): Artifact['parts'][number] => ({
  content: { $case: 'data', value },
  metadata: undefined,
  filename: '',
  mediaType: '',
});

describe('peer client edges', () => {
  test('refuses a base URL that is not absolute', () => {
    expect(() => createA2APeerClient({ url: 'not a url' })).toThrow(TypeError);
  });

  test('classifies an unrecognized failure as a protocol error', () => {
    expect(classifyPeerError(new Error('odd')).code).toBe('protocol');
  });

  test('reports an unreadable card as card-unavailable', async () => {
    const peer = createScriptedPeer({
      intercept: (_request, method) =>
        method === 'card' ? new Response('nope', { status: 404 }) : undefined,
    });
    const client = createA2APeerClient({ url: peer.url, fetch: peer.fetch, attempts: 1 });
    expect(await codeOf(client.card())).toBe('card-unavailable');
  });

  test('refuses a host the egress policy blocks, and retries one it cannot resolve', async () => {
    const peer = createScriptedPeer();
    const blocked = createA2APeerClient({
      url: peer.url,
      fetch: peer.fetch,
      attempts: 1,
      egressPolicy: { check: async () => ({ status: 'blocked', reason: 'private range' }) },
    });
    expect(await codeOf(blocked.card())).toBe('egress-denied');
    const unresolved = createA2APeerClient({
      url: peer.url,
      fetch: peer.fetch,
      attempts: 1,
      egressPolicy: { check: async () => ({ status: 'unresolved', reason: 'dns' }) },
    });
    expect(await codeOf(unresolved.card())).toBe('unreachable');
  });

  test('an egress policy that allows the host lets the card through', async () => {
    const peer = createScriptedPeer();
    const client = createA2APeerClient({
      url: peer.url,
      fetch: peer.fetch,
      attempts: 1,
      egressPolicy: { check: async (url) => ({ status: 'allowed', url: new URL(url) }) },
    });
    const card = await client.card();
    expect(card.name).toBe('Echo Agent');
  });

  test('a polling peer works on the default timer, and an abort ends its wait', async () => {
    const peer = createScriptedPeer({ card: polling });
    const client = createA2APeerClient({
      url: peer.url,
      fetch: peer.fetch,
      pollIntervalMs: 1,
      retryBaseDelayMs: 1,
    });
    const task = await client.send({ text: 'hi' });
    expect(task.taskId).not.toBe('');
    expect(task.contextId).not.toBe('');
    expect(task.provenance.taskId).toBe(task.taskId);
    await task.result();

    const hanging = createScriptedPeer({ card: polling, gate: new Promise<void>(() => {}) });
    const patient = createA2APeerClient({
      url: hanging.url,
      fetch: hanging.fetch,
      pollIntervalMs: 60_000,
      retryMaxDelayMs: 60_000,
    });
    const controller = new AbortController();
    const waiting = await patient.send({ text: 'slow', signal: controller.signal });
    const settled = waiting.result();
    controller.abort('stop');
    const outcome = await settled;
    expect(outcome.state).toBe('canceled');
    // A signal that is already aborted ends a wait before it starts.
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await rejectionOf(patient.send({ text: 'never', signal: aborted.signal })),
    ).toBeDefined();
  });

  test('the scripted peer logs a redirect only when fetch is told to follow it', async () => {
    const peer = createScriptedPeer({
      intercept: () =>
        new Response(null, { status: 307, headers: { location: 'https://other.example/x' } }),
    });
    await peer.fetch(
      new Request(`${peer.url}/.well-known/agent-card.json`, { redirect: 'follow' }),
    );
    expect(peer.methods()).toContain('redirected');
  });

  test('retryRequest makes the last attempt final and classifies its failure', async () => {
    let calls = 0;
    const policy = {
      attempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 1,
      sleep: async () => {},
      classify: classifyPeerError,
    };
    const failure = await rejectionOf(
      retryRequest(policy, async () => {
        calls += 1;
        throw new TypeError('network');
      }),
    );
    expect(failure).toMatchObject({ code: 'unreachable' });
    expect(calls).toBe(2);
  });
});

describe('a bare reply to a continuation', () => {
  test('stops the task at once instead of waiting for a status change', () => {
    const tracker = new PeerTaskTracker(
      { agentName: 'p', agentVersion: '1', cardUrl: 'u' },
      { text: '', taskId: 't' },
      1000,
      true,
    );
    tracker.apply({
      payload: {
        $case: 'message',
        value: {
          messageId: 'm',
          contextId: 'c',
          taskId: 't',
          role: 2,
          parts: [
            {
              content: { $case: 'text', value: 'done' },
              metadata: undefined,
              filename: '',
              mediaType: '',
            },
          ],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        },
      },
    });
    expect(tracker.stopped()).toBe(true);
    expect(tracker.outcome()).toMatchObject({ state: 'completed', message: 'done' });
  });
});

describe('peer artifact content', () => {
  test('keeps a data part that fits, drops one that does not, and survives one that cannot be sized', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const mapped = mapArtifact(
      artifact([dataPart({ a: 1 }), dataPart({ text: 'x'.repeat(500) }), dataPart(circular)]),
      100,
    );
    expect(mapped.parts[0]).toMatchObject({ kind: 'data' });
    expect(mapped.parts[1]).toMatchObject({ kind: 'omitted', reason: 'too-large' });
    expect(mapped.parts[2]).toMatchObject({ kind: 'omitted', reason: 'too-large' });
  });

  test('charges a data part already kept against an appended update', () => {
    const first = mapArtifact(artifact([dataPart({ a: 1 })]), 20);
    const folded = foldArtifactUpdate(
      [first],
      artifact([dataPart({ b: 'x'.repeat(50) })]),
      true,
      20,
      4,
    );
    expect(folded[0]?.parts[1]).toMatchObject({ kind: 'omitted' });
  });

  test('refuses an artifact identifier past the cap', () => {
    expect(() => mapArtifact(artifact([], 'i'.repeat(5000)), 100)).toThrow(A2APeerError);
  });
});
