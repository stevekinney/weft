import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const shouldRunBrowserSmoke =
  Bun.env['WEFT_BROWSER_SMOKE'] === '1' || Bun.env['WEFT_CHROMIUM_SERVICE_WORKER_SMOKE'] === '1';

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

async function waitForPageWorkflowStatus(
  page: Page,
  workflowId: string,
  status: string,
): Promise<void> {
  await page.evaluate(
    async ({ expectedStatus, id }) => {
      const deadline = Date.now() + 5_000;
      let actualStatus = '<missing>';
      while (Date.now() < deadline) {
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

      await page.evaluate(async () => {
        const response = await fetch('/weft/v1/workflows/parked-workflow/signal/finish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payload: 'done' }),
        });
        if (!response.ok) throw new Error(`signal failed: ${response.status}`);
      });
      const instanceAfterStop = await sendWorkerMessage<{ instanceId: string }>(page, {
        type: 'weft:test:instance',
      });
      expect(instanceAfterStop.instanceId).not.toBe(instanceBeforeStop.instanceId);

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
      await waitForActivityCount(origin, 1);
    },
    { timeout: 30_000 },
  );
});
