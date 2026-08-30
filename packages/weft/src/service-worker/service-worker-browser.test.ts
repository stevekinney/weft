import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const shouldRunBrowserSmoke = Bun.env['WEFT_BROWSER_SMOKE'] === '1';

const browserSmokeTest = shouldRunBrowserSmoke ? it : it.skip;
const repositoryRoot = new URL('../..', import.meta.url);
const engineModulePath = fileURLToPath(new URL('src/core/engine.ts', repositoryRoot));
const typesModulePath = fileURLToPath(new URL('src/core/types.ts', repositoryRoot));
const handlerModulePath = fileURLToPath(new URL('src/server/handler.ts', repositoryRoot));
const indexedDatabaseStorageModulePath = fileURLToPath(
  new URL('src/storage/indexeddb.ts', repositoryRoot),
);
const serviceWorkerModulePath = fileURLToPath(
  new URL('src/service-worker/index.ts', repositoryRoot),
);
const schedulerModulePath = fileURLToPath(
  new URL('src/service-worker/scheduler.ts', repositoryRoot),
);
const setupModulePath = fileURLToPath(new URL('src/service-worker/setup.ts', repositoryRoot));

const createdDirectories: string[] = [];
const contexts: BrowserContext[] = [];
let sharedBrowser: Browser | null = null;
let server: Bun.Server<unknown> | null = null;

afterEach(async () => {
  if (server !== null) {
    await Promise.resolve(server.stop(true));
    server = null;
  }
  // Close contexts, not the browser: a context is an in-process teardown, while
  // closing a browser tears down an OS process and the next test then pays a
  // full cold launch. A fresh context is still a fresh storage partition, so
  // Service Worker registrations and IndexedDB stay isolated between tests.
  await Promise.all(contexts.splice(0).map((context) => context.close()));
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

afterAll(async () => {
  await sharedBrowser?.close();
  sharedBrowser = null;
});

function createTemporaryDirectory(name: string): string {
  const directory = join(tmpdir(), `weft-service-worker-${name}-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  createdDirectories.push(directory);
  return directory;
}

async function buildServiceWorkerBundle(databaseName: string): Promise<string> {
  const directory = createTemporaryDirectory('bundle');
  const entrypoint = join(directory, 'service-worker-entrypoint.ts');
  const outputDirectory = join(directory, 'dist');
  await Bun.write(
    entrypoint,
    `
/// <reference lib="webworker" />
import { Engine } from ${JSON.stringify(engineModulePath)};
import { activity, workflow } from ${JSON.stringify(typesModulePath)};
import { handleRequest } from ${JSON.stringify(handlerModulePath)};
import { IndexedDBStorage } from ${JSON.stringify(indexedDatabaseStorageModulePath)};
import {
  buildDelegatedRequest,
  createFetchHandler,
  createLifecycleHandlers,
  createPeriodicSyncHandler,
  normalizePathPrefix,
} from ${JSON.stringify(serviceWorkerModulePath)};
import { ServiceWorkerScheduler } from ${JSON.stringify(schedulerModulePath)};

const serviceWorker = self;
const instanceId = crypto.randomUUID();
const lifecycleEvents = [];
let activityCount = 0;
let schedulerNow = Date.now();

const storage = new IndexedDBStorage(${JSON.stringify(databaseName)});
const engine = new Engine({ storage });
const scheduler = new ServiceWorkerScheduler({
  storage,
  onTimerFired: (entry) => engine.fireTimer(entry),
  getNow: () => schedulerNow,
});
const periodicSyncHandler = createPeriodicSyncHandler(scheduler);
const pathPrefix = normalizePathPrefix('/weft/');
const fetchHandler = createFetchHandler({ engine, pathPrefix });
let recoveryComplete = false;
const recoveryReady = engine.recoverAll().then(() => {
  recoveryComplete = true;
});

const countedActivity = activity({
  name: 'countedActivity',
  execute: async () => {
    activityCount++;
    const response = await fetch(new URL('/activity-count/increment', serviceWorker.location.origin), {
      method: 'POST',
    });
    if (!response.ok) throw new Error('activity count request failed: ' + response.status);
    return activityCount;
  },
});

const activityThenSignal = workflow({ name: 'activity-then-signal' }).execute(async function* (ctx) {
  const count = yield* ctx.run(countedActivity);
  const signalPayload = yield* ctx.waitForSignal('finish');
  return { count, signalPayload };
});

const timerWorkflow = workflow({ name: 'timer-workflow' }).execute(async function* (ctx) {
  yield* ctx.sleep(60 * 60 * 1000);
  return 'timer-fired';
});

engine.register(countedActivity);
engine.register(activityThenSignal);
engine.register(timerWorkflow);

const lifecycleHandlers = createLifecycleHandlers();
serviceWorker.addEventListener('install', (event) => {
  lifecycleEvents.push('install');
  lifecycleHandlers.install(event);
});
serviceWorker.addEventListener('activate', (event) => {
  lifecycleEvents.push('activate');
  lifecycleHandlers.activate(event);
});
serviceWorker.addEventListener('fetch', (event) => {
  try {
    const requestUrl = new URL(event.request.url);
    if (!requestUrl.pathname.startsWith(pathPrefix)) return;
    if (recoveryComplete) {
      fetchHandler(event);
      return;
    }
    const delegatedRequest = buildDelegatedRequest(event, pathPrefix);
    if (delegatedRequest === null) return;
    event.respondWith(recoveryReady.then(() => handleRequest(delegatedRequest, engine)));
  } catch (error) {
    event.respondWith(
      new Response(error instanceof Error ? error.message : String(error), { status: 599 }),
    );
  }
});
serviceWorker.addEventListener('periodicsync', periodicSyncHandler);
serviceWorker.addEventListener('message', (event) => {
  const port = event.ports[0];
  if (port === undefined) return;
  const message = event.data ?? {};
  const handled = (async () => {
    await recoveryReady;
    if (message.type === 'weft:test:lifecycle') {
      port.postMessage({ lifecycleEvents });
      return;
    }
    if (message.type === 'weft:test:instance') {
      port.postMessage({ instanceId });
      return;
    }
    if (message.type === 'weft:test:direct-health') {
      const response = await handleRequest(
        new Request(new URL('/v1/health', serviceWorker.location.origin)),
        engine,
      );
      port.postMessage({
        status: response.status,
        body: await response.text(),
      });
      return;
    }
    if (message.type === 'weft:test:periodic-sync') {
      schedulerNow = Date.now() + 2 * 60 * 60 * 1000;
      let tickPromise = Promise.resolve();
      periodicSyncHandler({
        tag: 'weft-timers',
        waitUntil: (promise) => {
          tickPromise = promise;
        },
      });
      await tickPromise;
      port.postMessage({ ticked: true });
      return;
    }
    port.postMessage({ error: 'unknown message type' });
  })();
  // Every await above can reject. Without this the handler would simply never
  // reply, and sendWorkerMessage would report its generic 5s "Service Worker
  // message timed out" instead of the real cause — which is exactly how a
  // bounded readiness rejection would otherwise be lost. Posting { error }
  // reaches the caller because sendWorkerMessage rejects on that shape.
  event.waitUntil(
    handled.catch((error) => {
      port.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }),
  );
});
`,
  );

  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: outputDirectory,
    target: 'browser',
    format: 'esm',
    minify: false,
    sourcemap: 'none',
  });

  if (!result.success) {
    const diagnostics = result.logs.map((log) => log.message).join('\n');
    throw new Error(`Service Worker bundle failed:\n${diagnostics}`);
  }

  return Bun.file(join(outputDirectory, 'service-worker-entrypoint.js')).text();
}

/**
 * Builds a Service Worker bundle that uses `setupServiceWorker({ recover: true })`
 * instead of a manual `engine.recoverAll()` call. Used by the second smoke test
 * that verifies the `recover: true` option through the high-level helper.
 */
async function buildSetupServiceWorkerBundle(databaseName: string): Promise<string> {
  const directory = createTemporaryDirectory('setup-bundle');
  const entrypoint = join(directory, 'setup-service-worker-entrypoint.ts');
  const outputDirectory = join(directory, 'dist');
  await Bun.write(
    entrypoint,
    `
/// <reference lib="webworker" />
import {
  ENGINE_SLEEP_RESOLVER_COUNT_FOR_TESTING,
  ENGINE_WAIT_FOR_SLEEP_RESOLVER_FOR_TESTING,
} from ${JSON.stringify(engineModulePath)};
import { activity, workflow } from ${JSON.stringify(typesModulePath)};
import { IndexedDBStorage } from ${JSON.stringify(indexedDatabaseStorageModulePath)};
import { setupServiceWorker } from ${JSON.stringify(setupModulePath)};

const serviceWorker = self;
const instanceId = crypto.randomUUID();
let activityCount = 0;

const storage = new IndexedDBStorage(${JSON.stringify(databaseName)});

const countedActivity = activity({
  name: 'countedActivity',
  execute: async () => {
    activityCount++;
    const response = await fetch(new URL('/activity-count/increment', serviceWorker.location.origin), {
      method: 'POST',
    });
    if (!response.ok) throw new Error('activity count request failed: ' + response.status);
    return activityCount;
  },
});

const waitForSignalWorkflow = workflow({ name: 'wait-for-signal' }).execute(async function* (ctx) {
  const count = yield* ctx.run(countedActivity);
  const signalPayload = yield* ctx.waitForSignal('finish');
  return { count, signalPayload };
});

const sleepThenFinishWorkflow = workflow({ name: 'sleep-then-finish' }).execute(async function* (ctx) {
  yield* ctx.sleep(60 * 60 * 1000);
  return 'slept-then-finished';
});

// setupServiceWorker wires all four event listeners (install, activate, fetch,
// periodicsync) and calls engine.recoverAll() before the ready promise settles
// because recover: true is set. The message listener below awaits the returned
// promise so replies are only sent after recovery is confirmed complete.
const setup = setupServiceWorker({
  storage,
  pathPrefix: '/weft/',
  recover: true,
  register(engine) {
    engine.register(countedActivity);
    engine.register(waitForSignalWorkflow);
    engine.register(sleepThenFinishWorkflow);
  },
});

serviceWorker.addEventListener('message', (event) => {
  const port = event.ports[0];
  if (port === undefined) return;
  const message = event.data ?? {};
  const handled = (async () => {
    // Await the setup promise (which includes recovery) before replying.
    // This makes weft:test:instance a reliable recovery-completion barrier.
    const { engine, scheduler, storage } = await setup;
    if (message.type === 'weft:test:instance') {
      port.postMessage({ instanceId });
      return;
    }
    if (message.type === 'weft:test:timer-armed') {
      // Report whether a durable timer deadline has been checkpointed. The
      // scheduler persists each armed timer under a 'wf-deadline:' key, so the
      // presence of one proves the sleeping workflow reached its ctx.sleep
      // checkpoint (not merely that the workflow is 'running'). The timer-
      // recovery test waits on this before killing the worker so the kill
      // always lands AFTER the timer is durable — there is always something to
      // re-arm on recovery.
      let armed = false;
      for await (const _entry of storage.scan('wf-deadline:')) {
        armed = true;
        break;
      }
      port.postMessage({ armed });
      return;
    }
    if (message.type === 'weft:test:periodic-sync') {
      // Keep resolver readiness and timer delivery inside one message event.
      // Splitting them across messages releases the first event's waitUntil
      // lease and lets Chromium evict this Service Worker before the tick.
      await engine[ENGINE_WAIT_FOR_SLEEP_RESOLVER_FOR_TESTING]('setup-timer-workflow');
      const sleepResolverCount = engine[ENGINE_SLEEP_RESOLVER_COUNT_FOR_TESTING]();
      // Tick the scheduler with the clock advanced two hours past the one-hour
      // sleep deadline so the durable timer fires deterministically without a
      // real wall-clock wait. setupServiceWorker's own periodicsync listener
      // ticks at real Date.now(); driving the returned scheduler directly with
      // an explicit future time keeps the test hermetic.
      await scheduler.tick(Date.now() + 2 * 60 * 60 * 1000);
      port.postMessage({
        instanceId,
        sleepResolverCount,
        ticked: true,
      });
      return;
    }
    if (message.type === 'weft:test:timer-state') {
      let remainingTimerCount = 0;
      for await (const _entry of storage.scan('wf-deadline:')) {
        remainingTimerCount++;
      }
      const workflowState = await engine.get('setup-timer-workflow');
      port.postMessage({
        remainingTimerCount,
        workflowStatus: workflowState?.status ?? null,
      });
      return;
    }
    port.postMessage({ error: 'unknown message type' });
  })();
  // Every await above can reject. Without this the handler would simply never
  // reply, and sendWorkerMessage would report its generic 5s "Service Worker
  // message timed out" instead of the real cause — which is exactly how a
  // bounded readiness rejection would otherwise be lost. Posting { error }
  // reaches the caller because sendWorkerMessage rejects on that shape.
  event.waitUntil(
    handled.catch((error) => {
      port.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }),
  );
});
`,
  );

  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: outputDirectory,
    target: 'browser',
    format: 'esm',
    minify: false,
    sourcemap: 'none',
  });

  if (!result.success) {
    const diagnostics = result.logs.map((log) => log.message).join('\n');
    throw new Error(`Setup Service Worker bundle failed:\n${diagnostics}`);
  }

  return Bun.file(join(outputDirectory, 'setup-service-worker-entrypoint.js')).text();
}

function createSmokeServer(serviceWorkerSource: string): { origin: string } {
  let activityCount = 0;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/') {
        return new Response('<!doctype html><title>Weft Service Worker smoke</title>', {
          headers: { 'Content-Type': 'text/html' },
        });
      }
      if (url.pathname === '/service-worker.js') {
        return new Response(serviceWorkerSource, {
          headers: { 'Content-Type': 'text/javascript' },
        });
      }
      if (url.pathname === '/activity-count/increment' && request.method === 'POST') {
        activityCount++;
        return Response.json({ count: activityCount });
      }
      if (url.pathname === '/activity-count') {
        return Response.json({ count: activityCount });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { origin: server.url.href.replace(/\/$/, '') };
}

/**
 * One Chromium process for the whole file, matching the other browser smoke
 * suites (`indexeddb-browser`, `http-client-browser`), which launch in
 * `beforeAll` and close in `afterAll`. Each test still gets its own context.
 *
 * The explicit `timeout` is deliberately below this file's 30 s per-test
 * timeout. Playwright's own default launch timeout is 30 s — the same value —
 * so a launch slow enough to matter expires no earlier than the test deadline
 * and Bun reports only "this test timed out", naming nothing.
 *
 * That 20 s is a *backstop*, not the guarantee: it is independent of the test
 * budget, so a slow bundle build followed by a hung launch still overruns the
 * 30 s deadline (an 11 s build plus a 20 s launch is 31 s). Only the phase
 * budget accounts for time already spent, so the launch is wrapped too. The
 * catch is kept because the failure it explains — Chromium not installed —
 * needs an actionable message either way; the phase error arrives as its
 * `cause`.
 */
async function createIsolatedContext(withinPhase: PhaseRunner): Promise<BrowserContext> {
  if (sharedBrowser === null) {
    const launch = chromium.launch({ timeout: 20_000 });
    let launchAbandoned = false;
    // A launch that lands between the phase ceiling and its own 20 s timeout
    // resolves after the wrapper already rejected, so it is never assigned to
    // `sharedBrowser` and `afterAll` cannot close it — stranding a Chromium
    // process for the rest of the run. Close it on arrival instead.
    void launch.then(
      (browser) => {
        if (launchAbandoned) void browser.close();
      },
      // A rejected launch has no process to close; the failure surfaces below.
      () => {},
    );

    try {
      sharedBrowser = await withinPhase('chromium launch', launch);
    } catch (error) {
      launchAbandoned = true;
      throw new Error(
        'Chromium failed to launch for Playwright. If it is not installed, run `bunx playwright install chromium` and retry with WEFT_BROWSER_SMOKE=1.',
        { cause: error },
      );
    }
  }

  const creation = sharedBrowser.newContext();
  let creationAbandoned = false;
  // Same hazard as the launch, and worse than bookkeeping here: a context that
  // arrives after its phase expired never reaches `contexts`, so `afterEach`
  // cannot close it and it keeps its storage partition and Service Worker
  // registration alive until `afterAll`. These tests rely on per-context
  // isolation, so a stray one can reach the tests that follow.
  void creation.then(
    (late) => {
      if (creationAbandoned) void late.close();
    },
    () => {},
  );

  let context: BrowserContext;
  try {
    context = await withinPhase('browser context creation', creation);
  } catch (error) {
    creationAbandoned = true;
    throw error;
  }

  contexts.push(context);
  return context;
}

/** Per-test deadline. Every test in this file declares exactly this budget. */
const SMOKE_TEST_TIMEOUT_MS = 30_000;

/**
 * Slice of the test budget held back so a phase rejection has time to unwind
 * and print before Bun's own per-test deadline fires and replaces it with an
 * anonymous "this test timed out".
 */
const PHASE_REPORTING_RESERVE_MS = 2_000;

/** Ceiling for any single phase, so one wedged step cannot eat the whole budget. */
const MAXIMUM_PHASE_MS = 15_000;

/** Bounds one step of a smoke test and names it on expiry. */
type PhaseRunner = <T>(phase: string, operation: Promise<T>) => Promise<T>;

/**
 * Opens a phase budget for one test and returns the runner that spends it.
 *
 * Chromium control, Service Worker registration, and page `fetch` round trips
 * are all unbounded awaits. When one of them stalls on a loaded two-core CI
 * runner, the suite reports nothing but "this test timed out after 30000ms" —
 * no phase, no stack, nothing to triage from a log (this is the open half of
 * #883). Bounding each step turns that into a failure that names the step.
 *
 * The bound is the *remaining* test budget, not a fixed per-phase constant. A
 * fixed constant does not actually guarantee a named failure: two phases each
 * stalling just under a 15 s bound sum past the 30 s test deadline, and Bun's
 * anonymous timeout wins anyway. Deriving each bound from what is left of the
 * budget makes the phase error win the race no matter how many phases ran
 * before it. These bounds only ever *shorten* how long a wedged step is
 * tolerated; the per-test timeout itself is unchanged.
 */
function beginPhaseBudget(diagnostics: string[]): PhaseRunner {
  const budgetExpiresAt = Date.now() + SMOKE_TEST_TIMEOUT_MS - PHASE_REPORTING_RESERVE_MS;

  // The `serviceworker` / `serviceworker-close` entries are the evidence that
  // says whether Chromium evicted the worker out from under a failing step,
  // which is the leading hypothesis for #883. Read at throw time so entries
  // logged during the phase are included.
  const describeDiagnostics = (): string =>
    `\nBrowser diagnostics:\n${diagnostics.length === 0 ? '<none captured>' : diagnostics.join('\n')}`;

  return async function withinPhase<T>(phase: string, operation: Promise<T>): Promise<T> {
    const remainingBudgetMs = Math.max(0, budgetExpiresAt - Date.now());
    // A zero bound still rejects (on the next tick) naming the phase, which is
    // strictly better than yielding the remainder to an anonymous timeout.
    const boundMs = Math.min(MAXIMUM_PHASE_MS, remainingBudgetMs);
    // Several steps nest a tighter, more specific bound inside their phase: the
    // 5 s `sendWorkerMessage` transport timeout, and inside the periodic-sync
    // message, the 3 s sleep-resolver readiness bound that names the workflow
    // (SLEEP_RESOLVER_READY_WAIT_TIMEOUT_MS_FOR_TESTING). Those produce better
    // messages than a phase name, and they normally win. When the budget is
    // nearly spent the outer bound necessarily preempts them — there is no way
    // to hold a 3 s inner window open inside 1 s of remaining budget. Say so,
    // so the failure reads as "the budget was gone before this step" rather
    // than "this step hung".
    const budgetLimited = boundMs < MAXIMUM_PHASE_MS;
    let expire: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      expire = setTimeout(
        () =>
          reject(
            new Error(
              `Browser smoke phase timed out: ${phase} (bound ${boundMs} ms; ${remainingBudgetMs} ms of the test budget remained)` +
                (budgetLimited
                  ? '\nThe bound was shortened by the remaining test budget, not by this step — earlier phases consumed it, and any tighter timeout nested inside this phase may have been preempted. Look at what ran before this.'
                  : '') +
                describeDiagnostics(),
            ),
          ),
        boundMs,
      );
    });

    try {
      return await Promise.race([operation, expiry]);
    } catch (error) {
      // Diagnostics matter just as much when a phase fails *promptly* — a
      // rejected Service Worker script reports the real cause through the page
      // console, not through the Playwright error. Attaching them here covers
      // every phase, which is why `registerServiceWorker` no longer needs its
      // own catch.
      // Phases nest (`waitForTimerArmed` wraps `sendWorkerMessage`), so skip
      // anything this runner already annotated — otherwise the inner failure
      // gets a second wrapper and the diagnostics block prints twice.
      if (error instanceof Error && error.message.startsWith('Browser smoke phase ')) {
        throw error;
      }
      throw new Error(`Browser smoke phase failed: ${phase}${describeDiagnostics()}`, {
        cause: error,
      });
    } finally {
      clearTimeout(expire);
    }
  };
}

async function registerServiceWorker(
  page: Page,
  origin: string,
  withinPhase: PhaseRunner,
): Promise<void> {
  await withinPhase('page.goto', page.goto(origin));
  await withinPhase(
    'service worker registration',
    page.evaluate(async () => {
      const registration = await navigator.serviceWorker.register('/service-worker.js', {
        type: 'module',
      });
      await navigator.serviceWorker.ready;
      if (navigator.serviceWorker.controller !== null) return;
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        });
        void registration.update();
      });
    }),
  );
}

// The internal 5 s transport bound is fixed, so it does not account for time
// already spent: with less than 5 s of the test budget left, a stalled message
// reaches Bun's deadline before its own timeout fires. Routing every message
// through the phase runner caps it by whatever budget remains.
async function sendWorkerMessage<T>(
  page: Page,
  message: Record<string, unknown>,
  withinPhase: PhaseRunner,
): Promise<T> {
  const roundTrip = page.evaluate(
    (workerMessage) =>
      new Promise<T>((resolve, reject) => {
        const controller = navigator.serviceWorker.controller;
        if (controller === null) {
          reject(new Error('page is not controlled by a Service Worker'));
          return;
        }
        const channel = new MessageChannel();
        const timeout = setTimeout(() => {
          reject(new Error(`Service Worker message timed out: ${String(workerMessage['type'])}`));
        }, 5_000);
        channel.port1.onmessage = (event) => {
          clearTimeout(timeout);
          if (
            event.data !== null &&
            typeof event.data === 'object' &&
            typeof (event.data as { error?: unknown }).error === 'string'
          ) {
            reject(new Error((event.data as { error: string }).error));
            return;
          }
          resolve(event.data as T);
        };
        controller.postMessage(workerMessage, [channel.port2]);
      }),
    message,
  );
  return withinPhase(`worker message: ${String(message['type'])}`, roundTrip);
}

// Poll the worker until a durable timer deadline has been checkpointed. The
// `weft:test:timer-armed` handler scans storage for a 'wf-deadline:' key, which
// only exists once a workflow has reached its ctx.sleep checkpoint. This is the
// barrier the timer-recovery test waits on before killing the worker, so the
// kill cannot race the sleep checkpoint write — recovery always has a real timer
// to re-arm. Uses an iteration counter rather than a Date.now() deadline so
// Chromium timer throttling can't starve the loop.
async function waitForTimerArmed(page: Page, withinPhase: PhaseRunner): Promise<void> {
  // The iteration counter caps *attempts*, not elapsed time — each attempt is a
  // full MessageChannel round trip plus an IndexedDB scan, so 200 slow-but-
  // successful attempts can outlast the test deadline on their own. The phase
  // wrapper supplies the wall-clock ceiling the counter cannot.
  await withinPhase(
    'wait for durable sleep timer to be armed',
    (async () => {
      let attempts = 0;
      while (attempts++ < 200) {
        const { armed } = await sendWorkerMessage<{ armed: boolean }>(
          page,
          { type: 'weft:test:timer-armed' },
          withinPhase,
        );
        if (armed) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(
        `Timed out waiting for the durable sleep timer to be armed after ${attempts} attempts; no 'wf-deadline:' key ever appeared`,
      );
    })(),
  );
}

async function waitForActivityCount(
  origin: string,
  expectedCount: number,
  withinPhase: PhaseRunner,
): Promise<void> {
  // The 5 s deadline is only checked *between* fetches, so a single wedged
  // request still hangs forever. The phase wrapper bounds the whole loop.
  await withinPhase(
    `wait for activity count ${expectedCount}`,
    (async () => {
      const deadline = Date.now() + 5_000;
      let actualCount = 0;
      while (Date.now() < deadline) {
        const response = await fetch(`${origin}/activity-count`);
        const body = (await response.json()) as { count: number };
        actualCount = body.count;
        if (actualCount === expectedCount) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Timed out waiting for activity count ${expectedCount}; got ${actualCount}`);
    })(),
  );
}

// Direct, single-shot read of the host's activity counter. `waitForActivityCount`
// resolves the moment the count first *reaches* its target, so it cannot catch a
// duplicate activity that lands *later* (e.g. a recovery re-execution arriving
// after the workflow result is observed). Use this after a quiescence point to
// assert the count is *exactly* N and has not crept past it.
async function getActivityCount(origin: string, withinPhase: PhaseRunner): Promise<number> {
  return withinPhase(
    'read activity count',
    (async () => {
      const response = await fetch(`${origin}/activity-count`);
      const body = (await response.json()) as { count: number };
      return body.count;
    })(),
  );
}

async function waitForPageWorkflowStatus(
  page: Page,
  workflowId: string,
  status: string,
  withinPhase: PhaseRunner,
): Promise<void> {
  // Each iteration's in-page `fetch` is itself unbounded — it is served by the
  // Service Worker, so an evicted or wedged worker stalls one iteration
  // forever and the attempt counter never advances. That is the shape that
  // produces a bare "this test timed out" with nothing named.
  const polling = page.evaluate(
    async ({ expectedStatus, id }) => {
      // Use an iteration counter instead of Date.now() so Chromium timer
      // throttling under background-tab / CDP conditions cannot stall the loop.
      // 200 iterations × 25 ms ≈ 5 000 ms equivalent.
      let remainingAttempts = 200;
      let actualStatus = '<missing>';
      while (remainingAttempts-- > 0) {
        const response = await fetch(`/weft/v1/workflows/${encodeURIComponent(id)}`);
        if (response.ok) {
          const body = (await response.json()) as { status?: string };
          actualStatus = body.status ?? '<missing-status>';
          if (actualStatus === expectedStatus) return;
        } else {
          actualStatus = `${response.status} ${await response.text()}`;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(
        `Timed out waiting for workflow ${id} to reach ${expectedStatus}; got ${actualStatus}`,
      );
    },
    { expectedStatus: status, id: workflowId },
  );
  await withinPhase(`wait for workflow ${workflowId} to reach ${status}`, polling);
}

async function stopServiceWorkers(
  context: BrowserContext,
  page: Page,
  withinPhase: PhaseRunner,
): Promise<void> {
  const session = await withinPhase('CDP session', context.newCDPSession(page));
  await withinPhase('ServiceWorker.enable', session.send('ServiceWorker.enable'));
  await withinPhase('ServiceWorker.stopAllWorkers', session.send('ServiceWorker.stopAllWorkers'));
  await withinPhase('CDP detach', session.detach());
}

describe('Service Worker browser smoke', () => {
  browserSmokeTest(
    'runs lifecycle, fetch, periodic-sync, and restart recovery in Chromium',
    async () => {
      // Declared before the budget so a phase timeout can report whatever the
      // page and worker had logged by then; the listeners below append to it.
      const browserDiagnostics: string[] = [];
      const withinPhase = beginPhaseBudget(browserDiagnostics);
      const serviceWorkerSource = await withinPhase(
        'bundle build',
        buildServiceWorkerBundle(`weft-browser-smoke-${crypto.randomUUID()}`),
      );
      const { origin } = createSmokeServer(serviceWorkerSource);
      const context = await createIsolatedContext(withinPhase);
      const page = await withinPhase('page creation', context.newPage());
      page.on('console', (message) => browserDiagnostics.push(`console:${message.text()}`));
      page.on('pageerror', (error) => browserDiagnostics.push(`pageerror:${error.message}`));
      context.on('serviceworker', (worker) => {
        browserDiagnostics.push(`serviceworker:${worker.url()}`);
        worker.on('close', () => browserDiagnostics.push(`serviceworker-close:${worker.url()}`));
      });

      await registerServiceWorker(page, origin, withinPhase);

      const lifecycle = await sendWorkerMessage<{ lifecycleEvents: string[] }>(
        page,
        { type: 'weft:test:lifecycle' },
        withinPhase,
      );
      expect(lifecycle.lifecycleEvents).toContain('install');
      expect(lifecycle.lifecycleEvents).toContain('activate');

      const delegatedHealth = await withinPhase(
        'delegated health fetch',
        page.evaluate(async () => {
          const response = await fetch('/weft/v1/health');
          return {
            status: response.status,
            body: await response.text(),
          };
        }),
      );
      const directHealth = await sendWorkerMessage<{ status: number; body: string }>(
        page,
        { type: 'weft:test:direct-health' },
        withinPhase,
      );
      expect(delegatedHealth).toEqual(directHealth);

      const timerWorkflow = await withinPhase(
        'start timer workflow',
        page.evaluate(async () => {
          const response = await fetch('/weft/v1/workflows', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'timer-workflow',
              input: null,
              id: 'timer-workflow',
            }),
          });
          if (!response.ok) {
            throw new Error(
              `timer workflow start failed: ${response.status} ${await response.text()}`,
            );
          }
          return (await response.json()) as { id: string };
        }),
      );
      expect(timerWorkflow.id).toBe('timer-workflow');
      await waitForPageWorkflowStatus(page, timerWorkflow.id, 'running', withinPhase);
      await sendWorkerMessage(page, { type: 'weft:test:periodic-sync' }, withinPhase);
      await expect(
        withinPhase(
          'read timer workflow result',
          page.evaluate(async () => {
            const response = await fetch('/weft/v1/workflows/timer-workflow/result');
            return response.json();
          }),
        ),
      ).resolves.toEqual({ result: 'timer-fired' });

      const parkedWorkflow = await withinPhase(
        'start parked workflow',
        page.evaluate(async () => {
          const response = await fetch('/weft/v1/workflows', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'activity-then-signal',
              input: null,
              id: 'parked-workflow',
            }),
          });
          if (!response.ok) {
            throw new Error(
              `parked workflow start failed: ${response.status} ${await response.text()}`,
            );
          }
          return (await response.json()) as { id: string };
        }),
      );
      expect(parkedWorkflow.id).toBe('parked-workflow');
      await waitForPageWorkflowStatus(page, parkedWorkflow.id, 'running', withinPhase);
      await waitForActivityCount(origin, 1, withinPhase);

      const instanceBeforeStop = await sendWorkerMessage<{ instanceId: string }>(
        page,
        { type: 'weft:test:instance' },
        withinPhase,
      );
      await stopServiceWorkers(context, page, withinPhase);

      // Confirm a new worker identity (and therefore completed recovery) BEFORE
      // sending the signal. The message handler in the bundle gates on
      // `recoveryReady`, so a successful `weft:test:instance` reply proves the
      // new worker has finished `engine.recoverAll()` and the resumed generator
      // is live. Sending the signal before this barrier risked delivering it
      // before the parked workflow was re-activated in the new worker.
      const instanceAfterStop = await sendWorkerMessage<{ instanceId: string }>(
        page,
        { type: 'weft:test:instance' },
        withinPhase,
      );
      expect(instanceAfterStop.instanceId).not.toBe(instanceBeforeStop.instanceId);

      await withinPhase(
        'signal parked workflow',
        page.evaluate(async () => {
          const response = await fetch('/weft/v1/workflows/parked-workflow/signal/finish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload: 'done' }),
          });
          if (!response.ok) throw new Error(`signal failed: ${response.status}`);
        }),
      );

      await expect(
        withinPhase(
          'read parked workflow result',
          page.evaluate(async () => {
            const response = await fetch('/weft/v1/workflows/parked-workflow/result');
            return response.json();
          }),
        ),
      ).resolves.toEqual({
        result: {
          count: 1,
          signalPayload: 'done',
        },
      });
      // The parked-workflow result has resolved (a quiescence point) and the
      // activity already ran exactly once before the kill, so read the counter
      // directly rather than polling: a direct equality read catches a late
      // duplicate from a recovery re-execution that `waitForActivityCount` would
      // silently pass the instant the count first reached 1.
      expect(await getActivityCount(origin, withinPhase)).toBe(1);
    },
    { timeout: SMOKE_TEST_TIMEOUT_MS },
  );

  browserSmokeTest(
    'setupServiceWorker({ recover: true }) auto-recovers a parked workflow after SW restart',
    async () => {
      // Declared before the budget so a phase timeout can report whatever the
      // page and worker had logged by then; the listeners below append to it.
      const browserDiagnostics: string[] = [];
      const withinPhase = beginPhaseBudget(browserDiagnostics);
      const serviceWorkerSource = await withinPhase(
        'bundle build',
        buildSetupServiceWorkerBundle(`weft-setup-smoke-${crypto.randomUUID()}`),
      );
      const { origin } = createSmokeServer(serviceWorkerSource);
      const context = await createIsolatedContext(withinPhase);
      const page = await withinPhase('page creation', context.newPage());
      page.on('console', (message) => browserDiagnostics.push(`console:${message.text()}`));
      page.on('pageerror', (error) => browserDiagnostics.push(`pageerror:${error.message}`));
      context.on('serviceworker', (worker) => {
        browserDiagnostics.push(`serviceworker:${worker.url()}`);
        worker.on('close', () => browserDiagnostics.push(`serviceworker-close:${worker.url()}`));
      });

      await registerServiceWorker(page, origin, withinPhase);

      // Start a workflow that parks on a signal (after running one activity).
      const parkedWorkflow = await withinPhase(
        'start parked workflow',
        page.evaluate(async () => {
          const response = await fetch('/weft/v1/workflows', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'wait-for-signal',
              input: null,
              id: 'setup-parked-workflow',
            }),
          });
          if (!response.ok) {
            throw new Error(
              `parked workflow start failed: ${response.status} ${await response.text()}`,
            );
          }
          return (await response.json()) as { id: string };
        }),
      );
      expect(parkedWorkflow.id).toBe('setup-parked-workflow');
      await waitForPageWorkflowStatus(page, parkedWorkflow.id, 'running', withinPhase);
      // Wait for the activity to complete so the workflow is parked on the signal.
      await waitForActivityCount(origin, 1, withinPhase);

      // Record the current worker identity before stopping.
      const instanceBeforeStop = await sendWorkerMessage<{ instanceId: string }>(
        page,
        { type: 'weft:test:instance' },
        withinPhase,
      );

      // Kill the Service Worker via CDP — simulates the browser evicting the worker.
      await stopServiceWorkers(context, page, withinPhase);

      // Confirm a new worker identity BEFORE sending the signal. Because the
      // message handler in the bundle awaits the `setup` promise (which includes
      // `engine.recoverAll()` via `recover: true`), a successful
      // `weft:test:instance` reply is proof that recovery completed and the
      // parked workflow's generator is live in the new worker.
      const instanceAfterStop = await sendWorkerMessage<{ instanceId: string }>(
        page,
        { type: 'weft:test:instance' },
        withinPhase,
      );
      expect(instanceAfterStop.instanceId).not.toBe(instanceBeforeStop.instanceId);

      // Send the signal — the recovered worker must be ready to resume.
      await withinPhase(
        'signal parked workflow',
        page.evaluate(async () => {
          const response = await fetch('/weft/v1/workflows/setup-parked-workflow/signal/finish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload: 'recovered' }),
          });
          if (!response.ok) throw new Error(`signal failed: ${response.status}`);
        }),
      );

      // Confirm the workflow completed with the expected result.
      await expect(
        withinPhase(
          'read parked workflow result',
          page.evaluate(async () => {
            const response = await fetch('/weft/v1/workflows/setup-parked-workflow/result');
            return response.json();
          }),
        ),
      ).resolves.toEqual({
        result: {
          count: 1,
          signalPayload: 'recovered',
        },
      });
      // Activity must have run exactly once: recovery must resume from the
      // checkpoint, not re-execute the already-completed activity. Read the
      // counter directly *after* the result resolves (a quiescence point) and
      // assert strict equality — a polling wait would pass the instant the count
      // reached 1 and miss a late duplicate from a recovery re-execution.
      expect(await getActivityCount(origin, withinPhase)).toBe(1);
    },
    { timeout: SMOKE_TEST_TIMEOUT_MS },
  );

  browserSmokeTest(
    'setupServiceWorker({ recover: true }) resumes a sleeping timer workflow via periodic sync after SW restart',
    async () => {
      // Declared before the budget so a phase timeout can report whatever the
      // page and worker had logged by then; the listeners below append to it.
      const browserDiagnostics: string[] = [];
      const withinPhase = beginPhaseBudget(browserDiagnostics);
      const serviceWorkerSource = await withinPhase(
        'bundle build',
        buildSetupServiceWorkerBundle(`weft-setup-timer-smoke-${crypto.randomUUID()}`),
      );
      const { origin } = createSmokeServer(serviceWorkerSource);
      const context = await createIsolatedContext(withinPhase);
      const page = await withinPhase('page creation', context.newPage());
      page.on('console', (message) => browserDiagnostics.push(`console:${message.text()}`));
      page.on('pageerror', (error) => browserDiagnostics.push(`pageerror:${error.message}`));
      context.on('serviceworker', (worker) => {
        browserDiagnostics.push(`serviceworker:${worker.url()}`);
        worker.on('close', () => browserDiagnostics.push(`serviceworker-close:${worker.url()}`));
      });

      await registerServiceWorker(page, origin, withinPhase);

      // Start a workflow that parks on ctx.sleep(). This is a DISTINCT recovery
      // path from the signal-parked case: a sleeping workflow only advances when
      // a periodic-sync tick fires the durable timer — there is no external
      // signal to drive it. Recovery must re-arm that timer in the new worker.
      const timerWorkflow = await withinPhase(
        'start sleeping workflow',
        page.evaluate(async () => {
          const response = await fetch('/weft/v1/workflows', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'sleep-then-finish',
              input: null,
              id: 'setup-timer-workflow',
            }),
          });
          if (!response.ok) {
            throw new Error(
              `timer workflow start failed: ${response.status} ${await response.text()}`,
            );
          }
          return (await response.json()) as { id: string };
        }),
      );
      expect(timerWorkflow.id).toBe('setup-timer-workflow');
      await waitForPageWorkflowStatus(page, timerWorkflow.id, 'running', withinPhase);
      // 'running' alone does not prove the ctx.sleep timer is durable. Wait for
      // the deadline to be checkpointed so the kill below always lands AFTER the
      // timer is persisted — recovery then has a real timer to re-arm, and the
      // test exercises the recovery path it claims rather than racing the
      // checkpoint write.
      await waitForTimerArmed(page, withinPhase);

      // Record the current worker identity before stopping.
      const instanceBeforeStop = await sendWorkerMessage<{ instanceId: string }>(
        page,
        { type: 'weft:test:instance' },
        withinPhase,
      );

      // Kill the Service Worker via CDP while the workflow is still sleeping.
      await stopServiceWorkers(context, page, withinPhase);

      // A new worker identity proves recovery (via recover: true) completed and
      // the sleeping workflow's durable timer was re-armed in the fresh worker.
      const instanceAfterStop = await sendWorkerMessage<{ instanceId: string }>(
        page,
        { type: 'weft:test:instance' },
        withinPhase,
      );
      expect(instanceAfterStop.instanceId).not.toBe(instanceBeforeStop.instanceId);

      // Drive a periodic-sync tick with the scheduler clock advanced past the
      // timer deadline. The same recovered worker instance must wait for the
      // re-armed sleep resolver, fire the timer, and run to completion under
      // one message event's waitUntil lease.
      const tickResult = await sendWorkerMessage<{
        instanceId: string;
        sleepResolverCount: number;
        ticked: boolean;
      }>(page, { type: 'weft:test:periodic-sync' }, withinPhase);
      expect(tickResult).toEqual({
        instanceId: instanceAfterStop.instanceId,
        sleepResolverCount: 1,
        ticked: true,
      });

      // engine.fireTimer() acknowledges a sleep timer only after the awakened
      // workflow commits later durable progress. This workflow terminates
      // immediately after sleeping, so the completed state and timer deletion
      // must both be observable as soon as the tick reply arrives.
      const timerState = await sendWorkerMessage<{
        remainingTimerCount: number;
        workflowStatus: string | null;
      }>(page, { type: 'weft:test:timer-state' }, withinPhase);
      expect(timerState).toEqual({
        remainingTimerCount: 0,
        workflowStatus: 'completed',
      });

      await expect(
        withinPhase(
          'read sleeping workflow result',
          page.evaluate(async () => {
            const response = await fetch('/weft/v1/workflows/setup-timer-workflow/result');
            return response.json();
          }),
        ),
      ).resolves.toEqual({ result: 'slept-then-finished' });

      // This workflow runs no activity, so the counter must still be exactly 0 —
      // recovery must not synthesize spurious activity executions.
      expect(await getActivityCount(origin, withinPhase)).toBe(0);
    },
    { timeout: SMOKE_TEST_TIMEOUT_MS },
  );
});
