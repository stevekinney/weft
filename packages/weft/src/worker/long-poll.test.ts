import { createDeferred, waitForCondition } from "../../test-support/embedded/testing/src/fake-timers.ts";
import { rejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { ActivityInterceptor } from '../core/interceptor.ts';
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

interface ScriptedSessionServerOptions {
  /** Tasks handed out, in order, one per poll from the intended worker only. */
  readonly tasks: readonly Record<string, unknown>[];
  /** Whether the heartbeat for this body should be answered `cancelled: true`. */
  readonly isCancelled: (heartbeat: { operationId: string; attemptToken: string }) => boolean;
  /** Called with every result body the intended worker posts. */
  readonly onResult: (result: any) => void;
}

interface ScriptedSessionServer {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly serverUrl: string;
  /** The `deploymentName` the intended worker must register under; any other registrant is refused. */
  readonly deploymentName: string;
  /** Requests refused because they came from a worker other than the intended one. */
  readonly refusedRequests: string[];
  /** Settles with the first refused request. */
  readonly firstRefusal: Promise<string>;
  /** Settles when a poll finds no task and parks, which is the point a spinning poll loop would reach again. */
  readonly idlePollParked: Promise<void>;
  /** The number of task polls the intended worker has made. */
  readonly pollCount: () => number;
  /**
   * Settles `promise` unless a result with status `failed` arrives first, in which case it rejects
   * with that result's error. A task executed by a worker that lacks the scenario's activity
   * reports `Unknown activity: ...`, so a misrouted task fails the test with a clear message
   * instead of leaving the awaited state unreachable.
   */
  readonly awaitOrFail: <T>(promise: Promise<T>) => Promise<T>;
}

/**
 * A fake worker-session server that serves a fixed list of tasks to exactly one intended worker.
 *
 * Routing is deterministic rather than counted: the session id, session token and `deploymentName`
 * are unique to the call, registration is refused for any other deployment name, and the task,
 * heartbeat and result endpoints refuse a caller that does not hold the session credential. A
 * `LongPollWorker` left polling by another test, which retries against a dead port every second
 * and can land on this server when the kernel reuses the port, therefore can neither take a task
 * nor post a result. An idle poll is parked until the client disconnects (a real long poll) rather
 * than answered with an instant 204, which would make the worker's poll loop spin.
 */
function startScriptedSessionServerForTesting(
  options: ScriptedSessionServerOptions,
): ScriptedSessionServer {
  const deploymentName = `scripted-${crypto.randomUUID()}`;
  const sessionId = `session-${crypto.randomUUID()}`;
  const sessionToken = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '');
  const pendingTasks = [...options.tasks];
  const refusedRequests: string[] = [];
  const firstRefusal = createDeferred<string>();
  const idlePollParked = createDeferred();
  let pollCount = 0;
  let rejectFailed: (error: Error) => void = () => {};
  const failed = new Promise<never>((_resolve, reject) => {
    rejectFailed = reject;
  });
  // Observed only by `awaitOrFail`; a failure nobody awaits must not surface as an unhandled rejection.
  failed.catch(() => {});

  const refuse = (request: Request, url: URL): Response => {
    refusedRequests.push(`${request.method} ${url.pathname}`);
    firstRefusal.resolve(`${request.method} ${url.pathname}`);
    return new Response('refused: not the intended worker session', { status: 403 });
  };

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === '/api/v1/worker-sessions' && request.method === 'POST') {
        const registration = (await request.json()) as {
          manifest?: { deployment?: { name?: string } };
        };
        if (registration.manifest?.deployment?.name !== deploymentName) return refuse(request, url);
        return Response.json({ ok: true, sessionId, sessionToken });
      }

      const sessionPrefix = `/api/v1/worker-sessions/${sessionId}`;
      if (url.pathname === sessionPrefix && request.method === 'DELETE') {
        return Response.json({ ok: true });
      }
      if (
        !url.pathname.startsWith(`${sessionPrefix}/`) ||
        request.headers.get(WORKER_SESSION_CREDENTIAL_HEADER) !== sessionToken
      ) {
        return refuse(request, url);
      }

      if (POLL_PATH_RE.test(url.pathname) && request.method === 'GET') {
        pollCount += 1;
        const nextTask = pendingTasks.shift();
        if (nextTask !== undefined) return Response.json(nextTask);
        await new Promise<void>((resolve) => {
          idlePollParked.resolve();
          if (request.signal.aborted) resolve();
          request.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return new Response(null, { status: 204 });
      }

      if (HEARTBEAT_PATH_RE.test(url.pathname) && request.method === 'POST') {
        const body = (await request.json()) as { operationId: string; attemptToken: string };
        return Response.json({ ok: true, cancelled: options.isCancelled(body) });
      }

      if (RESULT_PATH_RE.test(url.pathname) && request.method === 'POST') {
        const body = (await request.json()) as { status?: string; error?: string };
        options.onResult(body);
        if (body.status === 'failed') {
          rejectFailed(new Error(`The worker reported a failed result: ${String(body.error)}`));
        }
        return Response.json({ ok: true, disposition: 'applied' });
      }

      return new Response('not found', { status: 404 });
    },
  });

  return {
    server,
    serverUrl: `http://localhost:${server.port}`,
    deploymentName,
    refusedRequests,
    firstRefusal: firstRefusal.promise,
    idlePollParked: idlePollParked.promise,
    pollCount: () => pollCount,
    awaitOrFail: (promise) => Promise.race([promise, failed]),
  };
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
    const result = await taskCompleted.promise;
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
    await activityStarted.promise;
    await worker.stop();

    await activityAborted.promise;
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
    await activityStarted.promise;

    await worker.stop();

    // A stop() that waits forever for an activity that will never finish on its
    // own is ended by the hang guard, so it needs no reading of the clock here.
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
    await taskCompleted.promise;
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
    await taskCompleted.promise;
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
    await pollObserved.promise;
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
    await taskCompleted.promise;
    // taskCompleted resolves when the server RECEIVES the POST, before it
    // has even sent a response — wait for the client to actually process
    // that response and acknowledge (COR-235) before stopping, so stop()
    // does not race a still-in-flight disposition read and report a
    // spurious "still unacknowledged" warning for a result the server
    // already durably applied.
    await waitForCondition(() => worker.unacknowledgedResultCount === 0);
    await worker.stop();

    // Should have reported the unknown activity as a failure
    const unknownCompletion = completedTasks.find((t) => t.operationId === 'op-unknown');
    expect(unknownCompletion).toBeDefined();
    expect(unknownCompletion.status).toBe('failed');
    expect(unknownCompletion.error).toBe('Unknown activity: test.nonExistent');
  });

  it('reports an activity named after an inherited member as unknown', async () => {
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
              operationId: 'op-inherited',
              activityName: 'constructor',
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
    await taskCompleted.promise;
    // taskCompleted resolves when the server RECEIVES the POST, before it
    // has even sent a response — wait for the client to actually process
    // that response and acknowledge (COR-235) before stopping, so stop()
    // does not race a still-in-flight disposition read and report a
    // spurious "still unacknowledged" warning for a result the server
    // already durably applied.
    await waitForCondition(() => worker.unacknowledgedResultCount === 0);
    await worker.stop();

    // Should have reported the unknown activity as a failure
    const unknownCompletion = completedTasks.find((t) => t.operationId === 'op-inherited');
    expect(unknownCompletion).toBeDefined();
    expect(unknownCompletion.status).toBe('failed');
    expect(unknownCompletion.error).toBe('Unknown activity: constructor');
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
    await activityAttempted.promise;
    await resultDelivered.promise;
    await waitForCondition(() => worker.unacknowledgedResultCount === 0);
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
    await activityAttempted.promise;
    await firstRejectionSent.promise;

    // The correlated-403 drop is an observed event: unacknowledgedResultCount
    // reaching 0 after the server has already answered with the correlated
    // rejection means the entry was actually DROPPED, not merely "not yet
    // delivered" (which is what a 0 BEFORE any attempt would prove nothing).
    await waitForCondition(() => worker.unacknowledgedResultCount === 0);
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
    await activityAttempted.promise;
    // Wait for the first (failing) delivery attempt to land before stopping,
    // so stop() observes a genuinely unacknowledged result rather than
    // racing the very first send.
    await waitForCondition(() => resultAttempts >= 1);

    const stopped = await worker.stop();
    expect(stopped.unacknowledgedResults).toBe(1);
    const attemptsAtStop = resultAttempts;

    // The server recovers, and the worker restarts — start() must re-flush
    // the still-buffered result immediately rather than waiting out the
    // (intentionally huge) retry backoff.
    serverHealthy = true;
    worker.start();
    await resultDelivered.promise;
    await waitForCondition(() => worker.unacknowledgedResultCount === 0);
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
    await taskCompleted.promise;
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
    await pollObserved.promise;
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
      await taskCompleted.promise;
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
    await taskCompleted.promise;
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
    await taskCompleted.promise;
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
    await thirdHeartbeatReceived.promise;
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
    await activityStarted.promise;
    await activityAborted.promise;
    await taskResultReceived.promise;
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
    await activityStarted.promise;
    await activityAborted.promise;
    await taskResultReceived.promise;
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
    await detailsHeartbeatReceived.promise;
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
    let bothAreStarted = false;
    let bAbortObserved = false;
    const completedTasks: any[] = [];

    function checkBothStarted(): void {
      if (aStarted && bStarted) {
        bothAreStarted = true;
        bothStarted.resolve();
      }
    }

    const scripted = startScriptedSessionServerForTesting({
      tasks: [
        {
          operationId: 'op-fenced-a',
          workerId: 'longpoll-worker-fenced',
          activityName: 'test.fencedActivity',
          input: 'a',
          attemptToken: 'attempt-token-a',
          visibilityTimeout: 30_000,
        },
        {
          operationId: 'op-fenced-b',
          workerId: 'longpoll-worker-fenced',
          activityName: 'test.fencedActivity',
          input: 'b',
          attemptToken: 'attempt-token-b',
          visibilityTimeout: 30_000,
        },
      ],
      // Only op-fenced-a is cancelled, and only once both operations are in flight, so the
      // cancellation always lands while b is running. op-fenced-b's heartbeat must never be told
      // to cancel; fencing is by operationId + attemptToken on the CLIENT, so this alone proves
      // the target, and the client-side assertions below prove the fencing held.
      isCancelled: (heartbeat) => heartbeat.operationId === 'op-fenced-a' && bothAreStarted,
      onResult: (result) => {
        completedTasks.push(result);
        if (result.operationId === 'op-fenced-b') bResultReceived.resolve();
      },
    });
    server = scripted.server;

    const worker = createLongPollWorkerForTesting({
      serverUrl: scripted.serverUrl,
      deploymentName: scripted.deploymentName,
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
    await scripted.awaitOrFail(bothStarted.promise);
    await scripted.awaitOrFail(aAborted.promise);
    await scripted.awaitOrFail(bResultReceived.promise);
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

    function checkBothStarted(): void {
      if (attempt1Started && attempt2Started) bothStarted.resolve();
    }

    const scripted = startScriptedSessionServerForTesting({
      // Same operationId, DIFFERENT attemptTokens — simulates a same-worker redispatch that lands
      // back on this exact worker instance while an earlier attempt of the same operation is
      // still executing.
      tasks: [
        {
          operationId: 'op-overlap-lp',
          workerId: 'longpoll-worker-overlap',
          activityName: 'test.overlapActivity',
          input: 'attempt-1',
          attemptToken: 'attempt-1',
          visibilityTimeout: 30_000,
        },
        {
          operationId: 'op-overlap-lp',
          workerId: 'longpoll-worker-overlap',
          activityName: 'test.overlapActivity',
          input: 'attempt-2',
          attemptToken: 'attempt-2',
          visibilityTimeout: 30_000,
        },
      ],
      // attempt-1 is never told to cancel. attempt-2 is only told to cancel AFTER attempt-1's
      // result has actually landed — the exact moment attempt-1's `finally` cleanup runs. If that
      // cleanup wrongly deleted attempt-2's live table entry (the pre-COR-223 bug), this worker's
      // own `#sendHeartbeat` lookup for attempt-2 finds nothing and silently never aborts it, so
      // `attempt2Aborted` never resolves and the test times out below instead of falsely passing.
      isCancelled: (heartbeat) => heartbeat.attemptToken === 'attempt-2' && attempt1ResultPosted,
      onResult: (result) => {
        completedTasks.push(result);
        if (result.attemptToken === 'attempt-1') {
          attempt1ResultPosted = true;
          attempt1ResultReceived.resolve();
        }
      },
    });
    server = scripted.server;

    const worker = createLongPollWorkerForTesting({
      serverUrl: scripted.serverUrl,
      deploymentName: scripted.deploymentName,
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
    await scripted.awaitOrFail(bothStarted.promise);
    await scripted.awaitOrFail(attempt1ResultReceived.promise);
    // Only now does the server start telling attempt-2's heartbeat to
    // cancel — proving attempt-2's controller survived attempt-1's cleanup.
    await scripted.awaitOrFail(attempt2Aborted.promise);
    await worker.stop();

    const attempt2Result = completedTasks.find((t) => t.attemptToken === 'attempt-2');
    expect(attempt2Result).toBeDefined();
    expect(attempt2Result.status).toBe('cancelled');
    expect(attempt2Result.cancelled).toBe(true);
  });

  // Regression (COR-2295): a heartbeat answered `cancelled: true` used to abort the attempt's
  // controller and leave its automatic heartbeat interval armed until the activity settled. The
  // aborted-signal guard kept that interval from sending, but an activity that ignores its signal
  // kept the real timer firing. The spies prove the exact interval is cleared at cancel time.
  it("clears a cancelled attempt's automatic heartbeat interval while its activity ignores the signal", async () => {
    using setIntervalSpy = spyOn(globalThis, 'setInterval');
    using clearIntervalSpy = spyOn(globalThis, 'clearInterval');
    // Compared by identity: two timers are deep-equal, so `toHaveBeenCalledWith` cannot tell them apart.
    const clearedTimers = () => clearIntervalSpy.mock.calls.map((call) => call[0] as unknown);
    // A delay no other worker or helper timer uses, so it picks out the automatic heartbeats.
    const heartbeatIntervalMs = 23;
    const release = createDeferred();
    const signals = new Map<string, AbortSignal>();
    const completedTasks: any[] = [];
    const task = (operationId: string) => ({
      operationId,
      workerId: 'longpoll-worker-stubborn',
      activityName: 'test.stubbornActivity',
      input: operationId,
      attemptToken: `attempt-${operationId}`,
      visibilityTimeout: 30_000,
    });

    const scripted = startScriptedSessionServerForTesting({
      tasks: [task('op-canceled'), task('op-live')],
      // Only op-canceled's own attempt is told to cancel, and only once both attempts run.
      isCancelled: (heartbeat) =>
        signals.size === 2 &&
        heartbeat.operationId === 'op-canceled' &&
        heartbeat.attemptToken === 'attempt-op-canceled',
      onResult: (result) => completedTasks.push(result),
    });
    server = scripted.server;

    const worker = createLongPollWorkerForTesting({
      serverUrl: scripted.serverUrl,
      deploymentName: scripted.deploymentName,
      concurrency: 2,
      heartbeatIntervalMs,
      activities: {
        // Non-cooperative: never looks at its signal, and settles only when the test releases it.
        stubbornActivity: async (input, context) => {
          if (context !== undefined) signals.set(String(input), context.signal);
          await release.promise;
          throw new Error('settled late');
        },
      },
    });

    worker.start();
    await waitForCondition(() => signals.get('op-canceled')?.aborted === true, {
      label: 'cancelled attempt aborted',
    });

    const intervalCalls = setIntervalSpy.mock.calls as unknown as Array<readonly unknown[]>;
    const heartbeatTimers = intervalCalls.flatMap((call, index) =>
      call[1] === heartbeatIntervalMs
        ? [(setIntervalSpy.mock.results[index] as { value: unknown } | undefined)?.value]
        : [],
    );
    expect(heartbeatTimers).toHaveLength(2);
    const [canceledTimer, liveTimer] = heartbeatTimers;
    expect(signals.get('op-canceled')?.reason).toBe('Task cancelled');
    expect(signals.get('op-live')?.aborted).toBe(false);
    expect(clearedTimers()).toContain(canceledTimer);
    expect(clearedTimers()).not.toContain(liveTimer);
    // Both attempts are still unsettled; the cancelled one keeps its controller for the late result.
    expect(worker.inFlight).toBe(2);

    release.resolve();
    await waitForCondition(() => completedTasks.length === 2, { label: 'late settlements' });
    await worker.stop();

    expect(completedTasks.find((t) => t.operationId === 'op-canceled')).toMatchObject({
      status: 'cancelled',
      error: 'Task cancelled',
    });
    expect(completedTasks.find((t) => t.operationId === 'op-live')).toMatchObject({
      status: 'failed',
      error: 'settled late',
    });
    expect(clearedTimers()).toContain(liveTimer);
  });

  describe('the scripted session server fixture', () => {
    it('serves its tasks only to the worker it was built for, even when another worker polls it first', async () => {
      const resultReceived = createDeferred<{ operationId: string; status: string }>();
      const scripted = startScriptedSessionServerForTesting({
        tasks: [
          {
            operationId: 'op-routed',
            workerId: 'longpoll-worker-routed',
            activityName: 'test.routedActivity',
            input: 'x',
            attemptToken: 'attempt-routed',
            visibilityTimeout: 30_000,
          },
        ],
        isCancelled: () => false,
        onResult: (result) => resultReceived.resolve(result),
      });
      server = scripted.server;

      // Registers under the default deployment name, like a worker another test left running.
      const stray = createLongPollWorkerForTesting({
        serverUrl: scripted.serverUrl,
        activities: {
          routedActivity: async () => {
            throw new Error('the stray worker must never be handed a task');
          },
        },
      });
      stray.start();
      expect(await scripted.firstRefusal).toBe('POST /api/v1/worker-sessions');

      const intended = createLongPollWorkerForTesting({
        serverUrl: scripted.serverUrl,
        deploymentName: scripted.deploymentName,
        activities: { routedActivity: async () => 'routed' },
      });
      intended.start();
      const result = await scripted.awaitOrFail(resultReceived.promise);
      await intended.stop();
      await stray.stop();

      expect(result).toMatchObject({ operationId: 'op-routed', status: 'completed' });
      expect(scripted.refusedRequests).toContain('POST /api/v1/worker-sessions');
    });

    it('fails the awaited state at once when a worker reports a failed result', async () => {
      const never = createDeferred();
      const scripted = startScriptedSessionServerForTesting({
        tasks: [
          {
            operationId: 'op-missing-activity',
            workerId: 'longpoll-worker-missing',
            activityName: 'test.absentActivity',
            input: 'x',
            attemptToken: 'attempt-missing',
            visibilityTimeout: 30_000,
          },
        ],
        isCancelled: () => false,
        onResult: () => {},
      });
      server = scripted.server;
      const worker = createLongPollWorkerForTesting({
        serverUrl: scripted.serverUrl,
        deploymentName: scripted.deploymentName,
        activities: { presentActivity: async () => 'present' },
      });

      worker.start();
      const failure = await rejectionOf(scripted.awaitOrFail(never.promise));
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('Unknown activity: test.absentActivity');
      await worker.stop();
    });

    it('parks an idle poll instead of answering it at once, so the poll loop does not spin', async () => {
      const scripted = startScriptedSessionServerForTesting({
        tasks: [],
        isCancelled: () => false,
        onResult: () => {},
      });
      server = scripted.server;
      const worker = createLongPollWorkerForTesting({
        serverUrl: scripted.serverUrl,
        deploymentName: scripted.deploymentName,
        activities: { idleActivity: async () => 'idle' },
      });

      worker.start();
      await scripted.idlePollParked;
      await worker.stop();

      // An instant 204 would have been answered, and polled again, many times over.
      expect(scripted.pollCount()).toBe(1);
    });
  });
});
