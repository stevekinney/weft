import { afterEach, describe, expect, it } from 'bun:test';
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
const browsers: Browser[] = [];
let server: Bun.Server<unknown> | null = null;

afterEach(async () => {
  if (server !== null) {
    await Promise.resolve(server.stop(true));
    server = null;
  }
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
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
  event.waitUntil((async () => {
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
  })());
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
  event.waitUntil((async () => {
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
      // Tick the scheduler with the clock advanced two hours past the one-hour
      // sleep deadline so the durable timer fires deterministically without a
      // real wall-clock wait. setupServiceWorker's own periodicsync listener
      // ticks at real Date.now(); driving the returned scheduler directly with
      // an explicit future time keeps the test hermetic.
      await scheduler.tick(Date.now() + 2 * 60 * 60 * 1000);
      port.postMessage({ ticked: true });
      return;
    }
    if (message.type === 'weft:test:sleep-resolver-count') {
      port.postMessage({
        count: engine[ENGINE_SLEEP_RESOLVER_COUNT_FOR_TESTING](),
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
  })());
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

async function launchBrowser(): Promise<Browser> {
  try {
    const browser = await chromium.launch();
    browsers.push(browser);
    return browser;
  } catch (error) {
    throw new Error(
      'Chromium is not installed for Playwright. Run `bunx playwright install chromium` and retry with WEFT_BROWSER_SMOKE=1.',
      { cause: error },
    );
  }
}

async function registerServiceWorker(
  page: Page,
  origin: string,
  diagnostics: string[],
): Promise<void> {
  await page.goto(origin);
  try {
    await page.evaluate(async () => {
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
    });
  } catch (error) {
    throw new Error(
      `Service Worker registration failed. Browser diagnostics:\n${diagnostics.join('\n')}`,
      { cause: error },
    );
  }
}

async function sendWorkerMessage<T>(page: Page, message: Record<string, unknown>): Promise<T> {
  return page.evaluate(
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
}

// Poll the worker until a durable timer deadline has been checkpointed. The
// `weft:test:timer-armed` handler scans storage for a 'wf-deadline:' key, which
// only exists once a workflow has reached its ctx.sleep checkpoint. This is the
// barrier the timer-recovery test waits on before killing the worker, so the
// kill cannot race the sleep checkpoint write — recovery always has a real timer
// to re-arm. Uses an iteration counter rather than a Date.now() deadline so
// Chromium timer throttling can't starve the loop.
async function waitForTimerArmed(page: Page): Promise<void> {
  let remainingAttempts = 200;
  while (remainingAttempts-- > 0) {
    const { armed } = await sendWorkerMessage<{ armed: boolean }>(page, {
      type: 'weft:test:timer-armed',
    });
    if (armed) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for the durable sleep timer to be armed');
}

async function waitForSleepResolverReady(page: Page): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const { count } = await sendWorkerMessage<{ count: number }>(page, {
      type: 'weft:test:sleep-resolver-count',
    });
    if (count === 1) return;
    if (attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('Recovered workflow did not register its sleep resolver');
}

async function waitForActivityCount(origin: string, expectedCount: number): Promise<void> {
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
}

// Direct, single-shot read of the host's activity counter. `waitForActivityCount`
// resolves the moment the count first *reaches* its target, so it cannot catch a
// duplicate activity that lands *later* (e.g. a recovery re-execution arriving
// after the workflow result is observed). Use this after a quiescence point to
// assert the count is *exactly* N and has not crept past it.
async function getActivityCount(origin: string): Promise<number> {
  const response = await fetch(`${origin}/activity-count`);
  const body = (await response.json()) as { count: number };
  return body.count;
}

async function waitForPageWorkflowStatus(
  page: Page,
  workflowId: string,
  status: string,
): Promise<void> {
  await page.evaluate(
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
}

async function stopServiceWorkers(context: BrowserContext, page: Page): Promise<void> {
  const session = await context.newCDPSession(page);
  await session.send('ServiceWorker.enable');
  await session.send('ServiceWorker.stopAllWorkers');
  await session.detach();
}

describe('Service Worker browser smoke', () => {
  browserSmokeTest(
    'runs lifecycle, fetch, periodic-sync, and restart recovery in Chromium',
    async () => {
      const serviceWorkerSource = await buildServiceWorkerBundle(
        `weft-browser-smoke-${crypto.randomUUID()}`,
      );
      const { origin } = createSmokeServer(serviceWorkerSource);
      const browser = await launchBrowser();
      const context = await browser.newContext();
      const page = await context.newPage();
      const browserDiagnostics: string[] = [];
      page.on('console', (message) => browserDiagnostics.push(`console:${message.text()}`));
      page.on('pageerror', (error) => browserDiagnostics.push(`pageerror:${error.message}`));
      context.on('serviceworker', (worker) => {
        browserDiagnostics.push(`serviceworker:${worker.url()}`);
        worker.on('close', () => browserDiagnostics.push(`serviceworker-close:${worker.url()}`));
      });

      await registerServiceWorker(page, origin, browserDiagnostics);

      const lifecycle = await sendWorkerMessage<{ lifecycleEvents: string[] }>(page, {
        type: 'weft:test:lifecycle',
      });
      expect(lifecycle.lifecycleEvents).toContain('install');
      expect(lifecycle.lifecycleEvents).toContain('activate');

      const delegatedHealth = await page.evaluate(async () => {
        const response = await fetch('/weft/v1/health');
        return {
          status: response.status,
          body: await response.text(),
        };
      });
      const directHealth = await sendWorkerMessage<{ status: number; body: string }>(page, {
        type: 'weft:test:direct-health',
      });
      expect(delegatedHealth).toEqual(directHealth);

      const timerWorkflow = await page.evaluate(async () => {
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
      });
      expect(timerWorkflow.id).toBe('timer-workflow');
      await waitForPageWorkflowStatus(page, timerWorkflow.id, 'running');
      await sendWorkerMessage(page, { type: 'weft:test:periodic-sync' });
      await expect(
        page.evaluate(async () => {
          const response = await fetch('/weft/v1/workflows/timer-workflow/result');
          return response.json();
        }),
      ).resolves.toEqual({ result: 'timer-fired' });

      const parkedWorkflow = await page.evaluate(async () => {
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
      });
      expect(parkedWorkflow.id).toBe('parked-workflow');
      await waitForPageWorkflowStatus(page, parkedWorkflow.id, 'running');
      await waitForActivityCount(origin, 1);

      const instanceBeforeStop = await sendWorkerMessage<{ instanceId: string }>(page, {
        type: 'weft:test:instance',
      });
      await stopServiceWorkers(context, page);

      // Confirm a new worker identity (and therefore completed recovery) BEFORE
      // sending the signal. The message handler in the bundle gates on
      // `recoveryReady`, so a successful `weft:test:instance` reply proves the
      // new worker has finished `engine.recoverAll()` and the resumed generator
      // is live. Sending the signal before this barrier risked delivering it
      // before the parked workflow was re-activated in the new worker.
      const instanceAfterStop = await sendWorkerMessage<{ instanceId: string }>(page, {
        type: 'weft:test:instance',
      });
      expect(instanceAfterStop.instanceId).not.toBe(instanceBeforeStop.instanceId);

      await page.evaluate(async () => {
        const response = await fetch('/weft/v1/workflows/parked-workflow/signal/finish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payload: 'done' }),
        });
        if (!response.ok) throw new Error(`signal failed: ${response.status}`);
      });

      await expect(
        page.evaluate(async () => {
          const response = await fetch('/weft/v1/workflows/parked-workflow/result');
          return response.json();
        }),
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
      expect(await getActivityCount(origin)).toBe(1);
    },
    { timeout: 30_000 },
  );

  browserSmokeTest(
    'setupServiceWorker({ recover: true }) auto-recovers a parked workflow after SW restart',
    async () => {
      const serviceWorkerSource = await buildSetupServiceWorkerBundle(
        `weft-setup-smoke-${crypto.randomUUID()}`,
      );
      const { origin } = createSmokeServer(serviceWorkerSource);
      const browser = await launchBrowser();
      const context = await browser.newContext();
      const page = await context.newPage();
      const browserDiagnostics: string[] = [];
      page.on('console', (message) => browserDiagnostics.push(`console:${message.text()}`));
      page.on('pageerror', (error) => browserDiagnostics.push(`pageerror:${error.message}`));
      context.on('serviceworker', (worker) => {
        browserDiagnostics.push(`serviceworker:${worker.url()}`);
        worker.on('close', () => browserDiagnostics.push(`serviceworker-close:${worker.url()}`));
      });

      await registerServiceWorker(page, origin, browserDiagnostics);

      // Start a workflow that parks on a signal (after running one activity).
      const parkedWorkflow = await page.evaluate(async () => {
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
      });
      expect(parkedWorkflow.id).toBe('setup-parked-workflow');
      await waitForPageWorkflowStatus(page, parkedWorkflow.id, 'running');
      // Wait for the activity to complete so the workflow is parked on the signal.
      await waitForActivityCount(origin, 1);

      // Record the current worker identity before stopping.
      const instanceBeforeStop = await sendWorkerMessage<{ instanceId: string }>(page, {
        type: 'weft:test:instance',
      });

      // Kill the Service Worker via CDP — simulates the browser evicting the worker.
      await stopServiceWorkers(context, page);

      // Confirm a new worker identity BEFORE sending the signal. Because the
      // message handler in the bundle awaits the `setup` promise (which includes
      // `engine.recoverAll()` via `recover: true`), a successful
      // `weft:test:instance` reply is proof that recovery completed and the
      // parked workflow's generator is live in the new worker.
      const instanceAfterStop = await sendWorkerMessage<{ instanceId: string }>(page, {
        type: 'weft:test:instance',
      });
      expect(instanceAfterStop.instanceId).not.toBe(instanceBeforeStop.instanceId);

      // Send the signal — the recovered worker must be ready to resume.
      await page.evaluate(async () => {
        const response = await fetch('/weft/v1/workflows/setup-parked-workflow/signal/finish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payload: 'recovered' }),
        });
        if (!response.ok) throw new Error(`signal failed: ${response.status}`);
      });

      // Confirm the workflow completed with the expected result.
      await expect(
        page.evaluate(async () => {
          const response = await fetch('/weft/v1/workflows/setup-parked-workflow/result');
          return response.json();
        }),
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
      expect(await getActivityCount(origin)).toBe(1);
    },
    { timeout: 30_000 },
  );

  browserSmokeTest(
    'setupServiceWorker({ recover: true }) resumes a sleeping timer workflow via periodic sync after SW restart',
    async () => {
      const serviceWorkerSource = await buildSetupServiceWorkerBundle(
        `weft-setup-timer-smoke-${crypto.randomUUID()}`,
      );
      const { origin } = createSmokeServer(serviceWorkerSource);
      const browser = await launchBrowser();
      const context = await browser.newContext();
      const page = await context.newPage();
      const browserDiagnostics: string[] = [];
      page.on('console', (message) => browserDiagnostics.push(`console:${message.text()}`));
      page.on('pageerror', (error) => browserDiagnostics.push(`pageerror:${error.message}`));
      context.on('serviceworker', (worker) => {
        browserDiagnostics.push(`serviceworker:${worker.url()}`);
        worker.on('close', () => browserDiagnostics.push(`serviceworker-close:${worker.url()}`));
      });

      await registerServiceWorker(page, origin, browserDiagnostics);

      // Start a workflow that parks on ctx.sleep(). This is a DISTINCT recovery
      // path from the signal-parked case: a sleeping workflow only advances when
      // a periodic-sync tick fires the durable timer — there is no external
      // signal to drive it. Recovery must re-arm that timer in the new worker.
      const timerWorkflow = await page.evaluate(async () => {
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
      });
      expect(timerWorkflow.id).toBe('setup-timer-workflow');
      await waitForPageWorkflowStatus(page, timerWorkflow.id, 'running');
      // 'running' alone does not prove the ctx.sleep timer is durable. Wait for
      // the deadline to be checkpointed so the kill below always lands AFTER the
      // timer is persisted — recovery then has a real timer to re-arm, and the
      // test exercises the recovery path it claims rather than racing the
      // checkpoint write.
      await waitForTimerArmed(page);

      // Record the current worker identity before stopping.
      const instanceBeforeStop = await sendWorkerMessage<{ instanceId: string }>(page, {
        type: 'weft:test:instance',
      });

      // Kill the Service Worker via CDP while the workflow is still sleeping.
      await stopServiceWorkers(context, page);

      // A new worker identity proves recovery (via recover: true) completed and
      // the sleeping workflow's durable timer was re-armed in the fresh worker.
      const instanceAfterStop = await sendWorkerMessage<{ instanceId: string }>(page, {
        type: 'weft:test:instance',
      });
      expect(instanceAfterStop.instanceId).not.toBe(instanceBeforeStop.instanceId);

      // setupServiceWorker's ready promise proves recoverAll() completed its scan,
      // but the recovered generator advances asynchronously after that promise.
      // Wait for the engine's actual sleep resolver instead of sampling an
      // earlier workflow-body marker that can run before ctx.sleep() yields.
      await waitForSleepResolverReady(page);

      // Drive a periodic-sync tick with the scheduler clock advanced past the
      // timer deadline. The recovered worker must fire the re-armed timer and
      // let the workflow run to completion.
      const tickResult = await sendWorkerMessage<{ ticked: boolean }>(page, {
        type: 'weft:test:periodic-sync',
      });
      expect(tickResult).toEqual({ ticked: true });

      // engine.fireTimer() acknowledges a sleep timer only after the awakened
      // workflow commits later durable progress. This workflow terminates
      // immediately after sleeping, so the completed state and timer deletion
      // must both be observable as soon as the tick reply arrives.
      const timerState = await sendWorkerMessage<{
        remainingTimerCount: number;
        workflowStatus: string | null;
      }>(page, { type: 'weft:test:timer-state' });
      expect(timerState).toEqual({
        remainingTimerCount: 0,
        workflowStatus: 'completed',
      });

      await expect(
        page.evaluate(async () => {
          const response = await fetch('/weft/v1/workflows/setup-timer-workflow/result');
          return response.json();
        }),
      ).resolves.toEqual({ result: 'slept-then-finished' });

      // This workflow runs no activity, so the counter must still be exactly 0 —
      // recovery must not synthesize spurious activity executions.
      expect(await getActivityCount(origin)).toBe(0);
    },
    { timeout: 30_000 },
  );
});
