/**
 * `LongPollWorker` against a scripted HTTP server for the paths a healthy server never takes:
 * optional registration fields, refused or malformed registrations, a failing poll, an unreachable
 * server at shutdown, and a result buffer that fills because the server never acknowledges.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { createDeferred, waitForCondition } from "../../test-support/embedded/testing/src/fake-timers.ts";
import { LongPollWorker, type LongPollWorkerOptions } from './long-poll.ts';

const SESSION_PATH = '/api/v1/worker-sessions';
const SESSION_ID = 'session-edge';
const SESSION_TOKEN = 'a'.repeat(64);

type Script = {
  /** Answer for `POST /api/v1/worker-sessions`; defaults to a valid session. */
  register?: (request: Request) => Response | Promise<Response>;
  /** Answer for `GET .../tasks`; defaults to an immediate `204`. */
  poll?: (request: Request) => Response | Promise<Response>;
  /** Answer for `POST .../results`; defaults to an applied acknowledgement. */
  result?: (request: Request) => Response | Promise<Response>;
};

function scriptedServer(script: Script): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === SESSION_PATH && request.method === 'POST') {
        return (
          (await script.register?.(request)) ??
          Response.json({ ok: true, sessionId: SESSION_ID, sessionToken: SESSION_TOKEN })
        );
      }
      if (pathname === `${SESSION_PATH}/${SESSION_ID}` && request.method === 'DELETE') {
        return Response.json({ ok: true });
      }
      if (pathname.endsWith('/tasks')) {
        return (await script.poll?.(request)) ?? new Response(null, { status: 204 });
      }
      if (pathname.endsWith('/results')) {
        return (
          (await script.result?.(request)) ?? Response.json({ ok: true, disposition: 'applied' })
        );
      }
      return new Response('not found', { status: 404 });
    },
  });
}

function createWorker(
  server: ReturnType<typeof Bun.serve>,
  extra: Partial<LongPollWorkerOptions> = {},
): LongPollWorker {
  return new LongPollWorker({
    serverUrl: `http://localhost:${server.port}`,
    deploymentName: 'edge-deployment',
    buildId: 'edge-build',
    workflows: { orders: { name: 'orders', activities: { charge: async (input) => input } } },
    ...extra,
  });
}

describe('LongPollWorker registration', () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let worker: LongPollWorker | undefined;

  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
    await server?.stop(true);
    server = undefined;
  });

  it('puts the optional deployment details it was given into the registered manifest', async () => {
    const registered = createDeferred<Record<string, any>>();
    server = scriptedServer({
      register: async (request) => {
        registered.resolve((await request.json()) as Record<string, any>);
        return Response.json({ ok: true, sessionId: SESSION_ID, sessionToken: SESSION_TOKEN });
      },
    });
    worker = createWorker(server, {
      artifactDigest: 'sha256:edge-artifact',
      runtimeName: 'edge-runtime',
      runtimeVersion: '9.9.9',
      capabilities: { streaming: true },
    });

    worker.start();
    const body = await registered.promise;

    expect(body['manifest'].deployment.artifactDigest).toBe('sha256:edge-artifact');
    expect(body['manifest'].runtime.name).toBe('edge-runtime');
    expect(body['manifest'].runtime.version).toBe('9.9.9');
    expect(body['manifest'].capabilities).toEqual({ streaming: true });
  });

  it.each([
    ['refuses the registration', () => new Response('no', { status: 503 })],
    [
      'answers without a session id',
      () => Response.json({ ok: true, sessionToken: SESSION_TOKEN }),
    ],
    ['answers without a session token', () => Response.json({ ok: true, sessionId: SESSION_ID })],
    [
      'answers with an empty session token',
      () => Response.json({ sessionId: SESSION_ID, sessionToken: '' }),
    ],
    ['answers with a body that is not JSON', () => new Response('not json', { status: 200 })],
  ])('stays not ready and registers again when the server %s', async (_label, answer) => {
    // The injected pause skips the one-second retry wait; a second attempt proves the first answer
    // was fully handled.
    const pauses: number[] = [];
    let attempts = 0;
    server = scriptedServer({
      register: () => {
        attempts += 1;
        return answer();
      },
    });
    worker = createWorker(server, {
      sleep: async (milliseconds) => {
        pauses.push(milliseconds);
      },
    });

    try {
      worker.start();
      await waitForCondition(() => attempts >= 2, { label: 'second registration attempt' });

      expect(worker.ready).toBe(false);
      expect(pauses).toContain(1000);
    } finally {
      await worker.stop();
    }
  });
});

describe('LongPollWorker polling and shutdown', () => {
  let server: ReturnType<typeof Bun.serve> | undefined;

  afterEach(async () => {
    await server?.stop(true);
    server = undefined;
  });

  it('backs off after a failing poll and then polls again', async () => {
    const pauses: number[] = [];
    let polls = 0;
    server = scriptedServer({
      poll: () => {
        polls += 1;
        return new Response('boom', { status: 500 });
      },
    });
    const worker = createWorker(server, {
      sleep: async (milliseconds) => {
        pauses.push(milliseconds);
      },
    });

    try {
      worker.start();
      await waitForCondition(() => polls >= 3, { label: 'repeated polls' });

      expect(pauses).toContain(1000);
    } finally {
      await worker.stop();
    }
  });

  it('still stops cleanly when the server is gone before the session can be released', async () => {
    const registered = createDeferred();
    server = scriptedServer({
      register: () => {
        registered.resolve();
        return Response.json({ ok: true, sessionId: SESSION_ID, sessionToken: SESSION_TOKEN });
      },
    });
    const worker = createWorker(server);
    worker.start();
    await registered.promise;
    await waitForCondition(() => worker.ready, { label: 'session registered' });
    await server.stop(true);
    server = undefined;

    expect(await worker.stop()).toEqual({ unacknowledgedResults: 0 });
  });

  it('declines new tasks, and warns once, while the unacknowledged result backlog is full', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    let handedOut = 0;
    const BACKLOG = 1_000;
    server = scriptedServer({
      poll: () => {
        if (handedOut >= BACKLOG) return new Response(null, { status: 204 });
        handedOut += 1;
        return Response.json({
          operationId: `op-${handedOut}`,
          workerId: SESSION_ID,
          activityName: 'orders.charge',
          input: handedOut,
          attemptToken: `attempt-${handedOut}`,
        });
      },
      // Never acknowledge, so every result stays buffered.
      result: () => new Response('later', { status: 503 }),
    });
    const worker = createWorker(server, { resultRetryBaseDelayMs: 600_000 });

    try {
      worker.start();
      await waitForCondition(
        () =>
          warnSpy.mock.calls.some(([message]) => String(message).includes('result buffer full')),
        { label: 'backlog warning' },
      );

      expect(worker.unacknowledgedResultCount).toBe(BACKLOG);
      const warnings = warnSpy.mock.calls.filter(([message]) =>
        String(message).includes('result buffer full'),
      );
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0]?.[0])).toContain('(1000)');
    } finally {
      await worker.stop();
      warnSpy.mockRestore();
    }
  });
});
