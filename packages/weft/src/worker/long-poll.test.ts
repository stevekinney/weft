import { afterEach, describe, expect, it } from 'bun:test';
import type { ActivityInterceptor } from '../core/interceptor.ts';
import {
  createDeferred,
  waitForCondition,
  withTimeout,
} from '../testing/fake-timers.test-support.ts';
import { LongPollWorker, type LongPollWorkerOptions } from './long-poll.ts';
import type { RemoteWorkerActivityFunction } from './workflow-activity-binding.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POLL_PATH_RE = /^\/api\/v1\/worker-sessions\/([^/]+)\/tasks$/;
const RESULT_PATH_RE = /^\/api\/v1\/worker-sessions\/([^/]+)\/results$/;
const HEARTBEAT_PATH_RE = /^\/api\/v1\/worker-sessions\/([^/]+)\/heartbeat$/;
const SESSION_POLL_PATH_RE = /^\/api\/v1\/worker-sessions\/([^/]+)\/tasks$/;
const SESSION_RESULT_PATH_RE = /^\/api\/v1\/worker-sessions\/([^/]+)\/results$/;
const LONG_POLL_TEST_TIMEOUT_MS = 2_000;
const DEFAULT_TEST_SESSION_ID = 'session-test';
const DEFAULT_TEST_SESSION_TOKEN =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const WORKER_SESSION_CREDENTIAL_HEADER = 'Weft-Worker-Session-Token';
const TEST_WORKFLOW = 'test';

type LongPollWorkerTestOptions =
  | LongPollWorkerOptions
  | (Omit<LongPollWorkerOptions, 'buildId' | 'deploymentName' | 'workflows'> & {
      activities: Record<string, RemoteWorkerActivityFunction>;
      buildId?: string;
      deploymentName?: string;
    });

function createLongPollWorkerForTesting(options: LongPollWorkerTestOptions): LongPollWorker {
  if (!('activities' in options)) return new LongPollWorker(options);
  const { activities, buildId, deploymentName, ...remainingOptions } = options;
  return new LongPollWorker({
    ...remainingOptions,
    deploymentName: deploymentName ?? 'long-poll-test-worker',
    buildId: buildId ?? 'long-poll-test-build',
    workflows: {
      [TEST_WORKFLOW]: {
        name: TEST_WORKFLOW,
        activities,
      },
    },
  });
}

function handleDefaultSessionLifecycleForTesting(request: Request, url: URL): Response | undefined {
  if (url.pathname === '/api/v1/worker-sessions' && request.method === 'POST') {
    return Response.json({
      ok: true,
      sessionId: DEFAULT_TEST_SESSION_ID,
      sessionToken: DEFAULT_TEST_SESSION_TOKEN,
    });
  }
  if (
    url.pathname === `/api/v1/worker-sessions/${DEFAULT_TEST_SESSION_ID}` &&
    request.method === 'DELETE'
  ) {
    return Response.json({ ok: true });
  }
  return undefined;
}

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
    const worker = createLongPollWorkerForTesting({
      serverUrl: 'http://localhost:8080',
      deploymentName: 'constructor-test-worker',
      buildId: 'constructor-test-build',
      workflows: {
        orders: {
          name: 'orders',
          activities: {
            processOrder: async (input) => input,
          },
        },
      },
    });

    expect(worker).toBeDefined();

    worker[Symbol.dispose]();
  });

  it('registers a canonical session before polling and sends results through the session endpoint', async () => {
    const taskCompleted = createDeferred<{
      operationId?: string;
      status?: string;
      value?: unknown;
    }>();
    const seenPaths: string[] = [];
    let registerBody: Record<string, unknown> | undefined;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        seenPaths.push(url.pathname);

        if (url.pathname === '/api/v1/worker-sessions' && request.method === 'POST') {
          registerBody = (await request.json()) as Record<string, unknown>;
          return Response.json({
            ok: true,
            sessionId: 'session-1',
            sessionToken: 'token-session-1',
          });
        }

        if (SESSION_POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          expect(request.headers.get(WORKER_SESSION_CREDENTIAL_HEADER)).toBe('token-session-1');
          return Response.json({
            operationId: 'op-session-1',
            workerId: 'session-1',
            activityName: 'orders.charge',
            input: 'amount',
            attemptToken: 'attempt-token-session-1',
          });
        }

        if (SESSION_RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          expect(request.headers.get(WORKER_SESSION_CREDENTIAL_HEADER)).toBe('token-session-1');
          taskCompleted.resolve(await request.json());
          return Response.json({ ok: true, disposition: 'applied' });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = createLongPollWorkerForTesting({
      serverUrl: `http://localhost:${server.port}`,
      deploymentName: 'orders-worker',
      buildId: 'build-session',
      workflows: {
        orders: {
          name: 'orders',
          activities: {
            charge: async (input) => `charged:${String(input)}`,
          },
        },
      },
      pollTimeout: 50,
    });

    expect(worker.ready).toBe(false);
    worker.start();
    const result = await withTimeout(
      taskCompleted.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'session result delivery',
    );
    expect(worker.ready).toBe(true);
    await worker.stop();
    expect(worker.ready).toBe(false);

    expect(registerBody?.['queue']).toBe('default');
    const registeredManifest = registerBody?.['manifest'] as
      { deployment?: { name?: string } } | undefined;
    expect(registeredManifest?.deployment?.name).toBe('orders-worker');
    expect(seenPaths).toContain('/api/v1/worker-sessions');
    expect(seenPaths).toContain('/api/v1/worker-sessions/session-1/tasks');
    expect(seenPaths).toContain('/api/v1/worker-sessions/session-1/results');
    expect(result).toMatchObject({
      operationId: 'op-session-1',
      status: 'completed',
      value: 'charged:amount',
    });
  });

  it('running is false initially', () => {
    const worker = createLongPollWorkerForTesting({
      serverUrl: 'http://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    expect(worker.running).toBe(false);

    worker[Symbol.dispose]();
  });

  it('inFlight starts at 0', () => {
    const worker = createLongPollWorkerForTesting({
      serverUrl: 'http://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    expect(worker.inFlight).toBe(0);

    worker[Symbol.dispose]();
  });

  it('[Symbol.dispose] stops polling', () => {
    const worker = createLongPollWorkerForTesting({
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
    const worker = createLongPollWorkerForTesting({
      serverUrl: 'http://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    worker[Symbol.dispose]();
    expect(() => worker[Symbol.dispose]()).not.toThrow();
  });

  it('start() sets running to true and is idempotent', () => {
    const worker = createLongPollWorkerForTesting({
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
    const worker = createLongPollWorkerForTesting({
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

  it('stop() aborts the activity context signal for in-flight tasks', async () => {
    const activityStarted = createDeferred();
    const activityAborted = createDeferred();
    let pollCount = 0;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const sessionLifecycleResponse = handleDefaultSessionLifecycleForTesting(request, url);
        if (sessionLifecycleResponse !== undefined) return sessionLifecycleResponse;

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-abort-1',
              workerId: 'longpoll-abort-worker',
              activityName: 'test.abortableActivity',
              input: null,
              workflowExecutionToken: 'workflow-token-abort',
              attemptToken: 'attempt-token-abort',
            });
          }
          return new Response(null, { status: 204 });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          // COR-235: a bare `{ ok: true }` (no disposition) is not a real
          // server response — LongPollResultDelivery treats it as
          // unrecognized and retries indefinitely, which would leave this
          // test's aborted-but-successful result "unacknowledged" at
          // stop() for reasons unrelated to what this test actually checks.
          return Response.json({ ok: true, disposition: 'applied' });
        }

        return Response.json({ ok: true });
      },
    });

    const worker = createLongPollWorkerForTesting({
      serverUrl: `http://localhost:${server.port}`,
      activities: {
        abortableActivity: async (_input, context) => {
          activityStarted.resolve();
          context?.signal.addEventListener('abort', () => activityAborted.resolve(), {
            once: true,
          });
          await activityAborted.promise;
          return 'aborted';
        },
      },
    });

    worker.start();
    await withTimeout(
      activityStarted.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'long-poll activity start',
    );
    await worker.stop();

    await withTimeout(
      activityAborted.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'long-poll activity abort',
    );
    expect(worker.inFlight).toBe(0);
  });

  it('stop() is bounded by disconnectTimeoutMs when an activity ignores its AbortSignal (COR-220)', async () => {
    const activityStarted = createDeferred();
    // Deliberately never resolved during the test — a non-cooperative
    // activity that never checks (or never honors) its AbortSignal. This
    // makes the bound deterministic rather than a race: without a timeout,
    // stop() could ONLY return if this promise settled, which it never does
    // on its own.
    const neverResolves = createDeferred();
    let pollCount = 0;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const sessionLifecycleResponse = handleDefaultSessionLifecycleForTesting(request, url);
        if (sessionLifecycleResponse !== undefined) return sessionLifecycleResponse;

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-non-cooperative-1',
              workerId: 'longpoll-non-cooperative-worker',
              activityName: 'test.nonCooperativeActivity',
              input: null,
              attemptToken: 'attempt-token-non-cooperative',
            });
          }
          return new Response(null, { status: 204 });
        }

        return new Response(null, { status: 204 });
      },
    });

    const worker = createLongPollWorkerForTesting({
      serverUrl: `http://localhost:${server.port}`,
      disconnectTimeoutMs: 100,
      activities: {
        // Ignores the AbortSignal entirely — the activity function never
        // reads `context.signal`, matching a real non-cooperative activity
        // (blocking native work, or code that simply never checks).
        nonCooperativeActivity: async () => {
          activityStarted.resolve();
          await neverResolves.promise;
          return 'unreachable';
        },
      },
    });

    worker.start();
    await withTimeout(
      activityStarted.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'long-poll non-cooperative activity start',
    );

    await withTimeout(
      worker.stop(),
      LONG_POLL_TEST_TIMEOUT_MS,
      'long-poll stop() bounded by disconnectTimeoutMs',
    );

    // Bounded: `withTimeout` above fails the test if stop() waits forever for
    // an activity that will never finish on its own, so it needs no reading of
    // the clock here.
    // The non-cooperative activity is still running — stop() did not, and
    // cannot, force it to stop; it only stopped WAITING for it.
    expect(worker.inFlight).toBe(1);

    neverResolves.resolve();
  });

  it('polls the accepted worker session for tasks and executes them', async () => {
    const completedTasks: any[] = [];
    const taskCompleted = createDeferred();
    let pollCount = 0;
    const observedAuthorizationHeaders: Array<string | null> = [];

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const sessionLifecycleResponse = handleDefaultSessionLifecycleForTesting(request, url);
        if (sessionLifecycleResponse !== undefined) return sessionLifecycleResponse;
        observedAuthorizationHeaders.push(request.headers.get('authorization'));

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          // Activity filtering is derived from the accepted session manifest, not query parameters.
          expect(url.searchParams.getAll('activity')).toEqual([]);
          expect(url.searchParams.get('timeout')).toBeDefined();

          // Return a task on the first poll, null on subsequent polls
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-1',
              workerId: 'longpoll-worker-1',
              activityName: 'test.processOrder',
              input: { orderId: 42 },
              workflowExecutionToken: 'workflow-token-long-poll',
              attemptToken: 'attempt-token-long-poll',
            });
          }
          return new Response(null, { status: 204 });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = await request.json();
          completedTasks.push(body);
          taskCompleted.resolve();
          // COR-235: LongPollResultDelivery only acknowledges (and stops
          // retrying) an applied/duplicate/dead-lettered disposition,
          // matching the real server's actual response shape
          // (handleTaskResultRequest always includes `disposition`) — a bare
          // `{ ok: true }` with no disposition is treated as an unrecognized
          // 2xx body and retried.
          return Response.json({ ok: true, disposition: 'applied' });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = createLongPollWorkerForTesting({
      serverUrl: `http://localhost:${server.port}`,
      headers: { Authorization: 'Bearer worker-key' },
      activities: {
        processOrder: async (input: any, context) => ({
          processed: true,
          orderId: input.orderId,
          workflowExecutionToken: context?.workflowExecutionToken,
          activityAttemptToken: context?.activityAttemptToken,
        }),
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
    expect(taskCompletion.value).toEqual({
      processed: true,
      orderId: 42,
      workflowExecutionToken: 'workflow-token-long-poll',
      activityAttemptToken: 'attempt-token-long-poll',
    });
    expect(observedAuthorizationHeaders).toContain('Bearer worker-key');
  });

  it('sends completion to the worker session result endpoint when activity throws', async () => {
    const completedTasks: any[] = [];
    const taskCompleted = createDeferred();
    let pollCount = 0;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const sessionLifecycleResponse = handleDefaultSessionLifecycleForTesting(request, url);
        if (sessionLifecycleResponse !== undefined) return sessionLifecycleResponse;

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-err-1',
              workerId: 'longpoll-err-worker',
              activityName: 'test.failingActivity',
              input: null,
            });
          }
          return new Response(null, { status: 204 });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = await request.json();
          completedTasks.push(body);
          taskCompleted.resolve();
          return Response.json({ ok: true, disposition: 'applied' });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = createLongPollWorkerForTesting({
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
        const sessionLifecycleResponse = handleDefaultSessionLifecycleForTesting(request, url);
        if (sessionLifecycleResponse !== undefined) return sessionLifecycleResponse;

        if (POLL_PATH_RE.test(url.pathname)) {
          pollCount++;
          pollObserved.resolve();
          return new Response('Server Error', { status: 500 });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = createLongPollWorkerForTesting({
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
        const sessionLifecycleResponse = handleDefaultSessionLifecycleForTesting(request, url);
        if (sessionLifecycleResponse !== undefined) return sessionLifecycleResponse;

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-unknown',
              activityName: 'test.nonExistent',
              input: null,
            });
          }
          return new Response(null, { status: 204 });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = await request.json();
          completedTasks.push(body);
          taskCompleted.resolve();
          return Response.json({ ok: true, disposition: 'applied' });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = createLongPollWorkerForTesting({
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
    // taskCompleted resolves when the server RECEIVES the POST, before it
    // has even sent a response — wait for the client to actually process
    // that response and acknowledge (COR-235) before stopping, so stop()
    // does not race a still-in-flight disposition read and report a
    // spurious "still unacknowledged" warning for a result the server
    // already durably applied.
    await waitForCondition(() => worker.unacknowledgedResultCount === 0, {
      timeoutMs: LONG_POLL_TEST_TIMEOUT_MS,
    });
    await worker.stop();

    // Should have reported the unknown activity as a failure
    const unknownCompletion = completedTasks.find((t) => t.operationId === 'op-unknown');
    expect(unknownCompletion).toBeDefined();
    expect(unknownCompletion.status).toBe('failed');
    expect(unknownCompletion.error).toBe('Unknown activity: test.nonExistent');
  });

  it('retries a failed-activity result after a transient completion-endpoint failure, instead of dropping it (COR-235)', async () => {
    // Before COR-235 this test asserted the opposite: a failed completion
    // POST was a one-shot best-effort attempt, silently and permanently
    // dropped on any further failure ("handles error completion fetch
    // failure gracefully" — normalizing data loss as acceptable behavior).
    // LongPollResultDelivery retains a result until its disposition is
    // actually read, retrying a transient failure instead.
    const activityAttempted = createDeferred();
    const resultDelivered = createDeferred();
    let pollCount = 0;
    let resultAttempts = 0;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const sessionLifecycleResponse = handleDefaultSessionLifecycleForTesting(request, url);
        if (sessionLifecycleResponse !== undefined) return sessionLifecycleResponse;

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-transient-result-failure',
              activityName: 'test.failingActivity',
              input: null,
              attemptToken: 'attempt-token-transient-result-failure',
            });
          }
          return new Response(null, { status: 204 });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          resultAttempts += 1;
          if (resultAttempts === 1) {
            // The first submission fails transiently.
            return new Response('Server Error', { status: 500 });
          }
          resultDelivered.resolve();
          return Response.json({ ok: true, disposition: 'applied' });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = createLongPollWorkerForTesting({
      serverUrl: `http://localhost:${server.port}`,
      resultRetryBaseDelayMs: 10,
      resultRetryMaxDelayMs: 50,
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
    await withTimeout(
      resultDelivered.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'retried result delivery reaching the server',
    );
    await waitForCondition(() => worker.unacknowledgedResultCount === 0, {
      timeoutMs: LONG_POLL_TEST_TIMEOUT_MS,
    });
    expect(resultAttempts).toBeGreaterThanOrEqual(2);

    await worker.stop();
    expect(worker.running).toBe(false);
  });

  it('drops a buffered result on a correlated 403 and never resends it (COR-1271 identity)', async () => {
    const activityAttempted = createDeferred();
    const firstRejectionSent = createDeferred();
    let pollCount = 0;
    let resultAttempts = 0;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const sessionLifecycleResponse = handleDefaultSessionLifecycleForTesting(request, url);
        if (sessionLifecycleResponse !== undefined) return sessionLifecycleResponse;

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-permanently-rejected-longpoll',
              activityName: 'test.echoActivity',
              input: 'hi',
              attemptToken: 'attempt-token-permanently-rejected',
            });
          }
          return new Response(null, { status: 204 });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          resultAttempts += 1;
          const body = await request.json();
          // Every attempt is permanently rejected, correlated to the exact
          // submission — the server will never apply this result no matter
          // how many times it is resent.
          const response = Response.json(
            {
              error: 'Forbidden',
              operationId: body.operationId,
              attemptToken: body.attemptToken,
              reason: 'unknown-operation',
            },
            { status: 403 },
          );
          firstRejectionSent.resolve();
          return response;
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = createLongPollWorkerForTesting({
      serverUrl: `http://localhost:${server.port}`,
      resultRetryBaseDelayMs: 10,
      resultRetryMaxDelayMs: 50,
      activities: {
        echoActivity: async (input) => {
          activityAttempted.resolve();
          return input;
        },
      },
    });

    worker.start();
    await withTimeout(
      activityAttempted.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'echo activity attempt',
    );
    await withTimeout(
      firstRejectionSent.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'first correlated 403',
    );

    // The correlated-403 drop is an observed event: unacknowledgedResultCount
    // reaching 0 after the server has already answered with the correlated
    // rejection means the entry was actually DROPPED, not merely "not yet
    // delivered" (which is what a 0 BEFORE any attempt would prove nothing).
    await waitForCondition(() => worker.unacknowledgedResultCount === 0, {
      timeoutMs: LONG_POLL_TEST_TIMEOUT_MS,
    });
    const attemptsAtDrop = resultAttempts;

    await worker.stop();
    // No further attempts after stop() — confirms the entry was dropped
    // rather than merely paused mid-retry.
    expect(resultAttempts).toBe(attemptsAtDrop);
  });

  it('resumes delivery of an unacknowledged result on start() after stop() (COR-235)', async () => {
    const activityAttempted = createDeferred();
    const resultDelivered = createDeferred();
    let pollCount = 0;
    let resultAttempts = 0;
    let serverHealthy = false;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const sessionLifecycleResponse = handleDefaultSessionLifecycleForTesting(request, url);
        if (sessionLifecycleResponse !== undefined) return sessionLifecycleResponse;

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-resume-on-restart',
              activityName: 'test.echoActivity',
              input: 'hi',
              attemptToken: 'attempt-token-resume-on-restart',
            });
          }
          return new Response(null, { status: 204 });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          resultAttempts += 1;
          if (!serverHealthy) {
            return new Response('Server Error', { status: 500 });
          }
          resultDelivered.resolve();
          return Response.json({ ok: true, disposition: 'applied' });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = createLongPollWorkerForTesting({
      serverUrl: `http://localhost:${server.port}`,
      // Large enough that the retry timer, not a coincidental fire, could
      // never explain a resend landing right after start() — only start()'s
      // own flush() can produce it within this test's timeout.
      resultRetryBaseDelayMs: 10_000,
      resultRetryMaxDelayMs: 30_000,
      activities: {
        echoActivity: async (input) => {
          activityAttempted.resolve();
          return input;
        },
      },
    });

    worker.start();
    await withTimeout(
      activityAttempted.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'echo activity attempt',
    );
    // Wait for the first (failing) delivery attempt to land before stopping,
    // so stop() observes a genuinely unacknowledged result rather than
    // racing the very first send.
    await waitForCondition(() => resultAttempts >= 1, { timeoutMs: LONG_POLL_TEST_TIMEOUT_MS });

    const stopped = await worker.stop();
    expect(stopped.unacknowledgedResults).toBe(1);
    const attemptsAtStop = resultAttempts;

    // The server recovers, and the worker restarts — start() must re-flush
    // the still-buffered result immediately rather than waiting out the
    // (intentionally huge) retry backoff.
    serverHealthy = true;
    worker.start();
    await withTimeout(
      resultDelivered.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'resumed result delivery',
    );
    await waitForCondition(() => worker.unacknowledgedResultCount === 0, {
      timeoutMs: LONG_POLL_TEST_TIMEOUT_MS,
    });
    expect(resultAttempts).toBeGreaterThan(attemptsAtStop);

    await worker.stop();
  });

  it('handles non-Error throws in activities', async () => {
    const completedTasks: any[] = [];
    const taskCompleted = createDeferred();
    let pollCount = 0;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const sessionLifecycleResponse = handleDefaultSessionLifecycleForTesting(request, url);
        if (sessionLifecycleResponse !== undefined) return sessionLifecycleResponse;

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-string-throw',
              activityName: 'test.stringThrow',
              input: null,
            });
          }
          return new Response(null, { status: 204 });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = await request.json();
          completedTasks.push(body);
          taskCompleted.resolve();
          return Response.json({ ok: true, disposition: 'applied' });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = createLongPollWorkerForTesting({
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

  it('sends the authoritative queue name in session registration', async () => {
    const pollObserved = createDeferred();
    let registeredQueue: unknown;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/api/v1/worker-sessions' && request.method === 'POST') {
          const body = (await request.json()) as { queue?: unknown };
          registeredQueue = body.queue;
          return Response.json({
            ok: true,
            sessionId: DEFAULT_TEST_SESSION_ID,
            sessionToken: DEFAULT_TEST_SESSION_TOKEN,
          });
        }
        const sessionLifecycleResponse = handleDefaultSessionLifecycleForTesting(request, url);
        if (sessionLifecycleResponse !== undefined) return sessionLifecycleResponse;
        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollObserved.resolve();
        }
        return new Response(null, { status: 204 });
      },
    });

    const worker = createLongPollWorkerForTesting({
      serverUrl: `http://localhost:${server.port}`,
      queue: 'billing',
      activities: {
        charge: async (input) => input,
      },
    });

    worker.start();
    await withTimeout(pollObserved.promise, LONG_POLL_TEST_TIMEOUT_MS, 'billing queue poll');
    await worker.stop();

    expect(registeredQueue).toBe('billing');
  });

  // ---------------------------------------------------------------------------
  // Interceptor support tests
  // ---------------------------------------------------------------------------

  it('runs activity interceptor around task execution', async () => {
    const completedTasks: any[] = [];
    const taskCompleted = createDeferred();
    const interceptorOrder: string[] = [];
    const originalFetch = globalThis.fetch;
    let pollCount = 0;

    const fetchStub: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const sessionLifecycleResponse = handleDefaultSessionLifecycleForTesting(request, url);
        if (sessionLifecycleResponse !== undefined) return sessionLifecycleResponse;

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-lp-intercepted',
              activityName: 'test.processOrder',
              input: { orderId: 55 },
            });
          }
          return new Response(null, { status: 204 });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = await request.json();
          completedTasks.push(body);
          taskCompleted.resolve();
          return Response.json({ ok: true, disposition: 'applied' });
        }

        return new Response('not found', { status: 404 });
      },
      { preconnect: originalFetch.preconnect },
    );
    globalThis.fetch = fetchStub;

    const loggingInterceptor: ActivityInterceptor = {
      async execute(interception, next) {
        interceptorOrder.push(`before:${interception.activityName}`);
        const result = await next(interception);
        interceptorOrder.push(`after:${interception.activityName}`);
        return result;
      },
    };

    const worker = createLongPollWorkerForTesting({
      serverUrl: 'http://localhost:12345',
      activities: {
        processOrder: async (input: any) => ({ processed: true, orderId: input.orderId }),
      },
      interceptors: [loggingInterceptor],
    });

    try {
      worker.start();
      await withTimeout(
        taskCompleted.promise,
        LONG_POLL_TEST_TIMEOUT_MS,
        'intercepted task completion',
      );
      await worker.stop();
    } finally {
      worker[Symbol.dispose]();
      globalThis.fetch = originalFetch;
    }

    expect(interceptorOrder).toEqual(['before:test.processOrder', 'after:test.processOrder']);

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
        const sessionLifecycleResponse = handleDefaultSessionLifecycleForTesting(request, url);
        if (sessionLifecycleResponse !== undefined) return sessionLifecycleResponse;

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-lp-modify',
              activityName: 'test.echo',
              input: 'original',
            });
          }
          return new Response(null, { status: 204 });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = await request.json();
          completedTasks.push(body);
          taskCompleted.resolve();
          return Response.json({ ok: true, disposition: 'applied' });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const modifyInterceptor: ActivityInterceptor = {
      async execute(interception, next) {
        return next({ ...interception, input: 'modified-by-interceptor' });
      },
    };

    const worker = createLongPollWorkerForTesting({
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
        const sessionLifecycleResponse = handleDefaultSessionLifecycleForTesting(request, url);
        if (sessionLifecycleResponse !== undefined) return sessionLifecycleResponse;

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-lp-headers',
              activityName: 'test.echo',
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
          return Response.json({ ok: true, disposition: 'applied' });
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

    const worker = createLongPollWorkerForTesting({
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

  // ---------------------------------------------------------------------------
  // COR-230, acceptance criterion 5: long-poll activities renew the same
  // attempt-fenced lease contract WebSocket activities do, via a periodic
  // heartbeat POST instead of a wire message.
  // ---------------------------------------------------------------------------

  it('sends periodic activityHeartbeat POSTs, naming operationId and attemptToken, for an in-flight activity (criteria 2, 5)', async () => {
    const heartbeatBodies: any[] = [];
    // A barrier on the THIRD heartbeat, not the first — proves true
    // interval-driven periodicity (the timer firing repeatedly) rather than
    // merely an initial send that a broken interval could still produce
    // once and never again.
    const thirdHeartbeatReceived = createDeferred();
    const releaseActivity = createDeferred();
    let pollCount = 0;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const sessionLifecycleResponse = handleDefaultSessionLifecycleForTesting(request, url);
        if (sessionLifecycleResponse !== undefined) return sessionLifecycleResponse;

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-heartbeat-1',
              workerId: 'longpoll-worker-hb',
              activityName: 'test.longRunningActivity',
              input: null,
              attemptToken: 'attempt-token-hb',
              visibilityTimeout: 30_000,
            });
          }
          return new Response(null, { status: 204 });
        }

        if (HEARTBEAT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = await request.json();
          heartbeatBodies.push(body);
          if (heartbeatBodies.length >= 3) thirdHeartbeatReceived.resolve();
          return Response.json({ ok: true, cancelled: false });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          return Response.json({ ok: true, disposition: 'applied' });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = createLongPollWorkerForTesting({
      serverUrl: `http://localhost:${server.port}`,
      heartbeatIntervalMs: 20,
      activities: {
        longRunningActivity: async () => {
          await releaseActivity.promise;
          return 'done';
        },
      },
    });

    worker.start();
    await withTimeout(
      thirdHeartbeatReceived.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'third interval-driven heartbeat',
    );
    releaseActivity.resolve();
    await worker.stop();

    expect(heartbeatBodies.length).toBeGreaterThanOrEqual(3);
    expect(heartbeatBodies[0]).toEqual({
      operationId: 'op-heartbeat-1',
      workerId: 'longpoll-worker-hb',
      attemptToken: 'attempt-token-hb',
    });
    // Every observed heartbeat, not just the first, names the same
    // (operationId, attemptToken) — proving the interval is renewing the
    // SAME attempt repeatedly, not producing one-off or drifting sends.
    for (const body of heartbeatBodies) {
      expect(body.operationId).toBe('op-heartbeat-1');
      expect(body.attemptToken).toBe('attempt-token-hb');
    }
  });

  it('aborts the activity and reports status "cancelled" when a heartbeat response says cancelled: true (criteria 5, 13)', async () => {
    const activityStarted = createDeferred();
    const activityAborted = createDeferred();
    const taskResultReceived = createDeferred();
    const completedTasks: any[] = [];
    let pollCount = 0;
    let heartbeatCount = 0;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const sessionLifecycleResponse = handleDefaultSessionLifecycleForTesting(request, url);
        if (sessionLifecycleResponse !== undefined) return sessionLifecycleResponse;

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-cancel-via-heartbeat',
              workerId: 'longpoll-worker-cancel',
              activityName: 'test.cancellableActivity',
              input: null,
              attemptToken: 'attempt-token-cancel',
              visibilityTimeout: 30_000,
            });
          }
          return new Response(null, { status: 204 });
        }

        if (HEARTBEAT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          heartbeatCount++;
          // The first heartbeat is answered normally; the server only
          // decides to cancel after the fact (e.g. an operator call to
          // `cancelTask`) — the second heartbeat carries that signal.
          return Response.json({ ok: true, cancelled: heartbeatCount >= 2 });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = await request.json();
          completedTasks.push(body);
          taskResultReceived.resolve();
          return Response.json({ ok: true, disposition: 'applied' });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = createLongPollWorkerForTesting({
      serverUrl: `http://localhost:${server.port}`,
      heartbeatIntervalMs: 20,
      activities: {
        cancellableActivity: async (_input, context) => {
          activityStarted.resolve();
          context?.signal.addEventListener('abort', () => activityAborted.resolve(), {
            once: true,
          });
          await activityAborted.promise;
          throw new Error('Aborted');
        },
      },
    });

    worker.start();
    await withTimeout(activityStarted.promise, LONG_POLL_TEST_TIMEOUT_MS, 'activity started');
    await withTimeout(activityAborted.promise, LONG_POLL_TEST_TIMEOUT_MS, 'activity aborted');
    await withTimeout(
      taskResultReceived.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'task result received',
    );
    await worker.stop();

    const taskResult = completedTasks.find((t) => t.operationId === 'op-cancel-via-heartbeat');
    expect(taskResult).toBeDefined();
    expect(taskResult.status).toBe('cancelled');
    expect(taskResult.cancelled).toBe(true);
  });

  it('reports the durably recorded cancellation reason on a cancelled result instead of a generic literal (COR-223)', async () => {
    const activityStarted = createDeferred();
    const activityAborted = createDeferred();
    const taskResultReceived = createDeferred();
    const completedTasks: any[] = [];
    let receivedSignalReason: unknown;
    let pollCount = 0;
    let heartbeatCount = 0;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const sessionLifecycleResponse = handleDefaultSessionLifecycleForTesting(request, url);
        if (sessionLifecycleResponse !== undefined) return sessionLifecycleResponse;

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-cancel-reason-lp',
              workerId: 'longpoll-worker-cancel-reason',
              activityName: 'test.cancellableActivity',
              input: null,
              attemptToken: 'attempt-token-cancel-reason',
              visibilityTimeout: 30_000,
            });
          }
          return new Response(null, { status: 204 });
        }

        if (HEARTBEAT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          heartbeatCount++;
          return Response.json({
            ok: true,
            cancelled: heartbeatCount >= 2,
            ...(heartbeatCount >= 2 ? { reason: 'operator requested: customer refund' } : {}),
          });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = await request.json();
          completedTasks.push(body);
          taskResultReceived.resolve();
          return Response.json({ ok: true, disposition: 'applied' });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = createLongPollWorkerForTesting({
      serverUrl: `http://localhost:${server.port}`,
      heartbeatIntervalMs: 20,
      activities: {
        cancellableActivity: async (_input, context) => {
          activityStarted.resolve();
          context?.signal.addEventListener(
            'abort',
            () => {
              receivedSignalReason = context.signal.reason;
              activityAborted.resolve();
            },
            { once: true },
          );
          await activityAborted.promise;
          throw new Error('Aborted');
        },
      },
    });

    worker.start();
    await withTimeout(activityStarted.promise, LONG_POLL_TEST_TIMEOUT_MS, 'activity started');
    await withTimeout(activityAborted.promise, LONG_POLL_TEST_TIMEOUT_MS, 'activity aborted');
    await withTimeout(
      taskResultReceived.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'task result received',
    );
    await worker.stop();

    const taskResult = completedTasks.find((t) => t.operationId === 'op-cancel-reason-lp');
    expect(taskResult).toBeDefined();
    expect(taskResult.status).toBe('cancelled');
    expect(taskResult.error).toBe('operator requested: customer refund');
    expect(receivedSignalReason).toBe('operator requested: customer refund');
  });

  it("sends heartbeat details on demand and surfaces a prior attempt's lastHeartbeatDetails from the poll response (COR-226)", async () => {
    const heartbeatBodies: any[] = [];
    const detailsHeartbeatReceived = createDeferred();
    let receivedLastHeartbeatDetails: unknown;
    let pollCount = 0;

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const sessionLifecycleResponse = handleDefaultSessionLifecycleForTesting(request, url);
        if (sessionLifecycleResponse !== undefined) return sessionLifecycleResponse;

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            // Simulates a redispatch: the server would normally derive this
            // from the previous attempt's durably persisted
            // lastHeartbeatDetails (see task-heartbeat.test.ts for the
            // server-side ledger round trip); here the CLIENT's own wiring
            // is what is under test.
            return Response.json({
              operationId: 'op-heartbeat-details-lp',
              workerId: 'longpoll-worker-details',
              activityName: 'test.detailsActivity',
              input: null,
              attemptToken: 'attempt-token-details',
              visibilityTimeout: 30_000,
              lastHeartbeatDetails: { progress: 0.5 },
            });
          }
          return new Response(null, { status: 204 });
        }

        if (HEARTBEAT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = await request.json();
          heartbeatBodies.push(body);
          if (body.details !== undefined) detailsHeartbeatReceived.resolve();
          return Response.json({ ok: true, cancelled: false });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          return Response.json({ ok: true, disposition: 'applied' });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = createLongPollWorkerForTesting({
      serverUrl: `http://localhost:${server.port}`,
      heartbeatIntervalMs: 20,
      activities: {
        detailsActivity: async (_input, context) => {
          receivedLastHeartbeatDetails = context?.lastHeartbeatDetails;
          context?.heartbeat({ progress: 0.75 });
          return 'done';
        },
      },
    });

    worker.start();
    await withTimeout(
      detailsHeartbeatReceived.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'on-demand heartbeat with details',
    );
    await worker.stop();

    const detailsHeartbeat = heartbeatBodies.find((body) => body.details !== undefined);
    expect(detailsHeartbeat.details).toEqual({ progress: 0.75 });
    expect(receivedLastHeartbeatDetails).toEqual({ progress: 0.5 });
  });

  it('a cancellation signal for one operation does not abort a different concurrently in-flight operation (criterion 11)', async () => {
    const bothStarted = createDeferred();
    const aAborted = createDeferred();
    const bResultReceived = createDeferred();
    let aStarted = false;
    let bStarted = false;
    let bAbortObserved = false;
    const completedTasks: any[] = [];
    let pollCount = 0;

    function checkBothStarted(): void {
      if (aStarted && bStarted) bothStarted.resolve();
    }

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const sessionLifecycleResponse = handleDefaultSessionLifecycleForTesting(request, url);
        if (sessionLifecycleResponse !== undefined) return sessionLifecycleResponse;

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            return Response.json({
              operationId: 'op-fenced-a',
              workerId: 'longpoll-worker-fenced',
              activityName: 'test.fencedActivity',
              input: 'a',
              attemptToken: 'attempt-token-a',
              visibilityTimeout: 30_000,
            });
          }
          if (pollCount === 2) {
            return Response.json({
              operationId: 'op-fenced-b',
              workerId: 'longpoll-worker-fenced',
              activityName: 'test.fencedActivity',
              input: 'b',
              attemptToken: 'attempt-token-b',
              visibilityTimeout: 30_000,
            });
          }
          return new Response(null, { status: 204 });
        }

        if (HEARTBEAT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = (await request.json()) as { operationId: string };
          // Only op-fenced-a is cancelled — op-fenced-b's heartbeat must
          // never be told to cancel, and fencing is by operationId +
          // attemptToken on the CLIENT, so this alone proves the target;
          // the client-side assertions below prove the fencing held.
          return Response.json({ ok: true, cancelled: body.operationId === 'op-fenced-a' });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = await request.json();
          completedTasks.push(body);
          if (body.operationId === 'op-fenced-b') bResultReceived.resolve();
          return Response.json({ ok: true, disposition: 'applied' });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = createLongPollWorkerForTesting({
      serverUrl: `http://localhost:${server.port}`,
      concurrency: 2,
      heartbeatIntervalMs: 20,
      activities: {
        fencedActivity: async (input, context) => {
          if (input === 'a') {
            aStarted = true;
            checkBothStarted();
            context?.signal.addEventListener('abort', () => aAborted.resolve(), { once: true });
            await aAborted.promise;
            throw new Error('Aborted');
          }
          bStarted = true;
          checkBothStarted();
          context?.signal.addEventListener('abort', () => {
            bAbortObserved = true;
          });
          // b resolves on its own — it must never be aborted by a's
          // cancellation, which the fencing (operationId + attemptToken) is
          // responsible for guaranteeing.
          await bothStarted.promise;
          await aAborted.promise;
          return 'b-completed-despite-a-cancellation';
        },
      },
    });

    worker.start();
    await withTimeout(bothStarted.promise, LONG_POLL_TEST_TIMEOUT_MS, 'both activities started');
    await withTimeout(aAborted.promise, LONG_POLL_TEST_TIMEOUT_MS, 'op-fenced-a aborted');
    await withTimeout(
      bResultReceived.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'op-fenced-b result received',
    );
    // Checked BEFORE `stop()`: shutdown deliberately aborts every controller
    // still tracked (including one whose activity already returned but
    // whose bookkeeping hasn't been cleaned up yet) — that is normal
    // teardown, not the fencing behavior under test. The fencing claim is
    // "b's OWN execution was never aborted by a's cancellation", which is
    // fully settled by the time its result was received above.
    expect(bAbortObserved).toBe(false);
    await worker.stop();

    const bResult = completedTasks.find((t) => t.operationId === 'op-fenced-b');
    expect(bResult).toBeDefined();
    expect(bResult.status).toBe('completed');
    expect(bResult.value).toBe('b-completed-despite-a-cancellation');
  });

  it('a completed attempt cleanup does not delete a later, still-live attempt for the same operationId (COR-223, tuple-keyed abort controllers)', async () => {
    const bothStarted = createDeferred();
    const attempt2Aborted = createDeferred();
    const attempt1ResultReceived = createDeferred();
    let attempt1Started = false;
    let attempt2Started = false;
    let attempt1ResultPosted = false;
    const completedTasks: any[] = [];
    let pollCount = 0;

    function checkBothStarted(): void {
      if (attempt1Started && attempt2Started) bothStarted.resolve();
    }

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const sessionLifecycleResponse = handleDefaultSessionLifecycleForTesting(request, url);
        if (sessionLifecycleResponse !== undefined) return sessionLifecycleResponse;

        if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
          pollCount++;
          if (pollCount === 1) {
            // Same operationId, DIFFERENT attemptTokens — simulates a
            // same-worker redispatch that lands back on this exact worker
            // instance while an earlier attempt of the same operation is
            // still executing.
            return Response.json({
              operationId: 'op-overlap-lp',
              workerId: 'longpoll-worker-overlap',
              activityName: 'test.overlapActivity',
              input: 'attempt-1',
              attemptToken: 'attempt-1',
              visibilityTimeout: 30_000,
            });
          }
          if (pollCount === 2) {
            return Response.json({
              operationId: 'op-overlap-lp',
              workerId: 'longpoll-worker-overlap',
              activityName: 'test.overlapActivity',
              input: 'attempt-2',
              attemptToken: 'attempt-2',
              visibilityTimeout: 30_000,
            });
          }
          return new Response(null, { status: 204 });
        }

        if (HEARTBEAT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = (await request.json()) as { attemptToken: string };
          // attempt-1 is never told to cancel. attempt-2 is only told to
          // cancel AFTER attempt-1's result has actually landed — the exact
          // moment attempt-1's `finally` cleanup runs. If that cleanup wrongly
          // deleted attempt-2's live table entry (the pre-COR-223 bug), this
          // worker's own `#sendHeartbeat` lookup for attempt-2 finds nothing
          // and silently never aborts it, so `attempt2Aborted` never resolves
          // and the test times out below instead of falsely passing.
          const cancelled = body.attemptToken === 'attempt-2' && attempt1ResultPosted;
          return Response.json({ ok: true, cancelled });
        }

        if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
          const body = await request.json();
          completedTasks.push(body);
          if (body.attemptToken === 'attempt-1') {
            attempt1ResultPosted = true;
            attempt1ResultReceived.resolve();
          }
          return Response.json({ ok: true, disposition: 'applied' });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const worker = createLongPollWorkerForTesting({
      serverUrl: `http://localhost:${server.port}`,
      concurrency: 2,
      heartbeatIntervalMs: 20,
      activities: {
        overlapActivity: async (input, context) => {
          if (input === 'attempt-1') {
            attempt1Started = true;
            checkBothStarted();
            // Completes NORMALLY on its own — never cancelled — which is
            // what triggers its `finally` cleanup.
            return 'attempt-1-completed';
          }
          attempt2Started = true;
          checkBothStarted();
          context?.signal.addEventListener('abort', () => attempt2Aborted.resolve(), {
            once: true,
          });
          // Never resolves on its own — only a heartbeat response naming
          // THIS attempt's `cancelled: true` should ever settle it.
          await attempt2Aborted.promise;
          throw new Error('attempt-2 aborted');
        },
      },
    });

    worker.start();
    await withTimeout(bothStarted.promise, LONG_POLL_TEST_TIMEOUT_MS, 'both attempts started');
    await withTimeout(
      attempt1ResultReceived.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'attempt-1 result received',
    );
    // Only now does the server start telling attempt-2's heartbeat to
    // cancel — proving attempt-2's controller survived attempt-1's cleanup.
    await withTimeout(
      attempt2Aborted.promise,
      LONG_POLL_TEST_TIMEOUT_MS,
      'attempt-2 observed its own abort after attempt-1 completed and cleaned up',
    );
    await worker.stop();

    const attempt2Result = completedTasks.find((t) => t.attemptToken === 'attempt-2');
    expect(attempt2Result).toBeDefined();
    expect(attempt2Result.status).toBe('cancelled');
    expect(attempt2Result.cancelled).toBe(true);
  });
});
