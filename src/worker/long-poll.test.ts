import { afterEach, describe, expect, it } from 'bun:test';
import { LongPollWorker } from './long-poll.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POLL_PATH_RE = /^\/v1\/tasks\/([\w-]+)$/;
const RESULT_PATH_RE = /^\/v1\/tasks\/([\w-]+)\/result$/;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LongPollWorker', () => {
  // eslint-disable-next-line typescript-eslint/no-redundant-type-constituents -- Bun.serve return type
  let server: ReturnType<typeof Bun.serve> | undefined;

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = undefined;
    }
  });

  it('constructor stores options with defaults', () => {
    const worker = new LongPollWorker({
      serverUrl: 'http://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    expect(worker).toBeDefined();

    worker[Symbol.dispose]();
  });

  it('running is false initially', () => {
    const worker = new LongPollWorker({
      serverUrl: 'http://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    expect(worker.running).toBe(false);

    worker[Symbol.dispose]();
  });

  it('inFlight starts at 0', () => {
    const worker = new LongPollWorker({
      serverUrl: 'http://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    expect(worker.inFlight).toBe(0);

    worker[Symbol.dispose]();
  });

  it('[Symbol.dispose] stops polling', () => {
    const worker = new LongPollWorker({
      serverUrl: 'http://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    // Start polling, then dispose
    worker.start();
    expect(worker.running).toBe(true);

    worker[Symbol.dispose]();
    expect(worker.running).toBe(false);
  });

  it('[Symbol.dispose] is idempotent', () => {
    const worker = new LongPollWorker({
      serverUrl: 'http://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    worker[Symbol.dispose]();
    expect(() => worker[Symbol.dispose]()).not.toThrow();
  });

  it('start() sets running to true and is idempotent', () => {
    const worker = new LongPollWorker({
      serverUrl: 'http://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    worker.start();
    expect(worker.running).toBe(true);

    // Calling start again should be a no-op
    worker.start();
    expect(worker.running).toBe(true);

    worker[Symbol.dispose]();
  });

  it('stop() sets running to false and aborts in-progress polls', async () => {
    const worker = new LongPollWorker({
      serverUrl: 'http://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    worker.start();
    expect(worker.running).toBe(true);

    await worker.stop();
    expect(worker.running).toBe(false);
  });

  it('polls GET /v1/tasks/:queue for tasks and executes them', async () => {
    const completedTasks: any[] = [];
    let pollCount = 0;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          // Verify query parameters
          expect(url.searchParams.getAll('activity')).toContain('processOrder');
          expect(url.searchParams.get('timeout')).toBeDefined();

          // Return a task on the first poll, null on subsequent polls
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-1',
              activityName: 'processOrder',
              input: { orderId: 42 },
            });
          }
          return new Response(null, { status: 204 });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = await request.json();
          completedTasks.push(body);
          return Response.json({ ok: true });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = new LongPollWorker({
      serverUrl: `http://localhost:${server.port}`,
      activities: {
        processOrder: async (input: any) => ({ processed: true, orderId: input.orderId }),
      },
    });

    worker.start();
    await Bun.sleep(500);
    await worker.stop();

    expect(completedTasks.length).toBeGreaterThanOrEqual(1);
    const taskCompletion = completedTasks.find((t) => t.operationId === 'op-1');
    expect(taskCompletion).toBeDefined();
    expect(taskCompletion.status).toBe('completed');
    expect(taskCompletion.value).toEqual({ processed: true, orderId: 42 });
  });

  it('sends completion to POST /v1/tasks/:queue/result when activity throws', async () => {
    const completedTasks: any[] = [];
    let pollCount = 0;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-err-1',
              activityName: 'failingActivity',
              input: null,
            });
          }
          return new Response(null, { status: 204 });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = await request.json();
          completedTasks.push(body);
          return Response.json({ ok: true });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = new LongPollWorker({
      serverUrl: `http://localhost:${server.port}`,
      activities: {
        failingActivity: async () => {
          throw new Error('activity failed');
        },
      },
    });

    worker.start();
    await Bun.sleep(500);
    await worker.stop();

    const errorCompletion = completedTasks.find((t) => t.operationId === 'op-err-1');
    expect(errorCompletion).toBeDefined();
    expect(errorCompletion.status).toBe('failed');
    expect(errorCompletion.error).toBe('activity failed');
  });

  it('handles non-ok poll responses by backing off', async () => {
    let pollCount = 0;

    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);

        if (POLL_PATH_RE.test(url.pathname)) {
          pollCount++;
          return new Response('Server Error', { status: 500 });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = new LongPollWorker({
      serverUrl: `http://localhost:${server.port}`,
      activities: {
        processOrder: async (input) => input,
      },
    });

    worker.start();
    await Bun.sleep(300);
    await worker.stop();

    // Should have attempted at least one poll
    expect(pollCount).toBeGreaterThanOrEqual(1);
  });

  it('skips tasks for unknown activities', async () => {
    const completedTasks: any[] = [];
    let pollCount = 0;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-unknown',
              activityName: 'nonExistent',
              input: null,
            });
          }
          return new Response(null, { status: 204 });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = await request.json();
          completedTasks.push(body);
          return Response.json({ ok: true });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = new LongPollWorker({
      serverUrl: `http://localhost:${server.port}`,
      activities: {
        processOrder: async (input) => input,
      },
    });

    worker.start();
    await Bun.sleep(500);
    await worker.stop();

    // Should not have sent a completion for an unknown activity
    const unknownCompletion = completedTasks.find((t) => t.operationId === 'op-unknown');
    expect(unknownCompletion).toBeUndefined();
  });

  it('handles error completion fetch failure gracefully', async () => {
    let pollCount = 0;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-double-fail',
              activityName: 'failingActivity',
              input: null,
            });
          }
          return new Response(null, { status: 204 });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          // Make the completion endpoint fail too
          return new Response('Server Error', { status: 500 });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = new LongPollWorker({
      serverUrl: `http://localhost:${server.port}`,
      activities: {
        failingActivity: async () => {
          throw new Error('activity failed');
        },
      },
    });

    worker.start();
    await Bun.sleep(500);
    await worker.stop();

    // Should not crash; worker should still stop cleanly
    expect(worker.running).toBe(false);
  });

  it('handles non-Error throws in activities', async () => {
    const completedTasks: any[] = [];
    let pollCount = 0;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-string-throw',
              activityName: 'stringThrow',
              input: null,
            });
          }
          return new Response(null, { status: 204 });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = await request.json();
          completedTasks.push(body);
          return Response.json({ ok: true });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = new LongPollWorker({
      serverUrl: `http://localhost:${server.port}`,
      activities: {
        stringThrow: async () => {
          throw 'string error value';
        },
      },
    });

    worker.start();
    await Bun.sleep(500);
    await worker.stop();

    const errorCompletion = completedTasks.find((t) => t.operationId === 'op-string-throw');
    expect(errorCompletion).toBeDefined();
    expect(errorCompletion.status).toBe('failed');
    expect(errorCompletion.error).toBe('string error value');
  });

  it('includes the queue name in the poll URL path', async () => {
    let capturedPath = '';

    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        capturedPath = url.pathname;
        return new Response(null, { status: 204 });
      },
    });

    const worker = new LongPollWorker({
      serverUrl: `http://localhost:${server.port}`,
      queue: 'billing',
      activities: {
        charge: async (input) => input,
      },
    });

    worker.start();
    await Bun.sleep(200);
    await worker.stop();

    expect(capturedPath).toBe('/v1/tasks/billing');
  });
});
