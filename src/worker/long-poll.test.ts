import { afterEach, describe, expect, it } from 'bun:test';
import type { ActivityInterceptor } from '../core/interceptor.ts';
import { createDeferred, withTimeout } from '../testing/fake-timers.test-support.ts';
import { LongPollWorker } from './long-poll.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POLL_PATH_RE = /^\/api\/v1\/tasks\/([\w-]+)$/;
const RESULT_PATH_RE = /^\/api\/v1\/tasks\/([\w-]+)\/result$/;
const LONG_POLL_TEST_TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LongPollWorker', () => {
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

  it('polls GET /api/v1/tasks/:queue for tasks and executes them', async () => {
    const completedTasks: any[] = [];
    const taskCompleted = createDeferred();
    let pollCount = 0;
    const observedAuthorizationHeaders: Array<string | null> = [];

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        observedAuthorizationHeaders.push(request.headers.get('authorization'));

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          // Verify query parameters
          expect(url.searchParams.getAll('activity')).toContain('processOrder');
          expect(url.searchParams.get('timeout')).toBeDefined();

          // Return a task on the first poll, null on subsequent polls
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-1',
              workerId: 'longpoll-worker-1',
              activityName: 'processOrder',
              input: { orderId: 42 },
            });
          }
          return new Response(null, { status: 204 });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = await request.json();
          completedTasks.push(body);
          taskCompleted.resolve();
          return Response.json({ ok: true });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = new LongPollWorker({
      serverUrl: `http://localhost:${server.port}`,
      headers: { Authorization: 'Bearer worker-key' },
      activities: {
        processOrder: async (input: any) => ({ processed: true, orderId: input.orderId }),
      },
    });

    worker.start();
    await withTimeout(
      taskCompleted.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'long-poll task completion',
    );
    await worker.stop();

    expect(completedTasks.length).toBeGreaterThanOrEqual(1);
    const taskCompletion = completedTasks.find((t) => t.operationId === 'op-1');
    expect(taskCompletion).toBeDefined();
    expect(taskCompletion.workerId).toBe('longpoll-worker-1');
    expect(taskCompletion.status).toBe('completed');
    expect(taskCompletion.value).toEqual({ processed: true, orderId: 42 });
    expect(observedAuthorizationHeaders).toContain('Bearer worker-key');
  });

  it('sends completion to POST /api/v1/tasks/:queue/result when activity throws', async () => {
    const completedTasks: any[] = [];
    const taskCompleted = createDeferred();
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
              workerId: 'longpoll-err-worker',
              activityName: 'failingActivity',
              input: null,
            });
          }
          return new Response(null, { status: 204 });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = await request.json();
          completedTasks.push(body);
          taskCompleted.resolve();
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
    await withTimeout(
      taskCompleted.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'long-poll failure completion',
    );
    await worker.stop();

    const errorCompletion = completedTasks.find((t) => t.operationId === 'op-err-1');
    expect(errorCompletion).toBeDefined();
    expect(errorCompletion.status).toBe('failed');
    expect(errorCompletion.error).toBe('activity failed');
    // The failure path echoes the claimed workerId so the ownership guard accepts it.
    expect(errorCompletion.workerId).toBe('longpoll-err-worker');
  });

  it('handles non-ok poll responses by backing off', async () => {
    const pollObserved = createDeferred();
    let pollCount = 0;

    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);

        if (POLL_PATH_RE.test(url.pathname)) {
          pollCount++;
          pollObserved.resolve();
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
    await withTimeout(pollObserved.promise, LONG_POLL_TEST_TIMEOUT_MS, 'long-poll request');
    await worker.stop();

    // Should have attempted at least one poll
    expect(pollCount).toBeGreaterThanOrEqual(1);
  });

  it('reports unknown activities as failures to the server', async () => {
    const completedTasks: any[] = [];
    const taskCompleted = createDeferred();
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
          taskCompleted.resolve();
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
    await withTimeout(
      taskCompleted.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'unknown activity completion',
    );
    await worker.stop();

    // Should have reported the unknown activity as a failure
    const unknownCompletion = completedTasks.find((t) => t.operationId === 'op-unknown');
    expect(unknownCompletion).toBeDefined();
    expect(unknownCompletion.status).toBe('failed');
    expect(unknownCompletion.error).toBe('Unknown activity: nonExistent');
  });

  it('handles error completion fetch failure gracefully', async () => {
    const activityAttempted = createDeferred();
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
          activityAttempted.resolve();
          throw new Error('activity failed');
        },
      },
    });

    worker.start();
    await withTimeout(
      activityAttempted.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'failing activity attempt',
    );
    await worker.stop();

    // Should not crash; worker should still stop cleanly
    expect(worker.running).toBe(false);
  });

  it('handles non-Error throws in activities', async () => {
    const completedTasks: any[] = [];
    const taskCompleted = createDeferred();
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
          taskCompleted.resolve();
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
    await withTimeout(taskCompleted.promise, LONG_POLL_TEST_TIMEOUT_MS, 'string throw completion');
    await worker.stop();

    const errorCompletion = completedTasks.find((t) => t.operationId === 'op-string-throw');
    expect(errorCompletion).toBeDefined();
    expect(errorCompletion.status).toBe('failed');
    expect(errorCompletion.error).toBe('string error value');
  });

  it('includes the queue name in the poll URL path', async () => {
    const pollObserved = createDeferred();
    let capturedPath = '';

    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        capturedPath = url.pathname;
        pollObserved.resolve();
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
    await withTimeout(pollObserved.promise, LONG_POLL_TEST_TIMEOUT_MS, 'billing queue poll');
    await worker.stop();

    expect(capturedPath).toBe('/api/v1/tasks/billing');
  });

  // ---------------------------------------------------------------------------
  // Interceptor support tests
  // ---------------------------------------------------------------------------

  it('runs activity interceptor around task execution', async () => {
    const completedTasks: any[] = [];
    const taskCompleted = createDeferred();
    const interceptorOrder: string[] = [];
    let pollCount = 0;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-lp-intercepted',
              activityName: 'processOrder',
              input: { orderId: 55 },
            });
          }
          return new Response(null, { status: 204 });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = await request.json();
          completedTasks.push(body);
          taskCompleted.resolve();
          return Response.json({ ok: true });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const loggingInterceptor: ActivityInterceptor = {
      async execute(interception, next) {
        interceptorOrder.push(`before:${interception.activityName}`);
        const result = await next(interception);
        interceptorOrder.push(`after:${interception.activityName}`);
        return result;
      },
    };

    const worker = new LongPollWorker({
      serverUrl: `http://localhost:${server.port}`,
      activities: {
        processOrder: async (input: any) => ({ processed: true, orderId: input.orderId }),
      },
      interceptors: [loggingInterceptor],
    });

    worker.start();
    await withTimeout(
      taskCompleted.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'intercepted task completion',
    );
    await worker.stop();

    expect(interceptorOrder).toEqual(['before:processOrder', 'after:processOrder']);

    const taskCompletion = completedTasks.find((t) => t.operationId === 'op-lp-intercepted');
    expect(taskCompletion).toBeDefined();
    expect(taskCompletion.status).toBe('completed');
    expect(taskCompletion.value).toEqual({ processed: true, orderId: 55 });
  });

  it('interceptor can modify activity input in long-poll worker', async () => {
    const completedTasks: any[] = [];
    const taskCompleted = createDeferred();
    let pollCount = 0;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-lp-modify',
              activityName: 'echo',
              input: 'original',
            });
          }
          return new Response(null, { status: 204 });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = await request.json();
          completedTasks.push(body);
          taskCompleted.resolve();
          return Response.json({ ok: true });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const modifyInterceptor: ActivityInterceptor = {
      async execute(interception, next) {
        return next({ ...interception, input: 'modified-by-interceptor' });
      },
    };

    const worker = new LongPollWorker({
      serverUrl: `http://localhost:${server.port}`,
      activities: {
        echo: async (input: any) => input,
      },
      interceptors: [modifyInterceptor],
    });

    worker.start();
    await withTimeout(
      taskCompleted.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'modified input task completion',
    );
    await worker.stop();

    const taskCompletion = completedTasks.find((t) => t.operationId === 'op-lp-modify');
    expect(taskCompletion).toBeDefined();
    expect(taskCompletion.status).toBe('completed');
    expect(taskCompletion.value).toBe('modified-by-interceptor');
  });

  it('interceptor receives propagated headers from task response', async () => {
    const completedTasks: any[] = [];
    const taskCompleted = createDeferred();
    let capturedHeaders: Map<string, string> | undefined;
    let pollCount = 0;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-lp-headers',
              activityName: 'echo',
              input: 'hi',
              headers: { 'x-trace-id': 'trace-lp-1', 'x-env': 'staging' },
            });
          }
          return new Response(null, { status: 204 });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = await request.json();
          completedTasks.push(body);
          taskCompleted.resolve();
          return Response.json({ ok: true });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const headerInterceptor: ActivityInterceptor = {
      async execute(interception, next) {
        capturedHeaders = interception.headers;
        return next(interception);
      },
    };

    const worker = new LongPollWorker({
      serverUrl: `http://localhost:${server.port}`,
      activities: {
        echo: async (input: any) => input,
      },
      interceptors: [headerInterceptor],
    });

    worker.start();
    await withTimeout(
      taskCompleted.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'header propagation task completion',
    );
    await worker.stop();

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!.get('x-trace-id')).toBe('trace-lp-1');
    expect(capturedHeaders!.get('x-env')).toBe('staging');

    const taskCompletion = completedTasks.find((t) => t.operationId === 'op-lp-headers');
    expect(taskCompletion).toBeDefined();
    expect(taskCompletion.status).toBe('completed');
  });
});
