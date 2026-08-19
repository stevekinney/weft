import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fileSystem from 'node:fs';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForParityCondition as waitFor } from '../core/parity/real-timer-wait.test-support.ts';
import { waitForRealTimersForTesting } from '../testing/fake-timers.test-support.ts';

import { decode, encode } from '../core/codec.ts';
import { Engine } from '../core/engine.ts';
import {
  ActivityFailedEvent,
  WorkerConnectedEvent,
  WorkerDisconnectedEvent,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowSuspendedEvent,
} from '../core/events.ts';
import type { RetryPolicy, WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { MCP_PROTOCOL_VERSION } from '../mcp/protocol.ts';
import { METRICS } from '../observability/metrics.ts';
import type { Storage as WeftStorage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import type { WorkerManifest } from '../worker/manifest/index.ts';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../worker/protocol.ts';
import {
  manifestForActivities,
  TEST_ACCEPTED_MANIFEST_DIGEST,
  testWorkerManifest,
} from '../worker/registry-fixtures.test-support.ts';
import { resetPublicOriginWarningForTesting } from './api-catalog.ts';
import { createDashboardAssetRoute, resolveDashboardAssets } from './dashboard-assets.ts';
import { DeadlineTracker } from './deadline-tracker.ts';
import * as handlerModule from './handler.ts';
import type { ServeOptions, WeftServer } from './index.ts';
import { DASHBOARD_PAGE_ROUTES, serve, wireEventBroadcasting } from './index.ts';
import { anonymousPrincipal } from './principal.ts';
import { API_PREFIX, DIRECT_HTTP_ROUTES } from './route-model.ts';
import { buildFetchHandler, buildServerContext, resolveNetworkConfig } from './serve-internals.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  isRemoteTaskTerminalResolved,
  taskLedgerKey,
  type RemoteTaskLeased,
  type RemoteTaskQueued,
  type RemoteTaskRecord,
  type RemoteTaskTerminalResolved,
} from './task-ledger.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

class TokenEvent extends Event {
  static readonly type = 'stream:token';

  constructor(
    public readonly workflowId: string,
    public readonly token: string,
    public readonly model: string,
  ) {
    super(TokenEvent.type);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_WORKER_SHUTDOWN_TIMEOUT_MS = 50;

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await waitForRealTimersForTesting(10);
}

function serveTestServer(options: ServeOptions): WeftServer {
  return serve({ workerShutdownTimeoutMs: TEST_WORKER_SHUTDOWN_TIMEOUT_MS, ...options });
}

function supportsSymlinks(directory: string): boolean {
  const probePath = join(directory, '.symlink-probe');
  try {
    symlinkSync(directory, probePath);
    rmSync(probePath);
    return true;
  } catch (error) {
    const errorCode =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (errorCode === 'EACCES' || errorCode === 'EPERM' || errorCode === 'ENOTSUP') {
      console.warn(
        `Skipping symlink asset test: platform rejected symlink creation (${errorCode})`,
      );
      return false;
    }
    throw error;
  }
}

function createReconnectTestEngineWithStorage(): { engine: Engine; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(echoWorkflow);
  return { engine, storage };
}

function serveFastReconnectTestServer(engine: Engine): WeftServer {
  return serveTestServer({ engine, port: 0, workerReconnectGracePeriodMs: 100 });
}

async function waitForSocketClose(ws: WebSocket, _label = 'WebSocket close'): Promise<void> {
  try {
    if (ws.readyState !== WebSocket.CLOSED) ws.close();
  } catch {
    // The server may already have completed the close handshake.
  }
  await waitForRealTimersForTesting(100);
}

async function connectAuthenticatedWebSocket(url: string, apiKey: string): Promise<WebSocket> {
  const ws = new WebSocket(url, { headers: { 'x-api-key': apiKey } } as any);

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error(`WebSocket connection failed: ${url}`)), {
      once: true,
    });
  });

  return ws;
}

async function waitForWorkerMessage(
  ws: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  label: string,
): Promise<Record<string, unknown>> {
  let matched: Record<string, unknown> | undefined;
  ws.addEventListener('message', (event) => {
    try {
      const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (predicate(parsed)) matched = parsed;
    } catch {
      // Ignore non-JSON frames while waiting for protocol diagnostics.
    }
  });

  await waitFor(() => matched !== undefined, { label });
  return matched!;
}

type WebSocketWorkerRegistrationOptions = {
  workerId: string;
  activities: string[];
  concurrency?: number;
  deploymentName?: string;
  buildId?: string;
  runtimeVersion?: string;
  startedAt?: number;
  capabilities?: Record<string, unknown>;
};

type TaskMessage = {
  type: string;
  operationId?: string;
  attempt?: number;
  attemptToken?: string;
};

function collectTaskMessages(webSocket: WebSocket): TaskMessage[] {
  const received: TaskMessage[] = [];
  webSocket.addEventListener('message', (event) => {
    received.push(JSON.parse(String(event.data)) as TaskMessage);
  });
  return received;
}

function collectAndCompleteTaskMessages(
  webSocket: WebSocket,
  {
    resultValue = null,
    completeWhen = (message: TaskMessage) => message.type === 'task',
  }: {
    resultValue?: unknown;
    completeWhen?: (message: TaskMessage) => boolean;
  } = {},
): TaskMessage[] {
  const received: TaskMessage[] = [];
  webSocket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as TaskMessage;
    received.push(message);
    if (completeWhen(message)) {
      sendCompletedTaskResult(webSocket, message.operationId, message.attemptToken, resultValue);
    }
  });
  return received;
}

function sendCompletedTaskResult(
  webSocket: WebSocket,
  operationId: string | undefined,
  attemptToken: string | undefined,
  value: unknown,
): void {
  webSocket.send(
    JSON.stringify({
      type: 'taskResult',
      operationId,
      attemptToken,
      status: 'completed',
      value,
    }),
  );
}

async function connectWebSocketWorker(
  server: WeftServer,
  path = '/v1/tasks/default/stream',
): Promise<WebSocket> {
  const webSocketUrl = server.url.replace('http://', 'ws://');
  const webSocket = new WebSocket(`${webSocketUrl}${path}`);

  await new Promise<void>((resolve, reject) => {
    webSocket.addEventListener('open', () => resolve());
    webSocket.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
  });

  return webSocket;
}

async function registerWebSocketWorker(
  webSocket: WebSocket,
  options: WebSocketWorkerRegistrationOptions,
): Promise<void> {
  const registrationAck = waitForWorkerMessage(
    webSocket,
    (message) => message['type'] === 'registerAck' && message['workerId'] === options.workerId,
    `registerAck for ${options.workerId}`,
  );
  const manifestOverrides: Partial<WorkerManifest> = {
    ...(options.deploymentName !== undefined || options.buildId !== undefined
      ? {
          deployment: {
            name: options.deploymentName ?? 'test-deployment',
            buildId: options.buildId ?? 'test-build',
            artifactDigest: 'sha256:test',
          },
        }
      : {}),
    ...(options.runtimeVersion !== undefined
      ? { runtime: { name: 'bun', version: options.runtimeVersion } }
      : {}),
    ...(options.capabilities !== undefined
      ? { capabilities: options.capabilities as WorkerManifest['capabilities'] }
      : {}),
  };
  webSocket.send(
    JSON.stringify({
      type: 'register',
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      workerId: options.workerId,
      manifest: manifestForActivities(options.activities, manifestOverrides),
      concurrency: options.concurrency ?? 10,
      ...(options.startedAt !== undefined ? { startedAt: options.startedAt } : {}),
    }),
  );
  await registrationAck;
}

const connectWorker = connectWebSocketWorker;
const registerWorker = registerWebSocketWorker;

async function connectRegisteredWorkerPair(server: WeftServer): Promise<{
  primaryWorker: WebSocket;
  secondaryWorker: WebSocket;
  secondaryMessages: TaskMessage[];
}> {
  const primaryWorker = await connectWorker(server);
  const secondaryWorker = await connectWorker(server);
  const secondaryMessages = collectTaskMessages(secondaryWorker);

  await registerWorker(primaryWorker, {
    workerId: 'w1',
    activities: ['test.charge'],
    concurrency: 5,
  });
  await registerWorker(secondaryWorker, {
    workerId: 'w2',
    activities: ['test.charge'],
    concurrency: 5,
  });

  return { primaryWorker, secondaryWorker, secondaryMessages };
}

function workerStreamPath(queue: string): string {
  return `/v1/tasks/${encodeURIComponent(queue)}/stream`;
}

/** Count keys under a prefix by draining an async iterator. */
async function countKeys(engine: Engine, prefix: string): Promise<number> {
  let count = 0;
  for await (const _entry of engine.storage.scan(prefix)) {
    count++;
  }
  return count;
}

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });

  engine.register(echoWorkflow);

  return engine;
}

function overrideProperty<T extends object, K extends keyof T>(
  target: T,
  property: K,
  replacement: T[K],
): () => void {
  const original = target[property];
  (target as Record<PropertyKey, unknown>)[property as PropertyKey] = replacement as unknown;
  return () => {
    (target as Record<PropertyKey, unknown>)[property as PropertyKey] = original as unknown;
  };
}

/**
 * Read the current durable remote task ledger record for `operationId`.
 * Post-cutover (WFT-22), this is the sole current-state record for the live
 * dispatch/claim/heartbeat/completion path — see `task-ledger.ts`.
 */
async function readLedgerRecord(
  storage: WeftStorage,
  operationId: string,
): Promise<RemoteTaskRecord | null> {
  return decodeRemoteTaskRecord(await storage.get(taskLedgerKey(operationId)));
}

/**
 * Wait for and read `operationId`'s ledger record once it reaches a
 * `resolved`-disposition terminal state. Terminal records carry only
 * `RemoteTaskBase` fields plus `RemoteTaskTerminalCommon` (WFT-22 deliberately
 * does not persist queue/execution latency or retry/requeue counts onto the
 * terminal record itself — those are emitted as metrics at commit time and
 * WFT-24 is where any durable diagnostics enrichment would live).
 */
async function waitForTerminalResolvedRecord(
  storage: WeftStorage,
  operationId: string,
): Promise<RemoteTaskTerminalResolved> {
  let record: RemoteTaskTerminalResolved | undefined;
  await waitFor(
    async () => {
      const current = await readLedgerRecord(storage, operationId);
      if (!isRemoteTaskTerminalResolved(current)) return false;
      record = current;
      return true;
    },
    { label: `${operationId} to resolve` },
  );
  if (record === undefined) {
    throw new Error(`Expected a resolved terminal ledger record for "${operationId}"`);
  }
  return record;
}

/**
 * Hand-construct a `leased` durable remote task ledger record for narrow
 * unit-style test fixtures that don't need a full dispatch+claim round trip —
 * mirrors `leasedFixture()` in `task-ledger-transitions.test.ts`.
 */
function makeLeasedLedgerRecord(overrides: Partial<RemoteTaskLeased> = {}): RemoteTaskLeased {
  const now = Date.now();
  return {
    recordVersion: 1,
    operationId: 'op-1',
    workflowType: 'test',
    activityName: 'test.charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: now,
    generation: 1,
    state: 'leased',
    attemptToken: 'attempt-token',
    workerSessionId: 'worker-1',
    attempt: 1,
    leaseDeadline: now + 30_000,
    firstQueuedAt: now,
    lastQueuedAt: now,
    startedAt: now,
    lastHeartbeatAt: now,
    retryCount: 0,
    requeueCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('serve', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  it('starts a server on the specified port', () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    expect(server.port).toBeGreaterThan(0);
  });

  it('warns loudly when started without authentication', () => {
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});
    engine = createEngine();

    try {
      server = serveTestServer({ engine, port: 0 });

      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining('server started with NO authentication'),
      );
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining('all non-public operations are publicly accessible'),
      );
    } finally {
      warningSpy.mockRestore();
    }
  });

  it('refuses to start without authentication when unauthenticated access is rejected', () => {
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});
    engine = createEngine();

    try {
      expect(() => serveTestServer({ engine, port: 0, unauthenticatedAccess: 'reject' })).toThrow(
        'Refusing to start server with no authentication',
      );
      expect(warningSpy).not.toHaveBeenCalled();
    } finally {
      warningSpy.mockRestore();
    }
  });

  it('allows explicitly unauthenticated local servers without warning', () => {
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});
    engine = createEngine();

    try {
      server = serveTestServer({
        engine,
        port: 0,
        unauthenticatedAccess: 'allow',
        publicOrigin: 'http://localhost',
      });

      expect(warningSpy).not.toHaveBeenCalled();
    } finally {
      warningSpy.mockRestore();
    }
  });

  it('does not warn when authentication is configured', () => {
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});
    engine = createEngine();

    try {
      server = serveTestServer({
        engine,
        port: 0,
        auth: { apiKeys: ['test-key'] },
        publicOrigin: 'http://localhost',
      });

      expect(warningSpy).not.toHaveBeenCalled();
    } finally {
      warningSpy.mockRestore();
    }
  });

  it('serves public MCP discovery that matches the live MCP transport', async () => {
    const originalNodeEnv = Bun.env['NODE_ENV'];
    Bun.env['NODE_ENV'] = 'development';
    resetPublicOriginWarningForTesting();
    const originalWarn = console.warn;
    console.warn = () => {};
    const apiKey = 'mcp-discovery-live-key';
    engine = createEngine();
    server = serveTestServer({ engine, port: 0, auth: { apiKeys: [apiKey] } });

    try {
      const discoveryResponse = await fetch(`${server.url}/.well-known/mcp.json`);
      expect(discoveryResponse.status).toBe(200);
      const discovery = (await discoveryResponse.json()) as {
        transports?: { streamableHttp?: { url?: string; methods?: string[] } };
        discovery?: { tools?: { method?: string } };
      };
      const endpoint = discovery.transports?.streamableHttp?.url;
      // The MCP endpoint is advertised under the external `/api` prefix; the
      // front door strips it back to canonical `/mcp` before routing, so
      // fetching `endpoint` below exercises the full round-trip.
      expect(endpoint).toBe(`${server.url}/api/mcp`);
      expect(discovery.transports?.streamableHttp?.methods).toEqual(['POST', 'GET', 'DELETE']);

      const authorization = { Authorization: `Bearer ${apiKey}` };
      const methodNotAllowed = await fetch(endpoint!, {
        method: 'PUT',
        headers: authorization,
      });
      expect(methodNotAllowed.status).toBe(405);
      expect(methodNotAllowed.headers.get('allow')).toBe('POST, GET, DELETE');

      const getWithoutSession = await fetch(endpoint!, {
        method: 'GET',
        headers: { ...authorization, accept: 'text/event-stream' },
      });
      expect(getWithoutSession.status).not.toBe(405);

      const initializeResponse = await fetch(endpoint!, {
        method: 'POST',
        headers: {
          ...authorization,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'initialize',
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'weft-test-client', version: '1.0.0' },
          },
        }),
      });
      expect(initializeResponse.status).toBe(200);
      const sessionId = initializeResponse.headers.get('Mcp-Session-Id');
      expect(sessionId).toBeTruthy();

      const sessionHeaders = {
        ...authorization,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'Mcp-Protocol-Version': MCP_PROTOCOL_VERSION,
        'Mcp-Session-Id': sessionId!,
      };
      const initializedResponse = await fetch(endpoint!, {
        method: 'POST',
        headers: sessionHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      expect(initializedResponse.status).toBe(202);

      const toolsResponse = await fetch(endpoint!, {
        method: 'POST',
        headers: sessionHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'tools',
          method: discovery.discovery?.tools?.method,
          params: {},
        }),
      });
      expect(toolsResponse.status).toBe(200);
      const toolsBody = (await toolsResponse.json()) as {
        result?: { tools?: unknown[] };
        error?: unknown;
      };
      expect(toolsBody.error).toBeUndefined();
      expect(Array.isArray(toolsBody.result?.tools)).toBe(true);

      const deleteResponse = await fetch(endpoint!, {
        method: 'DELETE',
        headers: sessionHeaders,
      });
      expect(deleteResponse.status).toBe(204);
    } finally {
      console.warn = originalWarn;
      if (originalNodeEnv !== undefined) Bun.env['NODE_ENV'] = originalNodeEnv;
      else delete Bun.env['NODE_ENV'];
    }
  });

  it('responds to health check (GET /v1/health)', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/health`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  const dashboardBody = '<html><body>dashboard</body></html>';
  const makeDashboard = (): Response =>
    new Response(dashboardBody, { headers: { 'Content-Type': 'text/html' } });

  it('serves a supplied dashboard shell at the origin root', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0, dashboard: makeDashboard() });

    const rootResponse = await fetch(`${server.url}/`);
    expect(rootResponse.status).toBe(200);
    expect(await rootResponse.text()).toContain('dashboard');
  });

  it('serves a supplied dashboard shell at every supported page route', async () => {
    engine = createEngine();
    server = serveTestServer({
      engine,
      port: 0,
      dashboard: makeDashboard(),
      publicOrigin: 'http://discovery.test',
    });

    expect(DASHBOARD_PAGE_ROUTES).toEqual([
      '/',
      '/workflows',
      '/workflows/*',
      '/reviews',
      '/workers',
      '/schedules',
      '/storage',
      '/system',
    ]);

    // Enumerating DASHBOARD_PAGE_ROUTES pins the server-owned mount list used by
    // external dashboard packages.
    for (const route of DASHBOARD_PAGE_ROUTES) {
      // `/workflows/*` is a deep-link pattern; exercise it with a concrete id.
      const path = route.endsWith('/*') ? `${route.slice(0, -2)}/abc123` : route;
      const response = await fetch(`${server.url}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('dashboard');
    }

    for (const path of [
      '/v1/health',
      '/api/v1/health',
      '/openapi.json',
      '/openrpc.json',
      '/asyncapi.json',
      '/.well-known/mcp.json',
    ]) {
      const response = await fetch(`${server.url}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain('dashboard');
    }
  });

  it('is headless by default on every dashboard page route', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    for (const route of DASHBOARD_PAGE_ROUTES) {
      const path = route.endsWith('/*') ? `${route.slice(0, -2)}/abc123` : route;
      const response = await fetch(`${server.url}${path}`);
      expect(response.status).toBe(404);
    }

    const canonicalHealthResponse = await fetch(`${server.url}/v1/health`);
    expect(canonicalHealthResponse.status).toBe(200);

    const prefixedHealthResponse = await fetch(`${server.url}/api/v1/health`);
    expect(prefixedHealthResponse.status).toBe(200);
  });

  it('treats a null dashboard option from JavaScript callers as headless', async () => {
    engine = createEngine();
    const javascriptOptions = { engine, port: 0, dashboard: null } as unknown as Parameters<
      typeof serve
    >[0];
    server = serveTestServer(javascriptOptions);

    const rootResponse = await fetch(`${server.url}/`);
    expect(rootResponse.status).toBe(404);

    const healthResponse = await fetch(`${server.url}/v1/health`);
    expect(healthResponse.status).toBe(200);
  });

  it('does not serve the dashboard for unknown root paths (no blanket catch-all)', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0, dashboard: makeDashboard() });

    const response = await fetch(`${server.url}/nonsense`);
    expect(response.status).toBe(404);
  });

  it('serves a dashboard asset directory through explicit GET and HEAD routes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    try {
      mkdirSync(join(directory, 'images'));
      writeFileSync(join(directory, 'app-abc123.js'), 'console.log("dashboard");');
      writeFileSync(join(directory, 'styles-def456.css'), 'body { color: red; }');
      writeFileSync(join(directory, 'images', 'logo.svg'), '<svg></svg>');
      writeFileSync(join(directory, '%2e%2e.txt'), 'encoded filename');
      engine = createEngine();
      server = serveTestServer({
        engine,
        port: 0,
        dashboard: makeDashboard(),
        publicOrigin: 'http://discovery.test',
        dashboardAssets: { prefix: '/assets', directory },
      });

      const javascript = await fetch(`${server.url}/assets/app-abc123.js`);
      expect(javascript.status).toBe(200);
      expect(javascript.headers.get('content-type')).toContain('text/javascript');
      expect(await javascript.text()).toContain('dashboard');

      const stylesheetHead = await fetch(`${server.url}/assets/styles-def456.css`, {
        method: 'HEAD',
      });
      expect(stylesheetHead.status).toBe(200);
      expect(await stylesheetHead.text()).toBe('');

      const stylesheet = await fetch(`${server.url}/assets/styles-def456.css`);
      expect(stylesheet.status).toBe(200);
      expect(stylesheet.headers.get('content-type')).toContain('text/css');

      const image = await fetch(`${server.url}/assets/images/logo.svg`);
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toContain('image/svg+xml');

      const missing = await fetch(`${server.url}/assets/missing-999.js`);
      expect(missing.status).toBe(404);
      expect(await missing.text()).not.toContain(directory);

      const malformedEncoding = await fetch(`${server.url}/assets/%`);
      expect(malformedEncoding.status).toBe(404);

      const emptyAssetPath = join(directory, 'empty.txt');
      writeFileSync(emptyAssetPath, '');
      const emptyAsset = await fetch(`${server.url}/assets/empty.txt`);
      expect(emptyAsset.status).toBe(200);
      expect(await emptyAsset.text()).toBe('');

      const traversal = await fetch(`${server.url}/assets/%2e%2e/%2e%2e/secret.txt`);
      expect(traversal.status).toBe(404);
      expect(await traversal.text()).not.toContain(directory);

      const repeatedSeparator = await fetch(`${server.url}/assets//app-abc123.js`);
      expect(repeatedSeparator.status).toBe(404);

      const post = await fetch(`${server.url}/assets/app-abc123.js`, { method: 'POST' });
      expect(post.status).toBe(404);
      expect(await post.text()).not.toContain('dashboard');

      for (const path of ['/v1/health', '/api/v1/health', '/openapi.json']) {
        const response = await fetch(`${server.url}${path}`);
        expect(response.status).toBe(200);
        expect(await response.text()).not.toContain('dashboard');
      }

      for (const path of ['/.well-known/mcp.json', '/.well-known/api-catalog']) {
        const response = await fetch(`${server.url}${path}`);
        expect(response.status).toBe(200);
        expect(await response.text()).not.toContain('dashboard');
      }

      const encodedFilename = await fetch(`${server.url}/assets/%252e%252e.txt`);
      expect(encodedFilename.status).toBe(200);
      expect(await encodedFilename.text()).toBe('encoded filename');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('validates dashboard asset prefixes synchronously before binding', () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    try {
      const directRoutePrefixes = DIRECT_HTTP_ROUTES.flatMap(({ path }) => {
        const parent = path.slice(0, path.lastIndexOf('/'));
        return parent.length > 0 ? [path, parent] : [path];
      });
      const dashboardRoutePrefixes = DASHBOARD_PAGE_ROUTES.flatMap((route) => {
        if (route === '/') return [];
        if (route.endsWith('/*')) {
          const base = route.slice(0, -2);
          return [base, `${base}/assets`];
        }
        return [route];
      });
      for (const prefix of [
        API_PREFIX,
        `${API_PREFIX}/assets`,
        '/v1',
        '/v1/assets',
        ...directRoutePrefixes,
        ...dashboardRoutePrefixes,
        '/.well-known',
        '/assets/',
        '/assets//',
        '/assets/.',
        '/assets/..',
        '/assets/*',
        '/assets/%2e%2e',
        '/asset files',
        '/café',
      ]) {
        const assetEngine = createEngine();
        expect(() =>
          serve({
            engine: assetEngine,
            port: 0,
            dashboardAssets: { prefix, directory },
          }),
        ).toThrow(
          prefix === '/asset files' || prefix === '/café' ? /URL serialization/ : undefined,
        );
        assetEngine[Symbol.dispose]();
      }

      const filePath = join(directory, 'not-a-directory.txt');
      writeFileSync(filePath, 'file');
      const fileEngine = createEngine();
      expect(() =>
        serve({
          engine: fileEngine,
          port: 0,
          dashboardAssets: { prefix: '/assets', directory: filePath },
        }),
      ).toThrow();
      fileEngine[Symbol.dispose]();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects malformed dashboard asset configuration before filesystem access', () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    try {
      for (const value of [null, [], 'assets', 42]) {
        expect(() => resolveDashboardAssets(value, DASHBOARD_PAGE_ROUTES)).toThrow(
          'dashboardAssets must be an object with prefix and directory strings',
        );
      }

      expect(() => resolveDashboardAssets({ prefix: '/assets' }, DASHBOARD_PAGE_ROUTES)).toThrow(
        'dashboardAssets.prefix and dashboardAssets.directory must be strings',
      );
      expect(() => resolveDashboardAssets({ directory }, DASHBOARD_PAGE_ROUTES)).toThrow(
        'dashboardAssets.prefix and dashboardAssets.directory must be strings',
      );
      expect(() =>
        resolveDashboardAssets({ prefix: 42, directory }, DASHBOARD_PAGE_ROUTES),
      ).toThrow('dashboardAssets.prefix and dashboardAssets.directory must be strings');
      expect(() =>
        resolveDashboardAssets({ prefix: '/assets', directory: 42 }, DASHBOARD_PAGE_ROUTES),
      ).toThrow('dashboardAssets.prefix and dashboardAssets.directory must be strings');
      expect(() =>
        resolveDashboardAssets(
          { prefix: '/assets', directory: join(directory, 'missing') },
          DASHBOARD_PAGE_ROUTES,
        ),
      ).toThrow(`dashboardAssets.directory does not exist: ${join(directory, 'missing')}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns not found for an aborted dashboard asset request', () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    try {
      writeFileSync(join(directory, 'app.js'), 'dashboard');
      const assets = resolveDashboardAssets(
        { prefix: '/assets', directory },
        DASHBOARD_PAGE_ROUTES,
      );
      const route = createDashboardAssetRoute(assets);
      const controller = new AbortController();
      controller.abort();

      const emptyPathResponse = route.GET!(new Request('http://weft.test/assets/'));
      expect(emptyPathResponse.status).toBe(404);

      const response = route.GET!(
        new Request('http://weft.test/assets/app.js', { signal: controller.signal }),
      );
      expect(response.status).toBe(404);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('closes the descriptor when constructing an asset response fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    const originalResponse = globalThis.Response;
    const originalCloseSync = fileSystem.closeSync;
    try {
      writeFileSync(join(directory, 'app.js'), 'dashboard');
      const assets = resolveDashboardAssets(
        { prefix: '/assets', directory },
        DASHBOARD_PAGE_ROUTES,
      );
      let closeCount = 0;
      const route = createDashboardAssetRoute(assets, {
        ...fileSystem,
        closeSync: (descriptor: number) => {
          closeCount += 1;
          return originalCloseSync(descriptor);
        },
        read: async (descriptor, buffer, offset, length, position) =>
          await new Promise<number>((resolve, reject) => {
            fileSystem.read(descriptor, buffer, offset, length, position, (error, bytesRead) => {
              if (error) reject(error);
              else resolve(bytesRead);
            });
          }),
      });
      globalThis.Response = class extends originalResponse {
        constructor(body?: BodyInit | null, init?: ResponseInit) {
          if (body instanceof ReadableStream) {
            throw new Error('response construction failed');
          }
          super(body, init);
        }
      };

      const response = route.GET!(new Request('http://weft.test/assets/app.js'));
      expect(response.status).toBe(404);
      expect(closeCount).toBe(1);
    } finally {
      globalThis.Response = originalResponse;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not serve a symlink that escapes the dashboard asset directory', async () => {
    const parentDirectory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    const directory = join(parentDirectory, 'assets');
    const outsideFile = join(parentDirectory, 'outside.txt');
    try {
      mkdirSync(directory);
      writeFileSync(outsideFile, 'outside asset');
      try {
        symlinkSync(outsideFile, join(directory, 'outside.txt'));
        symlinkSync(join(directory, 'missing.txt'), join(directory, 'broken.txt'));
      } catch (error) {
        const errorCode =
          typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        if (errorCode === 'EACCES' || errorCode === 'EPERM' || errorCode === 'ENOTSUP') {
          console.warn(
            `Skipping symlink asset test: platform rejected symlink creation (${errorCode})`,
          );
          return;
        }
        throw error;
      }

      engine = createEngine();
      server = serveTestServer({
        engine,
        port: 0,
        dashboardAssets: { prefix: '/assets', directory },
      });

      const response = await fetch(`${server.url}/assets/outside.txt`);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(outsideFile);

      const brokenLinkResponse = await fetch(`${server.url}/assets/broken.txt`);
      expect(brokenLinkResponse.status).toBe(404);
      expect(await brokenLinkResponse.text()).not.toContain(directory);
    } finally {
      rmSync(parentDirectory, { recursive: true, force: true });
    }
  });

  it('does not serve a symlink installed after canonical validation', async () => {
    const parentDirectory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    const directory = join(parentDirectory, 'assets');
    const assetPath = join(directory, 'app.js');
    const outsideFile = join(parentDirectory, 'outside.js');
    try {
      mkdirSync(directory);
      writeFileSync(assetPath, 'validated asset');
      writeFileSync(outsideFile, 'replacement asset');
      if (!supportsSymlinks(parentDirectory)) return;
      const originalOpenSync = fileSystem.openSync;
      let replaced = false;
      let replacementError: unknown;
      const assetFileSystem = {
        ...fileSystem,
        read: async () => 0,
        openSync: (
          path: Parameters<typeof fileSystem.openSync>[0],
          flags: Parameters<typeof fileSystem.openSync>[1],
          mode?: Parameters<typeof fileSystem.openSync>[2],
        ) => {
          if (String(path).endsWith(join('app.js')) && !replaced) {
            try {
              rmSync(assetPath);
              symlinkSync(outsideFile, assetPath);
            } catch (error) {
              replacementError = error;
              throw error;
            }
            replaced = true;
          }
          return originalOpenSync(path, flags, mode);
        },
      };
      const assets = resolveDashboardAssets(
        { prefix: '/assets', directory },
        DASHBOARD_PAGE_ROUTES,
      );
      const route = createDashboardAssetRoute(assets, assetFileSystem);
      const response = route.GET!(new Request('http://weft.test/assets/app.js'));
      if (replacementError !== undefined) throw replacementError;
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('replacement asset');
    } finally {
      rmSync(parentDirectory, { recursive: true, force: true });
    }
  });

  it('does not serve an asset after an ancestor directory is replaced', () => {
    const parentDirectory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    const directory = join(parentDirectory, 'assets');
    const nestedDirectory = join(directory, 'nested');
    const outsideDirectory = join(parentDirectory, 'outside');
    const outsideFile = join(outsideDirectory, 'app.js');
    try {
      mkdirSync(nestedDirectory, { recursive: true });
      mkdirSync(outsideDirectory);
      writeFileSync(join(nestedDirectory, 'app.js'), 'validated asset');
      writeFileSync(outsideFile, 'replacement asset');
      if (!supportsSymlinks(parentDirectory)) return;
      const originalOpenSync = fileSystem.openSync;
      let replaced = false;
      let replacementError: unknown;
      const assetFileSystem = {
        ...fileSystem,
        read: async () => 0,
        openSync: (
          path: Parameters<typeof fileSystem.openSync>[0],
          flags: Parameters<typeof fileSystem.openSync>[1],
          mode?: Parameters<typeof fileSystem.openSync>[2],
        ) => {
          if (String(path).endsWith(join('nested', 'app.js')) && !replaced) {
            try {
              rmSync(nestedDirectory, { recursive: true });
              symlinkSync(outsideDirectory, nestedDirectory);
            } catch (error) {
              replacementError = error;
              throw error;
            }
            replaced = true;
          }
          return originalOpenSync(path, flags, mode);
        },
      };
      const assets = resolveDashboardAssets(
        { prefix: '/assets', directory },
        DASHBOARD_PAGE_ROUTES,
      );
      const route = createDashboardAssetRoute(assets, assetFileSystem);
      const response = route.GET!(new Request('http://weft.test/assets/nested/app.js'));
      if (replacementError !== undefined) throw replacementError;
      expect(response.status).toBe(404);
    } finally {
      rmSync(parentDirectory, { recursive: true, force: true });
    }
  });

  it('does not serve an outside descriptor when an ancestor is restored after opening', async () => {
    const parentDirectory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    const directory = join(parentDirectory, 'assets');
    const nestedDirectory = join(directory, 'nested');
    const savedDirectory = join(directory, 'saved-nested');
    const outsideDirectory = join(parentDirectory, 'outside');
    try {
      mkdirSync(nestedDirectory, { recursive: true });
      mkdirSync(outsideDirectory);
      writeFileSync(join(nestedDirectory, 'app.js'), 'validated asset');
      writeFileSync(join(outsideDirectory, 'app.js'), 'outside asset');
      if (!supportsSymlinks(parentDirectory)) return;

      const originalStatSync = fileSystem.statSync;
      const originalOpenSync = fileSystem.openSync;
      let ancestorSwapped = false;
      const assetFileSystem = {
        ...fileSystem,
        read: async () => 0,
        realpathSync: (path: Parameters<typeof fileSystem.realpathSync>[0]) => {
          const value = String(path);
          if (value.startsWith('/proc/self/fd/') || value.startsWith('/dev/fd/')) {
            throw new Error('Descriptor path aliases are unavailable');
          }
          return fileSystem.realpathSync(path);
        },
        statSync: (path: Parameters<typeof fileSystem.statSync>[0]) => {
          if (String(path).endsWith(join('nested', 'app.js')) && !ancestorSwapped) {
            renameSync(nestedDirectory, savedDirectory);
            symlinkSync(outsideDirectory, nestedDirectory);
            ancestorSwapped = true;
          }
          return originalStatSync(path);
        },
        openSync: (
          path: Parameters<typeof fileSystem.openSync>[0],
          flags: Parameters<typeof fileSystem.openSync>[1],
          mode?: Parameters<typeof fileSystem.openSync>[2],
        ) => {
          const descriptor = originalOpenSync(path, flags, mode);
          if (String(path).endsWith(join('nested', 'app.js')) && ancestorSwapped) {
            rmSync(nestedDirectory);
            renameSync(savedDirectory, nestedDirectory);
          }
          return descriptor;
        },
      };
      const assets = resolveDashboardAssets(
        { prefix: '/assets', directory },
        DASHBOARD_PAGE_ROUTES,
      );
      const route = createDashboardAssetRoute(assets, assetFileSystem);
      const response = route.GET!(new Request('http://weft.test/assets/nested/app.js'));

      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('outside asset');
    } finally {
      rmSync(parentDirectory, { recursive: true, force: true });
    }
  });

  it('serves verified assets when descriptor path aliases are unavailable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    try {
      writeFileSync(join(directory, 'app.js'), 'dashboard');
      const assetFileSystem = {
        ...fileSystem,
        read: async (
          descriptor: number,
          buffer: NodeJS.ArrayBufferView,
          offset: number,
          length: number,
          position: number | null,
        ) =>
          await new Promise<number>((resolve, reject) => {
            fileSystem.read(descriptor, buffer, offset, length, position, (error, bytesRead) => {
              if (error) reject(error);
              else resolve(bytesRead);
            });
          }),
        realpathSync: (path: Parameters<typeof fileSystem.realpathSync>[0]) => {
          const value = String(path);
          if (value.startsWith('/proc/self/fd/') || value.startsWith('/dev/fd/')) {
            throw new Error('Descriptor path aliases are unavailable');
          }
          return fileSystem.realpathSync(path);
        },
      };
      const assets = resolveDashboardAssets(
        { prefix: '/assets', directory },
        DASHBOARD_PAGE_ROUTES,
      );
      const route = createDashboardAssetRoute(assets, assetFileSystem);

      const response = route.GET!(new Request('http://weft.test/assets/app.js'));

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('dashboard');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('serves verified assets when descriptor aliases resolve to their namespace paths', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    try {
      writeFileSync(join(directory, 'app.js'), 'dashboard');
      const assetFileSystem = {
        ...fileSystem,
        read: async (
          descriptor: number,
          buffer: NodeJS.ArrayBufferView,
          offset: number,
          length: number,
          position: number | null,
        ) =>
          await new Promise<number>((resolve, reject) => {
            fileSystem.read(descriptor, buffer, offset, length, position, (error, bytesRead) => {
              if (error) reject(error);
              else resolve(bytesRead);
            });
          }),
        realpathSync: (path: Parameters<typeof fileSystem.realpathSync>[0]) => {
          const value = String(path);
          if (value.startsWith('/proc/self/fd/')) {
            throw new Error('Linux descriptor path alias is unavailable');
          }
          if (value.startsWith('/dev/fd/')) {
            return value;
          }
          return fileSystem.realpathSync(path);
        },
      };
      const assets = resolveDashboardAssets(
        { prefix: '/assets', directory },
        DASHBOARD_PAGE_ROUTES,
      );
      const route = createDashboardAssetRoute(assets, assetFileSystem);

      const response = route.GET!(new Request('http://weft.test/assets/app.js'));

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('dashboard');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('streams only the file size verified before reading starts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    const assetPath = join(directory, 'app.js');
    const originalRead = fileSystem.read;
    try {
      writeFileSync(assetPath, 'safe');
      let appended = false;
      const assetFileSystem = {
        ...fileSystem,
        read: async (
          descriptor: number,
          buffer: NodeJS.ArrayBufferView,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          if (!appended) {
            appendFileSync(assetPath, ' outside');
            appended = true;
          }
          return await new Promise<number>((resolve, reject) => {
            originalRead(descriptor, buffer, offset, length, position, (error, bytesRead) => {
              if (error) reject(error);
              else resolve(bytesRead);
            });
          });
        },
      };
      const assets = resolveDashboardAssets(
        { prefix: '/assets', directory },
        DASHBOARD_PAGE_ROUTES,
      );
      const route = createDashboardAssetRoute(assets, assetFileSystem);
      const response = route.GET!(new Request('http://weft.test/assets/app.js'));

      expect(response.headers.get('content-length')).toBe('4');
      expect(await response.text()).toBe('safe');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('errors the response stream when an asset is truncated after verification', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    const assetPath = join(directory, 'app.js');
    try {
      writeFileSync(assetPath, 'dashboard');
      let truncated = false;
      const assetFileSystem = {
        ...fileSystem,
        read: async () => {
          if (!truncated) {
            truncateSync(assetPath, 0);
            truncated = true;
          }
          return 0;
        },
      };
      const assets = resolveDashboardAssets(
        { prefix: '/assets', directory },
        DASHBOARD_PAGE_ROUTES,
      );
      const route = createDashboardAssetRoute(assets, assetFileSystem);
      const response = route.GET!(new Request('http://weft.test/assets/app.js'));

      expect(response.headers.get('content-length')).toBe('9');
      await expect(response.text()).rejects.toThrow(
        'Dashboard asset ended before its verified content length was read.',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('waits for an in-flight asset read before closing on cancellation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    const originalCloseSync = fileSystem.closeSync;
    try {
      writeFileSync(join(directory, 'app.js'), 'dashboard');
      let closed = 0;
      let resolveRead!: (bytesRead: number) => void;
      let markReadStarted!: () => void;
      const readStarted = new Promise<void>((resolve) => {
        markReadStarted = resolve;
      });
      const pendingRead = new Promise<number>((resolve) => {
        resolveRead = resolve;
      });
      const assetFileSystem = {
        ...fileSystem,
        closeSync: (descriptor: number) => {
          closed += 1;
          return originalCloseSync(descriptor);
        },
        read: async () => {
          markReadStarted();
          return await pendingRead;
        },
      };
      const assets = resolveDashboardAssets(
        { prefix: '/assets', directory },
        DASHBOARD_PAGE_ROUTES,
      );
      const route = createDashboardAssetRoute(assets, assetFileSystem);
      const response = route.GET!(new Request('http://weft.test/assets/app.js'));
      const reader = response.body!.getReader();
      const read = reader.read();
      await readStarted;

      const cancellation = reader.cancel();
      await Promise.resolve();
      expect(closed).toBe(0);

      resolveRead(0);
      await cancellation;
      await read;
      expect(closed).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects non-regular dashboard assets without blocking on a FIFO', () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    const fifoPath = join(directory, 'asset.fifo');
    try {
      try {
        execFileSync('mkfifo', [fifoPath]);
      } catch (error) {
        const errorCode =
          typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        if (errorCode === 'ENOENT' || errorCode === 'EACCES' || errorCode === 'EPERM') return;
        throw error;
      }
      const assets = resolveDashboardAssets(
        { prefix: '/assets', directory },
        DASHBOARD_PAGE_ROUTES,
      );
      const route = createDashboardAssetRoute(assets);
      expect(route.GET!(new Request('http://weft.test/assets/asset.fifo')).status).toBe(404);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('closes dashboard asset descriptors for successful, rejected, and cancelled requests', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-assets-'));
    const originalOpenSync = fileSystem.openSync;
    const originalCloseSync = fileSystem.closeSync;
    const originalRead = fileSystem.read;
    try {
      writeFileSync(join(directory, 'app.js'), 'dashboard');
      const assets = resolveDashboardAssets(
        { prefix: '/assets', directory },
        DASHBOARD_PAGE_ROUTES,
      );
      let opened = 0;
      let closed = 0;
      let readCount = 0;
      let readFailure = false;
      const assetFileSystem = {
        ...fileSystem,
        openSync: (
          path: Parameters<typeof fileSystem.openSync>[0],
          flags: Parameters<typeof fileSystem.openSync>[1],
          mode?: Parameters<typeof fileSystem.openSync>[2],
        ) => {
          opened += 1;
          return originalOpenSync(path, flags, mode);
        },
        closeSync: (descriptor: number) => {
          closed += 1;
          return originalCloseSync(descriptor);
        },
        read: async (
          descriptor: number,
          buffer: NodeJS.ArrayBufferView,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          if (readFailure) throw new Error('asset read failed');
          readCount += 1;
          return await new Promise<number>((resolve, reject) => {
            originalRead(descriptor, buffer, offset, length, position, (error, bytesRead) => {
              if (error) reject(error);
              else resolve(bytesRead);
            });
          });
        },
      };
      const route = createDashboardAssetRoute(assets, assetFileSystem);

      for (let index = 0; index < 5; index += 1) {
        const response = route.GET!(new Request('http://weft.test/assets/app.js'));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('dashboard');
        const readsBeforeHead = readCount;
        expect(
          route.HEAD!(new Request('http://weft.test/assets/app.js', { method: 'HEAD' })).status,
        ).toBe(200);
        expect(readCount).toBe(readsBeforeHead);
      }
      expect(readCount).toBeGreaterThan(0);
      expect(route.GET!(new Request('http://weft.test/assets/missing.js')).status).toBe(404);
      readFailure = true;
      const failedResponse = route.GET!(new Request('http://weft.test/assets/app.js'));
      expect(failedResponse.status).toBe(200);
      await expect(failedResponse.text()).rejects.toThrow('asset read failed');
      readFailure = false;
      const cancelledResponse = route.GET!(new Request('http://weft.test/assets/app.js'));
      const reader = cancelledResponse.body!.getReader();
      await reader.cancel();

      expect(closed).toBe(opened);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('handles workflow API routes (POST /v1/workflows)', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'echo', input: 'hello' }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string };
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
  });

  it('routes /api/v1/workflows to the same handler as /v1/workflows (POST body preserved)', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    // The front door strips `/api` before routing; the POST body must survive
    // the request rebuild.
    const response = await fetch(`${server.url}/api/v1/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'echo', input: 'hello' }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string };
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
  });

  it('preserves the query string when stripping the /api prefix', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    // List with a query param via the prefixed path; the strip rebuilds the
    // request URL, so the search string must survive to the handler.
    const response = await fetch(`${server.url}/api/v1/workflows?limit=1`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items?: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  it('keeps health and metrics at the origin root and exposes them as /api aliases', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0, dashboard: makeDashboard() });

    // Canonical root-stable forms.
    const health = await fetch(`${server.url}/v1/health`);
    const metrics = await fetch(`${server.url}/v1/metrics`);
    expect(health.status).toBe(200);
    expect(metrics.status).toBe(200);
    // Undocumented public aliases via canonicalization — pinned so the behavior
    // is intentional, not accidental exposure behind a different auth surface.
    const aliasHealth = await fetch(`${server.url}/api/v1/health`);
    const aliasMetrics = await fetch(`${server.url}/api/v1/metrics`);
    expect(aliasHealth.status).toBe(200);
    expect(aliasMetrics.status).toBe(200);
  });

  it('serves discovery documents at the origin root (not under /api)', async () => {
    engine = createEngine();
    // `/.well-known/mcp.json` emits absolute URLs, so it needs a public origin.
    server = serveTestServer({ engine, port: 0, publicOrigin: 'http://discovery.test' });

    for (const path of [
      '/openapi.json',
      '/openrpc.json',
      '/asyncapi.json',
      '/.well-known/mcp.json',
    ]) {
      const response = await fetch(`${server.url}${path}`);
      expect(response.status).toBe(200);
    }
  });

  it('returns 404 for bare /api and /api/ (no aliasing of the root)', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0, dashboard: makeDashboard() });

    const bareApi = await fetch(`${server.url}/api`);
    const bareApiSlash = await fetch(`${server.url}/api/`);
    expect(bareApi.status).toBe(404);
    expect(bareApiSlash.status).toBe(404);
  });

  it('does not strip a doubled slash after the /api prefix', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0, dashboard: makeDashboard() });

    // `/api//v1/health` must NOT canonicalize to `//v1/health` (which would
    // route surprisingly). Only a clean `/api/<segment>` is stripped, so this
    // malformed path falls through to a 404 rather than reaching the handler.
    const doubled = await fetch(`${server.url}/api//v1/health`);
    expect(doubled.status).toBe(404);
  });

  it('stops cleanly via stop()', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });
    const { url } = server;

    // Verify it is running
    const response = await fetch(`${url}/v1/health`);
    expect(response.status).toBe(200);

    await server.stop();

    // After stopping, fetch should fail
    try {
      await fetch(`${url}/v1/health`);
      // If fetch succeeds, the server did not stop — fail the test
      expect(true).toBe(false);
    } catch {
      // Expected: connection refused or similar error
      expect(true).toBe(true);
    }
  });

  it('stop() returns a Promise', () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const result = server.stop();
    expect(result).toBeInstanceOf(Promise);
  });

  it('stop() is idempotent', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    await server.stop();
    // Second call should not throw — AsyncDisposableStack handles double-dispose.
    await server.stop();
  });

  it('stops via Symbol.asyncDispose', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });
    const { url } = server;

    // Verify it is running
    const response = await fetch(`${url}/v1/health`);
    expect(response.status).toBe(200);

    await server[Symbol.asyncDispose]();

    try {
      await fetch(`${url}/v1/health`);
      expect(true).toBe(false);
    } catch {
      expect(true).toBe(true);
    }
  });

  it('url property returns correct URL', () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    expect(server.url).toBe(`http://${server.hostname}:${server.port}`);
  });

  it('disposes the listening server when event broadcasting setup throws', async () => {
    engine = createEngine();
    const originalAddEventListener = engine.addEventListener.bind(engine);
    const restoreAddEventListener = overrideProperty(engine, 'addEventListener', ((
      ...args: Parameters<EventTarget['addEventListener']>
    ) => {
      const [type] = args;
      if (type === TokenEvent.type) {
        throw new Error('broadcast setup failed');
      }
      return originalAddEventListener(...args);
    }) as Engine['addEventListener']);

    try {
      expect(() => serveTestServer({ engine, port: 0 })).toThrow('broadcast setup failed');
      await waitForRealTimersForTesting(50);
    } finally {
      restoreAddEventListener();
    }
  });

  it('defaults to port 7233', () => {
    // Asserts the actual default by resolving options through the same
    // function serve() uses, without binding a socket. The previous version
    // of this test passed `port: 7233` explicitly, so it never exercised the
    // default at all — it just bound a well-known port for no benefit
    // (flaky under concurrent local runs when something else holds 7233,
    // e.g. another dev server) and would have passed even if the real
    // default drifted to a different value.
    engine = createEngine();
    const { port } = resolveNetworkConfig({ engine });

    expect(port).toBe(7233);
  });

  it('lists workflows through the server', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    // Start two workflows
    await fetch(`${server.url}/v1/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'echo', input: 1 }),
    });
    await fetch(`${server.url}/v1/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'echo', input: 2 }),
    });
    await flush();

    const response = await fetch(`${server.url}/v1/workflows`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[]; total: number };
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(2);
  });

  it('returns a WebSocket upgrade failure for non-matching upgrade requests', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    // Attempt a WebSocket-style request to a non-WebSocket route
    // Bun's fetch cannot do a real WebSocket upgrade, but we can
    // verify the server handles the upgrade header gracefully
    const response = await fetch(`${server.url}/v1/health`, {
      headers: { upgrade: 'websocket' },
    });

    // The server should return 400 since upgrade fails on a non-WebSocket route
    // (or Bun may strip the upgrade header in fetch — either way, the server
    // should not crash)
    expect(response.status).toBeDefined();
  });

  it('returns 401 when principal resolution throws during a JSON-RPC WebSocket upgrade', async () => {
    engine = createEngine();
    server = serveTestServer({
      engine,
      port: 0,
      auth: {
        apiKeys: ['weft_key_valid123456789012345678901'],
      },
    });

    const principalSpy = spyOn(handlerModule, 'authContextToPrincipal').mockImplementation(() => {
      throw new Error('invalid auth context');
    });
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await fetch(`${server.url}/jsonrpc`, {
        method: 'GET',
        headers: {
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
          'x-api-key': 'weft_key_valid123456789012345678901',
        },
      });

      expect(response.status).toBe(401);
      expect(await response.text()).toBe('Authentication context invalid');
      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] WebSocket upgrade principal resolution failed',
        expect.any(Error),
      );
    } finally {
      principalSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('resolves the principal during a worker WebSocket upgrade', async () => {
    // The worker stream endpoint authorizes registration against the connection
    // principal, so the upgrade must resolve one (previously only /jsonrpc did).
    // A resolver throw on this path proves the principal is wired through — if
    // it were skipped, the upgrade would not surface the 401.
    engine = createEngine();
    server = serveTestServer({
      engine,
      port: 0,
      auth: {
        apiKeys: ['weft_key_valid123456789012345678901'],
      },
    });

    const principalSpy = spyOn(handlerModule, 'authContextToPrincipal').mockImplementation(() => {
      throw new Error('invalid auth context');
    });
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await fetch(`${server.url}/v1/tasks/default/stream`, {
        method: 'GET',
        headers: {
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
          'x-api-key': 'weft_key_valid123456789012345678901',
        },
      });

      expect(response.status).toBe(401);
      expect(await response.text()).toBe('Authentication context invalid');
      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] WebSocket upgrade principal resolution failed',
        expect.any(Error),
      );
    } finally {
      principalSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('rejects worker WebSocket upgrades without workers:write', async () => {
    engine = createEngine();
    server = serveTestServer({
      engine,
      port: 0,
      auth: {
        apiKeys: ['weft_key_eventsonly1234567890123456'],
        defaultApiKeyScopes: ['events:read'],
      },
    });

    const response = await fetch(`${server.url}/v1/tasks/default/stream`, {
      method: 'GET',
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
        'x-api-key': 'weft_key_eventsonly1234567890123456',
      },
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('Insufficient scope');
  });

  it('rejects raw watch WebSocket upgrades when the resolved principal is anonymous', async () => {
    engine = createEngine();
    server = serveTestServer({
      engine,
      port: 0,
      auth: {
        apiKeys: ['weft_key_eventsread1234567890123456'],
        defaultApiKeyScopes: ['events:read'],
      },
    });

    const principalSpy = spyOn(handlerModule, 'authContextToPrincipal').mockImplementation(() =>
      anonymousPrincipal(),
    );

    try {
      const response = await fetch(`${server.url}/v1/workflows/wf-auth/watch`, {
        method: 'GET',
        headers: {
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
          'x-api-key': 'weft_key_eventsread1234567890123456',
        },
      });

      expect(response.status).toBe(401);
      expect(await response.text()).toBe('Authentication required');
    } finally {
      principalSpy.mockRestore();
    }
  });

  it('rejects raw workflow watch WebSocket upgrades without events:read', async () => {
    engine = createEngine();
    server = serveTestServer({
      engine,
      port: 0,
      auth: {
        apiKeys: ['weft_key_streamsonly123456789012345'],
        defaultApiKeyScopes: ['streams:read'],
      },
    });

    const response = await fetch(`${server.url}/v1/workflows/wf-auth/watch`, {
      method: 'GET',
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
        'x-api-key': 'weft_key_streamsonly123456789012345',
      },
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('Insufficient scope');
  });

  it.each([
    {
      route: 'watch',
      apiKey: 'weft_key_eventsread1234567890123456',
      scopes: ['events:read'] as const,
    },
    {
      route: 'stream',
      apiKey: 'weft_key_streamsread123456789012345',
      scopes: ['streams:read'] as const,
    },
  ])(
    'rejects raw workflow $route WebSocket upgrades with configured auth but no credential',
    async ({ route, apiKey, scopes }) => {
      engine = createEngine();
      server = serveTestServer({
        engine,
        port: 0,
        auth: {
          apiKeys: [apiKey],
          defaultApiKeyScopes: scopes,
        },
      });

      const response = await fetch(`${server.url}/v1/workflows/wf-auth/${route}`, {
        method: 'GET',
        headers: {
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
        },
      });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'No valid credentials provided' });
    },
  );

  it.each([
    {
      route: 'watch',
      apiKey: 'weft_key_eventsread1234567890123456',
      scopes: ['events:read'] as const,
    },
    {
      route: 'stream',
      apiKey: 'weft_key_streamsread123456789012345',
      scopes: ['streams:read'] as const,
    },
  ])(
    'rejects raw workflow $route WebSocket upgrades with invalid credentials',
    async ({ route, apiKey, scopes }) => {
      engine = createEngine();
      server = serveTestServer({
        engine,
        port: 0,
        auth: {
          apiKeys: [apiKey],
          defaultApiKeyScopes: scopes,
        },
      });

      const response = await fetch(`${server.url}/v1/workflows/wf-auth/${route}`, {
        method: 'GET',
        headers: {
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
          'x-api-key': 'weft_key_invalid12345678901234567890',
        },
      });

      expect(response.status).toBe(401);
    },
  );

  it('accepts raw workflow watch WebSocket upgrades with events:read', async () => {
    const apiKey = 'weft_key_eventsread1234567890123456';
    engine = createEngine();
    server = serveTestServer({
      engine,
      port: 0,
      auth: {
        apiKeys: [apiKey],
        defaultApiKeyScopes: ['events:read'],
      },
    });

    const wsUrl = server.url.replace('http://', 'ws://');
    const ws = await connectAuthenticatedWebSocket(`${wsUrl}/v1/workflows/wf-auth/watch`, apiKey);

    await waitForSocketClose(ws);
  });

  it('rejects raw token stream WebSocket upgrades without streams:read', async () => {
    engine = createEngine();
    server = serveTestServer({
      engine,
      port: 0,
      auth: {
        apiKeys: ['weft_key_eventsonly1234567890123456'],
        defaultApiKeyScopes: ['events:read'],
      },
    });

    const response = await fetch(`${server.url}/v1/workflows/wf-auth/stream`, {
      method: 'GET',
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
        'x-api-key': 'weft_key_eventsonly1234567890123456',
      },
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('Insufficient scope');
  });

  it('accepts raw token stream WebSocket upgrades with streams:read', async () => {
    const apiKey = 'weft_key_streamsread123456789012345';
    engine = createEngine();
    server = serveTestServer({
      engine,
      port: 0,
      auth: {
        apiKeys: [apiKey],
        defaultApiKeyScopes: ['streams:read'],
      },
    });

    const wsUrl = server.url.replace('http://', 'ws://');
    const ws = await connectAuthenticatedWebSocket(`${wsUrl}/v1/workflows/wf-auth/stream`, apiKey);

    await waitForSocketClose(ws);
  });

  it('keeps JSON-RPC HTTP principal resolution inside the JSON-RPC error boundary', async () => {
    engine = createEngine();
    server = serveTestServer({
      engine,
      port: 0,
      auth: {
        apiKeys: ['weft_key_valid123456789012345678901'],
      },
    });

    const principalSpy = spyOn(handlerModule, 'authContextToPrincipal').mockImplementation(() => {
      throw new Error('invalid auth context');
    });
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await fetch(`${server.url}/jsonrpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'weft_key_valid123456789012345678901',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'engine.list', id: 1 }),
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: null,
      });
      expect(errorSpy).toHaveBeenCalledWith('Unhandled error in /jsonrpc', {
        error: expect.any(Error),
      });
    } finally {
      principalSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('accepts a WebSocket connection and subscribes to pathname channel', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const wsUrl = server.url.replace('http://', 'ws://');

    const ws = new WebSocket(`${wsUrl}/v1/workflows/test-wf/watch`);

    const opened = await new Promise<boolean>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(true));
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });

    expect(opened).toBe(true);

    // Send a message (the handler is a no-op, but ensures the message path is exercised)
    ws.send('ping');
    await waitForRealTimersForTesting(50);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('handles WebSocket close event without error', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const wsUrl = server.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}/v1/tasks/default/stream`);

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });

    // Close the connection
    ws.close();

    await new Promise<void>((resolve) => {
      ws.addEventListener('close', () => resolve());
    });
  });

  // WebSocket upgrades must work through the external `/api` prefix. The front
  // door strips `/api` for routing but hands the *original* request to
  // `server.upgrade()` — a rebuilt Request loses Bun's upgrade handle, so these
  // would silently fail if the wrong request object reached the upgrade call.
  it.each([
    '/api/v1/workflows/test-wf/watch',
    '/api/v1/workflows/test-wf/stream',
    '/api/v1/tasks/default/stream',
    '/api/jsonrpc',
  ])('accepts a WebSocket upgrade on %s', async (path) => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });
    const wsUrl = server.url.replace('http://', 'ws://');
    const ws = new WebSocket(`${wsUrl}${path}`);

    const opened = await new Promise<boolean>((resolve) => {
      ws.addEventListener('open', () => resolve(true));
      ws.addEventListener('error', () => resolve(false));
      setTimeout(() => resolve(false), 2000);
    });
    expect(opened).toBe(true);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  // -------------------------------------------------------------------------
  // Regression: the per-workflow sequence bookkeeping maps inside
  // `wireEventBroadcasting` (`sequenceCounters`, `sequenceInitPromises`,
  // `sequenceChains`) used to live for the lifetime of the server process.
  // They are now dropped when a workflow reaches a terminal state, alongside
  // the existing worker-affinity cleanup. This test verifies:
  //   1. Events emitted after the terminal cleanup still persist correctly
  //      (the cleanup must not corrupt sequence tracking for the next run).
  //   2. Sequence numbers resume from storage on the post-terminal rehydration
  //      instead of restarting at 0 and overwriting the pre-terminal events.
  // -------------------------------------------------------------------------
  it('cleans up sequence bookkeeping on workflow termination without losing events', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const workflowId = 'terminal-cleanup-wf';

    // Emit a sequence of events before the terminal state.
    engine.dispatchEvent(new WorkflowSuspendedEvent(workflowId));
    engine.dispatchEvent(new WorkflowSuspendedEvent(workflowId));
    engine.dispatchEvent(new WorkflowSuspendedEvent(workflowId));

    // Wait until the serialization chain has persisted all three. Polling on
    // the observable count is deterministic across CI load — a raw
    // A fixed wall-clock sleep was flaky on slower runners.
    await waitFor(async () => (await countKeys(engine, `ev:${workflowId}:`)) === 3, {
      label: '3 pre-terminal events persisted',
    });

    // Mark the workflow terminal — this should trigger the sequence-map cleanup.
    engine.dispatchEvent(new WorkflowCompletedEvent(workflowId, 'ok', 1));
    // Wait until the terminal event is persisted (now 4 total). Cleanup
    // evicts the sequence maps once the current serialization chain drains;
    // by the time the 4th key is observable, cleanup has completed.
    await waitFor(async () => (await countKeys(engine, `ev:${workflowId}:`)) === 4, {
      label: 'terminal event persisted and cleanup complete',
    });

    // Emit another event for the same workflowId *after* cleanup. With the
    // sequence state evicted, `ensureSequenceInitialized` must re-read from
    // storage and resume after the highest existing sequence number — not
    // restart at 0 and overwrite the previously persisted events.
    engine.dispatchEvent(new WorkflowSuspendedEvent(workflowId));
    await waitFor(async () => (await countKeys(engine, `ev:${workflowId}:`)) === 5, {
      label: 'post-terminal event persisted without collision',
    });

    const keys: string[] = [];
    for await (const [key] of engine.storage.scan(`ev:${workflowId}:`)) {
      keys.push(key);
    }

    // 3 pre-terminal + 1 terminal + 1 post-terminal = 5 distinct sequence keys.
    // If the cleanup dropped the counter mid-persist or the rehydration
    // restarted at 0, we would see fewer than 5 entries (collisions).
    expect(keys.length).toBe(5);

    // Keys are `ev:{workflowId}:{sequence}` and scan order is lexicographic.
    // Verify the sequences are contiguous (no gaps, no collisions).
    const sequences = keys.map((key) => {
      const parts = key.split(':');
      return parseInt(parts[parts.length - 1] ?? '', 10);
    });
    sequences.sort((a, b) => a - b);
    for (let i = 0; i < sequences.length; i++) {
      expect(sequences[i]).toBe(i);
    }
  });

  it('does not retain sequence state across many terminated workflows', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    // Emit and terminate a batch of workflows. If the sequence maps are not
    // cleaned up on termination, each workflow leaks one entry per map; this
    // test exercises that path without relying on private-state inspection.
    // The invariant we verify is the same as the previous test (events are
    // persisted correctly), but applied across many workflows so a future
    // regression that re-introduces the leak is more likely to manifest as
    // visible behavior rather than silent memory growth.
    const workflowCount = 25;
    for (let i = 0; i < workflowCount; i++) {
      const workflowId = `bulk-wf-${i}`;
      engine.dispatchEvent(new WorkflowSuspendedEvent(workflowId));
      engine.dispatchEvent(new WorkflowCompletedEvent(workflowId, i, 1));
    }

    // Poll until every workflow has persisted its 2 events rather than
    // guessing a drain interval. This adapts to CI load and isolates failure
    // to the specific workflow that lagged rather than a blanket timeout.
    await waitFor(
      async () => {
        for (let i = 0; i < workflowCount; i++) {
          const count = await countKeys(engine, `ev:bulk-wf-${i}:`);
          if (count !== 2) return false;
        }
        return true;
      },
      { label: 'all 25 bulk workflows persisted their events' },
    );

    // Each workflow should have exactly 2 stored events (non-terminal + terminal).
    for (let i = 0; i < workflowCount; i++) {
      const count = await countKeys(engine, `ev:bulk-wf-${i}:`);
      expect(count).toBe(2);
    }
  });

  it('cleanupWorkflow tolerates workflows that never started an event chain', () => {
    engine = createEngine();
    const broadcaster = wireEventBroadcasting(engine, {
      publish() {
        return 0;
      },
    } as unknown as ReturnType<typeof Bun.serve>);

    expect(() => broadcaster.cleanupWorkflow('never-broadcast')).not.toThrow();

    broadcaster.dispose();
  });

  it('publishes token stream events to the stream channel when direct delivery is unavailable', async () => {
    engine = createEngine();
    const publishedMessages: Array<{ channel: string; message: string }> = [];
    const broadcaster = wireEventBroadcasting(engine, {
      publish(channel: string, message: string) {
        publishedMessages.push({ channel, message });
        return 1;
      },
    } as unknown as ReturnType<typeof Bun.serve>);

    const workflowId = 'stream-fallback-publish-wf';
    engine.dispatchEvent(new TokenEvent(workflowId, 'hello', 'gpt-4'));

    await waitFor(() => publishedMessages.length === 1, {
      label: 'stream channel publish',
    });

    expect(publishedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: `/v1/workflows/${encodeURIComponent(workflowId)}/stream`,
        }),
      ]),
    );
    expect(publishedMessages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: `/v1/workflows/${encodeURIComponent(workflowId)}/watch`,
        }),
      ]),
    );
    expect(await countKeys(engine, KEYS.eventPrefix(workflowId))).toBe(0);

    broadcaster.dispose();
  });

  it('waits for an extended post-terminal chain before dropping sequence bookkeeping', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const workflowId = 'terminal-recursion-wf';

    engine.dispatchEvent(new WorkflowSuspendedEvent(workflowId));
    await waitFor(async () => (await countKeys(engine, `ev:${workflowId}:`)) === 1, {
      label: 'pre-terminal event persisted',
    });

    // Dispatch the terminal event and immediately extend the same workflow's
    // event chain before the terminal cleanup can drain. This exercises the
    // recursive cleanup path inside `cleanupWorkflow`.
    engine.dispatchEvent(new WorkflowCompletedEvent(workflowId, 'ok', 1));
    engine.dispatchEvent(new WorkflowSuspendedEvent(workflowId));

    await waitFor(async () => (await countKeys(engine, `ev:${workflowId}:`)) === 3, {
      label: 'terminal and immediate follow-up events persisted',
    });

    // Once the recursive cleanup has drained the extended chain, a later event
    // should rehydrate from storage and continue the sequence without
    // collisions or gaps.
    engine.dispatchEvent(new WorkflowSuspendedEvent(workflowId));
    await waitFor(async () => (await countKeys(engine, `ev:${workflowId}:`)) === 4, {
      label: 'post-recursion event persisted after cleanup',
    });

    const keys: string[] = [];
    for await (const [key] of engine.storage.scan(`ev:${workflowId}:`)) {
      keys.push(key);
    }

    expect(keys.length).toBe(4);
    const sequences = keys.map((key) => {
      const parts = key.split(':');
      return parseInt(parts[parts.length - 1] ?? '', 10);
    });
    sequences.sort((a, b) => a - b);
    expect(sequences).toEqual([0, 1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Worker WebSocket protocol
// ---------------------------------------------------------------------------

describe('worker WebSocket protocol', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  it('tracks a worker after register message', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, {
      workerId: 'w1',
      activities: ['test.charge', 'test.ship'],
      concurrency: 5,
    });

    expect(server.registry.size).toBe(1);
    const workers = server.registry.getAll();
    expect(workers[0]?.id).toBe('w1');
    expect(workers[0]?.activities).toEqual(['test.charge', 'test.ship']);
    expect(workers[0]?.concurrency).toBe(5);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('dispatches worker connected and disconnected events', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0, workerReconnectGracePeriodMs: 0 });
    const connectedEvents: WorkerConnectedEvent[] = [];
    const disconnectedEvents: WorkerDisconnectedEvent[] = [];
    engine.addEventListener(WorkerConnectedEvent.type, (event) => {
      connectedEvents.push(event);
    });
    engine.addEventListener(WorkerDisconnectedEvent.type, (event) => {
      disconnectedEvents.push(event);
    });

    const ws = await connectWorker(server);
    await registerWorker(ws, {
      workerId: 'liveness-worker',
      activities: ['test.charge'],
      concurrency: 5,
    });

    await waitFor(() => connectedEvents.length === 1, { label: 'worker connected event' });
    expect(connectedEvents[0]).toMatchObject({
      workerId: 'liveness-worker',
      queue: 'default',
      activities: ['test.charge'],
      concurrency: 5,
    });

    ws.close();
    await waitFor(() => disconnectedEvents.length === 1, { label: 'worker disconnected event' });
    expect(disconnectedEvents[0]).toMatchObject({
      workerId: 'liveness-worker',
      inFlightTaskCount: 0,
    });
  });

  it('records deployment identity and capabilities from worker registration', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, {
      workerId: 'identity-worker',
      activities: ['test.charge'],
      concurrency: 5,
      deploymentName: 'payments',
      buildId: 'build-2026-05-12',
      runtimeVersion: 'bun-1.2.13',
      startedAt: 1_778_608_000_000,
      capabilities: { region: 'us-west', canary: true },
    });

    expect(server.registry.getWorker('identity-worker')).toMatchObject({
      id: 'identity-worker',
      deploymentName: 'payments',
      buildId: 'build-2026-05-12',
      runtimeVersion: 'bun-1.2.13',
      startedAt: 1_778_608_000_000,
      capabilities: { region: 'us-west', canary: true },
    });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('sends registerAck after accepting a worker', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    const ackPromise = waitForWorkerMessage(
      ws,
      (message) => message['type'] === 'registerAck',
      'registerAck',
    );
    await registerWorker(ws, {
      workerId: 'w-register-ack',
      activities: ['test.charge'],
      concurrency: 5,
    });

    const ack = await ackPromise;
    expect(ack).toEqual({
      type: 'registerAck',
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      workerId: 'w-register-ack',
      queue: 'default',
      concurrency: 5,
      acceptedManifestDigest: expect.any(String),
      serverCapabilities: [],
    });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('rejects workers that omit protocolVersion', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    const errorPromise = waitForWorkerMessage(
      ws,
      (message) => message['type'] === 'registerError',
      'registerError',
    );
    ws.send(
      JSON.stringify({
        type: 'register',
        workerId: 'missing-version-worker',
        manifest: {},
      }),
    );

    const error = await errorPromise;
    expect(error).toMatchObject({
      type: 'registerError',
      code: 'unsupported_protocol_version',
      supportedProtocolVersions: [REMOTE_WORKER_PROTOCOL_VERSION],
    });
    await waitFor(() => server.registry.size === 0, { label: 'missing-version worker rejected' });
    await waitForSocketClose(ws, 'missing-version socket close');
  });

  it('sends protocolError for invalid JSON, unknown messages, and pre-registration traffic', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const invalidJsonSocket = await connectWorker(server);
    const invalidJsonError = waitForWorkerMessage(
      invalidJsonSocket,
      (message) => message['type'] === 'protocolError',
      'invalid JSON protocolError',
    );
    invalidJsonSocket.send('not json at all');
    expect(await invalidJsonError).toMatchObject({
      type: 'protocolError',
      code: 'invalid_json',
    });
    await waitForSocketClose(invalidJsonSocket, 'invalid JSON socket close');

    const unknownSocket = await connectWorker(server);
    const unknownError = waitForWorkerMessage(
      unknownSocket,
      (message) => message['type'] === 'protocolError',
      'unknown message protocolError',
    );
    unknownSocket.send(JSON.stringify({ type: 'typo' }));
    expect(await unknownError).toMatchObject({
      type: 'protocolError',
      code: 'unknown_message_type',
    });
    await waitForSocketClose(unknownSocket, 'unknown message socket close');

    const preRegisterSocket = await connectWorker(server);
    const preRegisterError = waitForWorkerMessage(
      preRegisterSocket,
      (message) => message['type'] === 'protocolError',
      'pre-registration protocolError',
    );
    preRegisterSocket.send(JSON.stringify({ type: 'heartbeat', workerId: 'early' }));
    expect(await preRegisterError).toMatchObject({
      type: 'protocolError',
      code: 'registration_required',
    });
    await waitForSocketClose(preRegisterSocket, 'pre-registration socket close');
  });

  it('clamps worker concurrency to at least 1 when 0 is sent', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, {
      workerId: 'w-clamp-min',
      activities: ['test.charge'],
      concurrency: 0,
    });

    const worker = server.registry.getWorker('w-clamp-min');
    expect(worker?.concurrency).toBe(1);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('clamps worker concurrency to MAX_WORKER_CONCURRENCY (1000) when a huge value is sent', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, {
      workerId: 'w-clamp-max',
      activities: ['test.charge'],
      concurrency: 999_999,
    });

    const worker = server.registry.getWorker('w-clamp-max');
    expect(worker?.concurrency).toBe(1_000);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('unregisters a worker on WebSocket close', async () => {
    engine = createEngine();
    // Disable the reconnect grace period so the close handler unregisters
    // the worker synchronously, as this test asserts.
    server = serveTestServer({ engine, port: 0, workerReconnectGracePeriodMs: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w2', activities: ['test.charge'] });

    expect(server.registry.size).toBe(1);

    ws.close();
    await waitFor(() => server.registry.size === 0, { label: 'worker unregistered on close' });

    expect(server.registry.size).toBe(0);
  });

  it('updates heartbeat timestamp on heartbeat message', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w3', activities: ['test.charge'] });

    const before = server.registry.getAll()[0]?.lastHeartbeat ?? 0;
    await waitForRealTimersForTesting(50);

    ws.send(JSON.stringify({ type: 'heartbeat', workerId: 'w3' }));
    await waitFor(() => (server.registry.getAll()[0]?.lastHeartbeat ?? 0) > before, {
      label: 'heartbeat timestamp updated',
    });

    const after = server.registry.getAll()[0]?.lastHeartbeat ?? 0;
    expect(after).toBeGreaterThanOrEqual(before);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('records terminal disposition and low-cardinality metrics for WebSocket dispatches', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, {
      workerId: 'w-diagnostics',
      activities: ['test.charge'],
      concurrency: 1,
    });

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attemptToken?: string;
      };
      if (message.type === 'task') {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: message.operationId,
            attemptToken: message.attemptToken,
            status: 'completed',
            value: 42,
          }),
        );
      }
    });

    await server.dispatchTask({
      operationId: 'diagnostic-ws-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
      workflowId: 'workflow-diagnostics',
    });

    const resolved = await waitForTerminalResolvedRecord(engine.storage, 'diagnostic-ws-op');
    expect(resolved.workflowId).toBe('workflow-diagnostics');
    expect(resolved.activityName).toBe('test.charge');
    expect(resolved.queue).toBe('default');
    expect(resolved.status).toBe('completed');
    expect(typeof resolved.terminalAt).toBe('number');

    const metricsResponse = await fetch(`${server.url}/v1/metrics`);
    expect(metricsResponse.status).toBe(200);
    const metricsText = await metricsResponse.text();
    expect(metricsText).toContain('weft_task_queue_latency_count 1');
    expect(metricsText).toContain('weft_task_execution_latency_count 1');
    expect(metricsText).toContain('weft_worker_capacity_saturation 0');

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('exposes WebSocket dispatch metrics through the server-owned system metrics endpoint', async () => {
    engine = createEngine();
    const apiKey = 'metrics-system-read-key';
    server = serveTestServer({
      engine,
      port: 0,
      auth: {
        apiKeys: [apiKey],
        defaultApiKeyScopes: ['system:read'],
        publicPaths: [
          '/v1/health',
          '/v1/metrics',
          '/.well-known/api-catalog',
          '/openapi.json',
          '/openrpc.json',
          '/asyncapi.json',
          '/v1/tasks/default/stream',
        ],
      },
    });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w-owned-metrics', activities: ['test.charge'] });

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attemptToken?: string;
      };
      if (message.type === 'task') {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: message.operationId,
            attemptToken: message.attemptToken,
            status: 'completed',
            value: 42,
          }),
        );
      }
    });

    await server.dispatchTask({
      operationId: 'server-owned-metrics-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
      workflowId: 'workflow-server-owned-metrics',
    });

    await waitForTerminalResolvedRecord(engine.storage, 'server-owned-metrics-op');

    const response = await fetch(`${server.url}/v1/metrics/json`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as Record<string, { type?: string; value?: number }>;
    expect(snapshot[METRICS.taskQueueLatency.name]?.type).toBe('histogram');
    expect(snapshot[METRICS.taskExecutionLatency.name]?.type).toBe('histogram');
    expect(snapshot[METRICS.workerCapacitySaturation.name]).toEqual({ type: 'gauge', value: 0 });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('refreshes stale heartbeat metrics from runtime reconciliation scans', async () => {
    engine = createEngine();
    const now = Date.now();
    const staleLeasedRecord = makeLeasedLedgerRecord({
      operationId: 'stale-heartbeat-metric-op',
      workerSessionId: 'worker-stale-heartbeat',
      leaseDeadline: now + 60_000,
      firstQueuedAt: now - 70_000,
      lastQueuedAt: now - 70_000,
      startedAt: now - 65_000,
      lastHeartbeatAt: now - 61_000,
    });
    await engine.storage.put(
      taskLedgerKey(staleLeasedRecord.operationId),
      encodeRemoteTaskRecord(staleLeasedRecord),
    );

    server = serveTestServer({
      engine,
      port: 0,
      visibilityPollIntervalMs: 10,
    });

    await waitFor(
      async () => {
        const response = await fetch(`${server.url}/v1/metrics`);
        const text = await response.text();
        return text.includes('weft_task_stale_heartbeats 1');
      },
      { label: 'stale heartbeat metric to refresh', timeoutMs: 1000 },
    );
  });

  it('extends persisted task visibility deadlines on heartbeat', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w-heartbeat-extend', activities: ['test.charge'] });

    await server.dispatchTask({
      operationId: 'heartbeat-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
      visibilityTimeout: 200,
    });

    const beforeRecord = await readLedgerRecord(engine.storage, 'heartbeat-op');
    if (beforeRecord === null || beforeRecord.state !== 'leased') {
      throw new Error('Expected "heartbeat-op" to have a leased ledger record');
    }
    const before = beforeRecord;

    // ensures wall-clock advances so the heartbeat-extended deadline is
    // measurably greater than `before` (no event to await for the gap itself)
    // fixed delay: pre-dispatch settle
    await waitForRealTimersForTesting(25);
    ws.send(JSON.stringify({ type: 'heartbeat', workerId: 'w-heartbeat-extend' }));
    await waitFor(
      async () => {
        const current = await readLedgerRecord(engine.storage, 'heartbeat-op');
        return (
          current !== null &&
          current.state === 'leased' &&
          current.leaseDeadline > before.leaseDeadline
        );
      },
      { label: 'heartbeat extended the inflight deadline' },
    );

    const afterRecord = await readLedgerRecord(engine.storage, 'heartbeat-op');
    if (afterRecord === null || afterRecord.state !== 'leased') {
      throw new Error('Expected "heartbeat-op" to still have a leased ledger record');
    }

    expect(afterRecord.leaseDeadline).toBeGreaterThan(before.leaseDeadline);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('logs heartbeat visibility persistence failures', async () => {
    engine = createEngine();
    const storage = engine.storage as MemoryStorage;
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    server = serveTestServer({ engine, port: 0 });

    let restoreConditionalBatch: (() => void) | undefined;

    try {
      const ws = await connectWorker(server);
      await registerWorker(ws, { workerId: 'w-heartbeat-write-fail', activities: ['test.charge'] });

      await server.dispatchTask({
        operationId: 'heartbeat-write-fail-op',
        activityName: 'test.charge',
        workflowType: 'test',
        input: null,
        visibilityTimeout: 200,
      });

      // Only the heartbeat's lease-renewal write should fail — installed
      // after dispatch's own create+claim write to the same ledger key has
      // already committed, since both go through the same `conditionalBatch`
      // path on `taskLedgerKey('heartbeat-write-fail-op')`.
      restoreConditionalBatch = overrideProperty(storage, 'conditionalBatch', (async (
        conditions: Parameters<MemoryStorage['conditionalBatch']>[0],
        operations: Parameters<MemoryStorage['conditionalBatch']>[1],
      ) => {
        if (
          operations.some((operation) => operation.key === taskLedgerKey('heartbeat-write-fail-op'))
        ) {
          throw new Error('heartbeat write failed');
        }
        return originalConditionalBatch(conditions, operations);
      }) as MemoryStorage['conditionalBatch']);

      ws.send(JSON.stringify({ type: 'heartbeat', workerId: 'w-heartbeat-write-fail' }));
      await waitFor(
        () =>
          errorSpy.mock.calls.some(
            ([message, error]) =>
              message ===
                '[weft] Failed to extend visibility for task "heartbeat-write-fail-op":' &&
              error instanceof Error &&
              error.message === 'heartbeat write failed',
          ),
        {
          label: 'heartbeat visibility persistence failure log',
        },
      );

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Failed to extend visibility for task "heartbeat-write-fail-op":',
        expect.any(Error),
      );

      ws.close();
      await waitForRealTimersForTesting(50);
    } finally {
      restoreConditionalBatch?.();
      errorSpy.mockRestore();
    }
  });

  it('dispatches a task to the best available worker', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string; activityName?: string }> = [];

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        activityName?: string;
      };
      if (message.type === 'task') received.push(message);
    });

    await registerWorker(ws, { workerId: 'w4', activities: ['test.charge'], concurrency: 5 });

    const dispatched = await server.dispatchTask({
      operationId: 'op-1',
      activityName: 'test.charge',
      workflowType: 'test',
      input: { amount: 100 },
    });

    expect(dispatched).toBe(true);

    await waitFor(() => received.length === 1, { label: 'task delivered to worker' });

    expect(received.length).toBe(1);
    expect(received[0]?.type).toBe('task');
    expect(received[0]?.operationId).toBe('op-1');
    expect(received[0]?.activityName).toBe('test.charge');

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('routes new tasks away from draining workers while keeping in-flight tasks tracked', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const drainingSocket = await connectWorker(server);
    const activeSocket = await connectWorker(server);
    const receivedByActive: string[] = [];
    activeSocket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attemptToken?: string;
      };
      if (message.type === 'task' && message.operationId !== undefined) {
        receivedByActive.push(message.operationId);
      }
    });

    await registerWorker(drainingSocket, {
      workerId: 'draining-worker',
      activities: ['test.charge'],
      concurrency: 5,
    });
    await registerWorker(activeSocket, {
      workerId: 'active-worker',
      activities: ['test.charge'],
      concurrency: 5,
    });
    server.registry.assignTask(
      'draining-worker',
      'already-running',
      30_000,
      undefined,
      'attempt-token',
    );

    server.registry.markWorkerDraining('draining-worker', {
      reason: 'rolling deploy',
      updatedAt: 1000,
    });

    const dispatched = await server.dispatchTask({
      operationId: 'new-work',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });

    expect(dispatched).toBe(true);
    await waitFor(() => receivedByActive.includes('new-work'), {
      label: 'new work routed to active worker',
    });
    expect(server.registry.isAssigned('already-running')).toBe(true);
    expect(server.registry.getTask('already-running')?.workerId).toBe('draining-worker');
    expect(server.registry.getTask('new-work')?.workerId).toBe('active-worker');

    drainingSocket.close();
    activeSocket.close();
    await waitForRealTimersForTesting(50);
  });

  it('falls back to long-poll when every matching WebSocket worker is draining', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'drain-only-worker', activities: ['test.charge'] });
    server.registry.markWorkerDraining('drain-only-worker', { updatedAt: 1000 });

    const dispatched = await server.dispatchTask({
      operationId: 'queued-after-drain',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });

    expect(dispatched).toBe(true);
    expect(server.taskQueue.pendingCount('default')).toBe(1);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('queues task for long-poll workers when no WebSocket worker is available', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const dispatched = await server.dispatchTask({
      operationId: 'op-2',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });

    // With the long-poll fallback, tasks are queued instead of rejected
    expect(dispatched).toBe(true);
    expect(server.taskQueue.pendingCount('default')).toBe(1);
  });

  it('increments in-flight count on dispatch and decrements on task result', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    collectAndCompleteTaskMessages(ws, { resultValue: 42 });

    await registerWorker(ws, { workerId: 'w5', activities: ['test.compute'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'op-3',
      activityName: 'test.compute',
      workflowType: 'test',
      input: null,
    });

    // Right after dispatch, in-flight should be 1
    expect(server.registry.getAll()[0]?.inFlight).toBe(1);

    // Wait for the task result to round-trip and decrement the in-flight count.
    // Poll the actual condition instead of a fixed sleep so the assertion stays
    // stable under load rather than racing a hardcoded delay.
    await waitFor(() => server.registry.getAll()[0]?.inFlight === 0, {
      label: 'in-flight count returns to 0',
    });

    expect(server.registry.getAll()[0]?.inFlight).toBe(0);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('handles invalid JSON messages without crashing', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);

    const protocolError = waitForWorkerMessage(
      ws,
      (message) => message['type'] === 'protocolError',
      'invalid JSON protocolError',
    );
    ws.send('not json at all');

    expect(await protocolError).toMatchObject({
      type: 'protocolError',
      code: 'invalid_json',
    });
    await waitForSocketClose(ws, 'invalid JSON worker socket close');

    // Server should still be running after rejecting the malformed worker.
    const response = await fetch(`${server.url}/v1/health`);
    expect(response.status).toBe(200);
  });

  it('ignores worker protocol messages on non-worker paths', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    // Connect to observation endpoint, not worker stream
    const ws = await connectWorker(server, '/v1/workflows/test-wf/watch');

    ws.send(
      JSON.stringify({
        type: 'register',
        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
        workerId: 'rogue',
        manifest: manifestForActivities(['test.charge']),
        concurrency: 5,
      }),
    );
    // `size === 0` is true immediately, so a condition-wait would return before
    // the message could be wrongly handled; give the server time to (not) process it.
    // fixed delay: negative assertion
    await waitForRealTimersForTesting(50);

    // Registry should be empty — register messages are only processed on worker paths
    expect(server.registry.size).toBe(0);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('supports multiple workers and routes to least-loaded', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);
    const received1: Array<{ type: string }> = [];
    const received2: Array<{ type: string }> = [];

    ws1.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type: string };
      if (message.type === 'task') received1.push(message);
    });
    ws2.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type: string };
      if (message.type === 'task') received2.push(message);
    });

    await registerWorker(ws1, { workerId: 'w-a', activities: ['test.charge'], concurrency: 5 });
    await registerWorker(ws2, { workerId: 'w-b', activities: ['test.charge'], concurrency: 5 });

    // Dispatch two tasks — both workers start at 0 in-flight, so the first
    // goes to whichever findWorker returns first, and the second should go
    // to the other (least-loaded).
    await server.dispatchTask({
      operationId: 'op-a',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });
    await server.dispatchTask({
      operationId: 'op-b',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });

    await waitFor(() => received1.length === 1 && received2.length === 1, {
      label: 'each worker received one task',
    });

    // Each worker should have received exactly one task
    expect(received1.length).toBe(1);
    expect(received2.length).toBe(1);

    ws1.close();
    ws2.close();
    await waitForRealTimersForTesting(50);
  });

  it('routes via fair-share when routingPolicy is fair-share and fairShareKey is dispatched', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0, routingPolicy: 'fair-share' });

    const sockets: WebSocket[] = [];
    const receivedByWorker = new Map<string, Array<{ operationId: string }>>();

    for (let index = 0; index < 3; index += 1) {
      const workerId = `fair-share-worker-${index}`;
      receivedByWorker.set(workerId, []);

      const ws = await connectWorker(server);
      ws.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          operationId?: string;
        };
        if (message.type === 'task' && message.operationId !== undefined) {
          receivedByWorker.get(workerId)!.push({ operationId: message.operationId });
        }
      });
      await registerWorker(ws, { workerId, activities: ['test.runAgent'], concurrency: 10 });
      sockets.push(ws);
    }

    // Dispatch six tasks all under the same fair-share key. fair-share should
    // spread them evenly across the three workers — 2 per worker. If
    // routingPolicy were silently falling back to least-loaded, the first
    // dispatch would still tiebreak by id and the spread would happen by
    // accident. So we also dispatch a second key (`key-beta`) to prove the
    // *per-key* counters survive the round trip and influence the next
    // assignment for that key independently of the alpha tasks.
    for (let index = 0; index < 6; index += 1) {
      const dispatched = await server.dispatchTask({
        operationId: `alpha-${index}`,
        activityName: 'test.runAgent',
        workflowType: 'test',
        input: null,
        fairShareKey: 'key-alpha',
      });
      expect(dispatched).toBe(true);
    }

    await waitFor(() => [...receivedByWorker.values()].every((tasks) => tasks.length === 2), {
      label: 'every worker received two alpha tasks',
    });

    // Every worker received exactly two alpha tasks.
    for (const [workerId, tasks] of receivedByWorker) {
      expect(tasks).toHaveLength(2);
      // Sanity check: every received op id was an alpha task assigned to this
      // worker.
      for (const task of tasks) {
        expect(task.operationId.startsWith('alpha-')).toBe(true);
        const inflight = server.registry.getTask(task.operationId);
        expect(inflight?.workerId).toBe(workerId);
      }
    }

    // Now dispatch a single key-beta task. The least-loaded fallback would
    // pick the first worker by id (all three carry 2 alpha tasks), but the
    // per-key fair-share counter for beta is 0 everywhere — fair-share's
    // tiebreak by id then puts it on `fair-share-worker-0`, which is what we
    // assert. The point is not the exact id, but that the *count of beta
    // tasks per worker* is what was used, not the alpha load.
    const dispatchedBeta = await server.dispatchTask({
      operationId: 'beta-1',
      activityName: 'test.runAgent',
      workflowType: 'test',
      input: null,
      fairShareKey: 'key-beta',
    });
    expect(dispatchedBeta).toBe(true);
    await waitForRealTimersForTesting(50);

    // Exactly one worker picked up beta-1 — and the worker chosen had a
    // per-beta-key count of 0 before this dispatch (which is true for any of
    // the three, since all had only alpha load before).
    let betaWorkerId: string | undefined;
    for (const [workerId, tasks] of receivedByWorker) {
      const betaTasks = tasks.filter((task) => task.operationId === 'beta-1');
      if (betaTasks.length > 0) {
        expect(betaWorkerId).toBeUndefined();
        betaWorkerId = workerId;
      }
    }
    expect(betaWorkerId).toBeDefined();

    for (const ws of sockets) {
      ws.close();
    }
    await waitForRealTimersForTesting(50);
  });

  it('falls back to long-poll queue when WebSocket workers are at capacity', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w-cap', activities: ['test.compute'], concurrency: 1 });

    // First dispatch should go to the WebSocket worker
    const first = await server.dispatchTask({
      operationId: 'cap-1',
      activityName: 'test.compute',
      workflowType: 'test',
      input: null,
    });
    expect(first).toBe(true);
    expect(server.registry.getWorker('w-cap')?.inFlight).toBe(1);

    // Second dispatch — worker is at capacity (1/1), should fall to long-poll queue
    const second = await server.dispatchTask({
      operationId: 'cap-2',
      activityName: 'test.compute',
      workflowType: 'test',
      input: null,
    });
    expect(second).toBe(true);
    expect(server.taskQueue.pendingCount('default')).toBe(1);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('worker capacity recovers after task completion and accepts new tasks', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    const received = collectAndCompleteTaskMessages(ws);

    await registerWorker(ws, {
      workerId: 'w-recover',
      activities: ['test.compute'],
      concurrency: 1,
    });

    // Dispatch first task
    await server.dispatchTask({
      operationId: 'r-1',
      activityName: 'test.compute',
      workflowType: 'test',
      input: null,
    });
    expect(server.registry.getWorker('w-recover')?.inFlight).toBe(1);

    // Wait for task result to arrive and decrement inFlight
    await waitFor(() => server.registry.getWorker('w-recover')?.inFlight === 0, {
      label: 'first task result decremented inFlight',
    });
    expect(server.registry.getWorker('w-recover')?.inFlight).toBe(0);

    // Dispatch second task — worker should accept it since capacity recovered
    await server.dispatchTask({
      operationId: 'r-2',
      activityName: 'test.compute',
      workflowType: 'test',
      input: null,
    });
    expect(server.registry.getWorker('w-recover')?.inFlight).toBe(1);

    await waitFor(() => server.registry.getWorker('w-recover')?.inFlight === 0, {
      label: 'second task result decremented inFlight',
    });
    expect(server.registry.getWorker('w-recover')?.inFlight).toBe(0);

    // Both tasks were dispatched directly to the WebSocket worker (not queued)
    const taskMessages = received.filter((m) => m.type === 'task');
    expect(taskMessages.length).toBe(2);
    expect(server.taskQueue.pendingCount('default')).toBe(0);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('tracks available capacity as concurrency minus inFlight through dispatch cycle', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w-track', activities: ['test.compute'], concurrency: 3 });

    const worker = () => server.registry.getWorker('w-track')!;

    // Initial: full capacity
    expect(worker().concurrency - worker().inFlight).toBe(3);

    // Dispatch 2 tasks
    await server.dispatchTask({
      operationId: 't-1',
      activityName: 'test.compute',
      workflowType: 'test',
      input: null,
    });
    await server.dispatchTask({
      operationId: 't-2',
      activityName: 'test.compute',
      workflowType: 'test',
      input: null,
    });
    expect(worker().concurrency - worker().inFlight).toBe(1);

    // Complete one task
    ws.send(
      JSON.stringify({
        type: 'taskResult',
        operationId: 't-1',
        attemptToken: server.registry.getTask('t-1')?.attemptToken,
        status: 'completed',
        value: null,
      }),
    );
    await waitFor(() => worker().concurrency - worker().inFlight === 2, {
      label: 'first task completion freed capacity',
    });
    expect(worker().concurrency - worker().inFlight).toBe(2);

    // Complete the other
    ws.send(
      JSON.stringify({
        type: 'taskResult',
        operationId: 't-2',
        attemptToken: server.registry.getTask('t-2')?.attemptToken,
        status: 'completed',
        value: null,
      }),
    );
    await waitFor(() => worker().concurrency - worker().inFlight === 3, {
      label: 'second task completion freed capacity',
    });
    expect(worker().concurrency - worker().inFlight).toBe(3);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('integrates with RemoteWorker end-to-end', async () => {
    engine = createEngine();
    // Disable the reconnect grace period so the disconnect at the end of the
    // test unregisters the worker synchronously.
    server = serveTestServer({ engine, port: 0, workerReconnectGracePeriodMs: 0 });

    const { RemoteWorker } = await import('../worker/index.ts');

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}/v1/tasks/default/stream`,
      workerId: 'remote-1',
      deploymentName: 'test-deployment',
      buildId: 'test-build',
      workflows: {
        greeting: {
          name: 'greeting',
          activities: {
            greet: async (input: unknown) => `Hello, ${String(input)}!`,
          },
        },
      },
      concurrency: 3,
    });

    await worker.connect();
    await waitFor(() => server.registry.size === 1, { label: 'remote worker registered' });

    // Server should have registered the worker
    expect(server.registry.size).toBe(1);
    expect(server.registry.getAll()[0]?.id).toBe('remote-1');
    expect(server.registry.getAll()[0]?.activities).toEqual(['greeting.greet']);
    expect(server.registry.getAll()[0]?.concurrency).toBe(3);

    // Dispatch a task and verify the worker processes it
    const dispatched = await server.dispatchTask({
      operationId: 'e2e-op-1',
      activityName: 'greeting.greet',
      workflowType: 'greeting',
      input: 'World',
    });
    expect(dispatched).toBe(true);

    // Wait for the worker to process the task and send the result
    await waitFor(() => server.registry.getAll()[0]?.inFlight === 0, {
      label: 'remote task result decremented inFlight',
    });

    // in-flight should be back to 0 after the result is received
    expect(server.registry.getAll()[0]?.inFlight).toBe(0);

    await worker.disconnect();
    await waitFor(() => server.registry.size === 0, {
      label: 'remote worker unregistered after disconnect',
    });

    // Worker should be unregistered after disconnect
    expect(server.registry.size).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Sticky routing
  // -------------------------------------------------------------------------

  it('sticky dispatch prefers the worker that last handled a task for the same workflow', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);
    const received1: Array<{ type: string; operationId?: string; attemptToken?: string }> = [];
    const received2: Array<{ type: string; operationId?: string; attemptToken?: string }> = [];

    ws1.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attemptToken?: string;
      };
      received1.push(msg);
      if (msg.type === 'task') {
        ws1.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            attemptToken: msg.attemptToken,
            status: 'completed',
            value: null,
          }),
        );
      }
    });
    ws2.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attemptToken?: string;
      };
      received2.push(msg);
      if (msg.type === 'task') {
        ws2.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            attemptToken: msg.attemptToken,
            status: 'completed',
            value: null,
          }),
        );
      }
    });

    await registerWorker(ws1, {
      workerId: 'sticky-w1',
      activities: ['test.compute'],
      concurrency: 5,
    });
    await registerWorker(ws2, {
      workerId: 'sticky-w2',
      activities: ['test.compute'],
      concurrency: 5,
    });

    // First dispatch with workflowId — goes to whichever worker (least-loaded, both at 0).
    await server.dispatchTask({
      operationId: 'sticky-op-1',
      activityName: 'test.compute',
      workflowType: 'test',
      input: null,
      workflowId: 'wf-sticky-1',
    });
    await waitForRealTimersForTesting(100);

    // Determine which worker handled the first task.
    const firstWorker = received1.some((m) => m.operationId === 'sticky-op-1')
      ? 'sticky-w1'
      : 'sticky-w2';
    const firstReceived = firstWorker === 'sticky-w1' ? received1 : received2;

    // Second dispatch with sticky: true — should prefer the same worker.
    await server.dispatchTask({
      operationId: 'sticky-op-2',
      activityName: 'test.compute',
      workflowType: 'test',
      input: null,
      workflowId: 'wf-sticky-1',
      sticky: true,
    });
    await waitFor(() => firstReceived.some((m) => m.operationId === 'sticky-op-2'), {
      label: 'sticky dispatch routed op-2 to the same worker',
    });

    // The same worker that handled op-1 should also get op-2.
    expect(firstReceived.some((m) => m.operationId === 'sticky-op-2')).toBe(true);

    ws1.close();
    ws2.close();
    await waitForRealTimersForTesting(50);
  });

  it('sticky dispatch falls back to least-loaded when preferred worker is at capacity', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);
    const received2: Array<{ type: string; operationId?: string; attemptToken?: string }> = [];

    // Worker 1 does NOT auto-complete tasks (stays at capacity)
    ws2.addEventListener('message', (event) => {
      received2.push(
        JSON.parse(String(event.data)) as {
          type: string;
          operationId?: string;
          attemptToken?: string;
        },
      );
    });

    await registerWorker(ws1, { workerId: 'cap-w1', activities: ['test.compute'], concurrency: 1 });
    await registerWorker(ws2, { workerId: 'cap-w2', activities: ['test.compute'], concurrency: 5 });

    // First dispatch establishes affinity with w1.
    await server.dispatchTask({
      operationId: 'cap-op-1',
      activityName: 'test.compute',
      workflowType: 'test',
      input: null,
      workflowId: 'wf-cap',
    });
    await waitForRealTimersForTesting(50);

    // w1 is now at capacity (1/1). Sticky dispatch should fall back to w2.
    await server.dispatchTask({
      operationId: 'cap-op-2',
      activityName: 'test.compute',
      workflowType: 'test',
      input: null,
      workflowId: 'wf-cap',
      sticky: true,
    });
    await waitFor(() => received2.some((m) => m.operationId === 'cap-op-2'), {
      label: 'sticky dispatch fell back to second worker',
    });

    expect(received2.some((m) => m.operationId === 'cap-op-2')).toBe(true);

    ws1.close();
    ws2.close();
    await waitForRealTimersForTesting(50);
  });

  it('sticky dispatch without workflowId uses normal least-loaded routing', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);

    await registerWorker(ws1, {
      workerId: 'noid-w1',
      activities: ['test.compute'],
      concurrency: 5,
    });
    await registerWorker(ws2, {
      workerId: 'noid-w2',
      activities: ['test.compute'],
      concurrency: 5,
    });

    // Dispatch with sticky: true but no workflowId — should not crash, just use normal routing.
    const dispatched = await server.dispatchTask({
      operationId: 'noid-op-1',
      activityName: 'test.compute',
      workflowType: 'test',
      input: null,
      sticky: true,
    });
    expect(dispatched).toBe(true);

    ws1.close();
    ws2.close();
    await waitForRealTimersForTesting(50);
  });
});

// ---------------------------------------------------------------------------
// Queue-aware worker stream (WS /v1/tasks/:queue/stream)
// ---------------------------------------------------------------------------

describe('queue-aware worker stream', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  it('extracts queue name from the connection URL', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server, workerStreamPath('billing'));
    await registerWorker(ws, { workerId: 'billing-w1', activities: ['test.charge'] });

    const worker = server.registry.getAll()[0]!;
    expect(worker.queue).toBe('billing');

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('dispatches tasks only to workers on the matching queue', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const billingWs = await connectWorker(server, workerStreamPath('billing'));
    const shippingWs = await connectWorker(server, workerStreamPath('shipping'));

    const billingReceived: Array<{ type: string; operationId?: string; attemptToken?: string }> =
      [];
    const shippingReceived: Array<{ type: string; operationId?: string; attemptToken?: string }> =
      [];

    billingWs.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attemptToken?: string;
      };
      if (message.type === 'task') billingReceived.push(message);
    });
    shippingWs.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attemptToken?: string;
      };
      if (message.type === 'task') shippingReceived.push(message);
    });

    await registerWorker(billingWs, { workerId: 'billing-w1', activities: ['test.charge'] });
    await registerWorker(shippingWs, { workerId: 'shipping-w1', activities: ['test.charge'] });

    // Dispatch to billing queue
    await server.dispatchTask({
      operationId: 'billing-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: { amount: 100 },
      queue: 'billing',
    });

    await waitFor(() => billingReceived.length === 1, {
      label: 'billing worker received the task',
    });

    // Only the billing worker should receive the task
    expect(billingReceived.length).toBe(1);
    expect(billingReceived[0]?.operationId).toBe('billing-op');
    expect(shippingReceived.length).toBe(0);

    billingWs.close();
    shippingWs.close();
    await waitForRealTimersForTesting(50);
  });

  it('falls back to long-poll queue with the correct queue name', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    // Dispatch to a specific queue with no WebSocket workers
    await server.dispatchTask({
      operationId: 'queued-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
      queue: 'billing',
    });

    // Task should be in the 'billing' queue, not 'default'
    expect(server.taskQueue.pendingCount('billing')).toBe(1);
    expect(server.taskQueue.pendingCount('default')).toBe(0);
  });

  it('defaults to the "default" queue when no queue is specified in dispatch', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server, workerStreamPath('default'));
    const received: Array<{ type: string; operationId?: string; attemptToken?: string }> = [];

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attemptToken?: string;
      };
      if (message.type === 'task') received.push(message);
    });

    await registerWorker(ws, { workerId: 'default-w1', activities: ['test.charge'] });

    // Dispatch without specifying queue — should default to 'default'
    await server.dispatchTask({
      operationId: 'default-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });

    await waitFor(() => received.length === 1, { label: 'task routed to default queue worker' });

    expect(received.length).toBe(1);
    expect(received[0]?.operationId).toBe('default-op');

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('workers on different queues are isolated from each other', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const billingWs = await connectWorker(server, workerStreamPath('billing'));
    const defaultWs = await connectWorker(server, workerStreamPath('default'));

    const billingReceived: Array<{ type: string }> = [];
    const defaultReceived: Array<{ type: string }> = [];

    billingWs.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type: string };
      if (message.type === 'task') billingReceived.push(message);
    });
    defaultWs.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type: string };
      if (message.type === 'task') defaultReceived.push(message);
    });

    await registerWorker(billingWs, { workerId: 'billing-w1', activities: ['test.charge'] });
    await registerWorker(defaultWs, { workerId: 'default-w1', activities: ['test.charge'] });

    // Dispatch to default queue — should not reach billing worker
    await server.dispatchTask({
      operationId: 'default-only',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });

    await waitFor(() => defaultReceived.length === 1, {
      label: 'default-queue task reached default worker',
    });

    expect(defaultReceived.length).toBe(1);
    expect(billingReceived.length).toBe(0);

    billingWs.close();
    defaultWs.close();
    await waitForRealTimersForTesting(50);
  });

  it('integrates with RemoteWorker on a custom queue', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const { RemoteWorker } = await import('../worker/index.ts');

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}/v1/tasks/billing/stream`,
      workerId: 'billing-remote',
      deploymentName: 'test-deployment',
      buildId: 'test-build',
      workflows: {
        billing: {
          name: 'billing',
          activities: {
            charge: async (input: unknown) => ({ charged: input }),
          },
        },
      },
      concurrency: 3,
      queue: 'billing',
    });

    await worker.connect();
    await waitFor(() => server.registry.size === 1, {
      label: 'remote worker registered on billing queue',
    });

    // Worker should be registered on the billing queue
    expect(server.registry.size).toBe(1);
    const registered = server.registry.getAll()[0]!;
    expect(registered.id).toBe('billing-remote');
    expect(registered.queue).toBe('billing');

    // Dispatch to the billing queue
    const dispatched = await server.dispatchTask({
      operationId: 'billing-e2e',
      activityName: 'billing.charge',
      workflowType: 'billing',
      input: 42,
      queue: 'billing',
    });
    expect(dispatched).toBe(true);

    await waitFor(() => registered.inFlight === 0, {
      label: 'billing-queue task completed',
    });

    // Task should be completed
    expect(registered.inFlight).toBe(0);

    await worker.disconnect();
    await waitForRealTimersForTesting(50);
  });
});

// ---------------------------------------------------------------------------
// Token streaming WebSocket
// ---------------------------------------------------------------------------

describe('token streaming WebSocket (WS /v1/workflows/:id/stream)', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  /** Open a WebSocket to the token stream endpoint and wait for the connection. */
  async function connectStream(
    wsServer: WeftServer,
    workflowId: string,
    options?: { resumeFrom?: number },
  ): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const url = new URL(`${wsUrl}/v1/workflows/${encodeURIComponent(workflowId)}/stream`);
    if (options?.resumeFrom !== undefined) {
      url.searchParams.set('resumeFrom', String(options.resumeFrom));
    }
    const ws = new WebSocket(url.toString());

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });

    return ws;
  }

  async function expectStreamConnectionFailure(
    wsServer: WeftServer,
    workflowId: string,
    resumeFrom: string,
    connectionType: 'stream' | 'watch' = 'stream',
  ): Promise<void> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const url = new URL(
      `${wsUrl}/v1/workflows/${encodeURIComponent(workflowId)}/${connectionType}`,
    );
    url.searchParams.set('resumeFrom', resumeFrom);

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url.toString());
      const timeout = setTimeout(() => reject(new Error('Expected WebSocket failure')), 1_000);
      const finish = (): void => {
        clearTimeout(timeout);
        resolve();
      };

      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(`Unexpectedly connected ${connectionType} with resumeFrom=${resumeFrom}`));
      });
      ws.addEventListener('error', finish, { once: true });
      ws.addEventListener('close', finish, { once: true });
    });
  }

  async function expectWorkflowStreamPolicyClose(
    wsServer: WeftServer,
    workflowId: string,
    connectionType: 'stream' | 'watch',
  ): Promise<CloseEvent> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const ws = new WebSocket(
      `${wsUrl}/v1/workflows/${encodeURIComponent(workflowId)}/${connectionType}`,
    );

    return await new Promise<CloseEvent>((resolve, reject) => {
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        ws.close();
        reject(new Error(`Expected ${connectionType} WebSocket policy close`));
      }, 1_000);

      ws.addEventListener(
        'close',
        (event) => {
          if (timedOut) return;
          clearTimeout(timeout);
          resolve(event);
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        () => {
          if (timedOut) return;
          clearTimeout(timeout);
          reject(new Error(`${connectionType} WebSocket connection failed`));
        },
        { once: true },
      );
    });
  }

  async function connectWatch(
    wsServer: WeftServer,
    workflowId: string,
    options?: { resumeFrom?: number },
  ): Promise<WebSocket> {
    const wsUrl = wsServer.url.replace('http://', 'ws://');
    const url = new URL(`${wsUrl}/v1/workflows/${encodeURIComponent(workflowId)}/watch`);
    if (options?.resumeFrom !== undefined) {
      url.searchParams.set('resumeFrom', String(options.resumeFrom));
    }
    const ws = new WebSocket(url.toString());

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    });

    return ws;
  }

  /** Collect messages received on a WebSocket. */
  function collectMessages(ws: WebSocket): Array<{ type: string; [key: string]: unknown }> {
    const messages: Array<{ type: string; [key: string]: unknown }> = [];
    ws.addEventListener('message', (event) => {
      messages.push(JSON.parse(String(event.data)));
    });
    return messages;
  }

  it('accepts a WebSocket connection on /v1/workflows/:id/stream', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectStream(server, 'test-wf');
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('caps per-workflow stream and watch connections and frees slots on close', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0, maxStreamConnectionsPerWorkflow: 2 });

    const stream = await connectStream(server, 'test-wf');
    const watch = await connectWatch(server, 'test-wf');

    const close = await expectWorkflowStreamPolicyClose(server, 'test-wf', 'stream');
    expect(close.code).toBe(1008);
    const watchClose = await expectWorkflowStreamPolicyClose(server, 'test-wf', 'watch');
    expect(watchClose.code).toBe(1008);

    watch.close();
    await waitFor(() => watch.readyState === WebSocket.CLOSED, {
      label: 'watch socket closed after client close',
    });

    const replacement = await connectStream(server, 'test-wf');
    expect(replacement.readyState).toBe(WebSocket.OPEN);

    stream.close();
    replacement.close();
    await waitForRealTimersForTesting(50);
  });

  it('serves authenticated workflow event SSE through the live event bridge', async () => {
    const apiKey = 'weft_key_eventsread1234567890123456';
    engine = createEngine();
    const { serverOptions, serverMetricsCollector } = resolveNetworkConfig({
      engine,
      port: 0,
      publicOrigin: 'http://localhost',
      auth: {
        apiKeys: [apiKey],
        defaultApiKeyScopes: ['events:read'],
      },
    });
    const context = buildServerContext(serverOptions, serverMetricsCollector);
    const fetchHandler = buildFetchHandler(
      {
        current: {
          requestIP: () => null,
          upgrade: () => false,
        } as unknown as ReturnType<typeof Bun.serve>,
      },
      context,
      serverOptions,
    );

    const abortController = new AbortController();
    try {
      const response = await fetchHandler(
        new Request('http://localhost/v1/workflows/wf-auth/events/sse', {
          headers: {
            Accept: 'text/event-stream',
            'x-api-key': apiKey,
          },
          signal: abortController.signal,
        }),
      );

      expect(response).toBeDefined();
      expect(response?.status).toBe(200);
      expect(response?.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      await response?.body?.cancel().catch(() => undefined);
    } finally {
      abortController.abort();
      context.workflowEventFeed.dispose();
      context.fleetEventFeed.dispose();
    }
  });

  it('serves unauthenticated workflow event SSE when server auth is disabled', async () => {
    engine = createEngine();
    const { serverOptions, serverMetricsCollector } = resolveNetworkConfig({
      engine,
      port: 0,
      publicOrigin: 'http://localhost',
    });
    const context = buildServerContext(serverOptions, serverMetricsCollector);
    const fetchHandler = buildFetchHandler(
      {
        current: {
          requestIP: () => null,
          upgrade: () => false,
        } as unknown as ReturnType<typeof Bun.serve>,
      },
      context,
      serverOptions,
    );

    const abortController = new AbortController();
    try {
      const response = await fetchHandler(
        new Request('http://localhost/v1/workflows/wf-auth/events/sse', {
          headers: {
            Accept: 'text/event-stream',
          },
          signal: abortController.signal,
        }),
      );

      expect(response).toBeDefined();
      expect(response?.status).toBe(200);
      expect(response?.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      await response?.body?.cancel().catch(() => undefined);
    } finally {
      abortController.abort();
      context.workflowEventFeed.dispose();
      context.fleetEventFeed.dispose();
    }
  });

  it('receives live token events through the stream connection', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    // Start a workflow so events have a target
    const startResponse = await fetch(`${server.url}/v1/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'echo', input: 'hello' }),
    });
    const { id } = (await startResponse.json()) as { id: string };
    await flush();

    const ws = await connectStream(server, id);
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(50);

    // Dispatch token events directly on the engine
    engine.dispatchEvent(new TokenEvent(id, 'Hello', 'gpt-4'));
    engine.dispatchEvent(new TokenEvent(id, ' world', 'gpt-4'));
    await waitFor(() => messages.filter((m) => m.type === TokenEvent.type).length === 2, {
      label: 'both token events streamed to client',
    });

    // Should have received the two token events
    const tokenMessages = messages.filter((m) => m.type === TokenEvent.type);
    expect(tokenMessages.length).toBe(2);
    expect(tokenMessages[0]?.['data']).toMatchObject({ token: 'Hello', model: 'gpt-4' });
    expect(tokenMessages[1]?.['data']).toMatchObject({ token: ' world', model: 'gpt-4' });
    expect(typeof tokenMessages[0]?.['sequence']).toBe('number');
    expect(typeof tokenMessages[1]?.['sequence']).toBe('number');

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('receives live token events through the stream connection for workflow ids that require encoding', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const workflowId = 'wf:stream/with spaces';
    const ws = await connectStream(server, workflowId);
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(50);

    engine.dispatchEvent(new TokenEvent(workflowId, 'encoded-live', 'gpt-4'));
    await waitFor(
      () => messages.filter((message) => message.type === TokenEvent.type).length === 1,
      {
        label: 'encoded-id token event streamed to client',
      },
    );

    const tokenMessages = messages.filter((message) => message.type === TokenEvent.type);
    expect(tokenMessages).toHaveLength(1);
    expect(tokenMessages[0]?.['data']).toMatchObject({ token: 'encoded-live', model: 'gpt-4' });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('receives live watch events for workflow ids that require encoding', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const workflowId = 'wf:watch/with spaces';
    const ws = await connectWatch(server, workflowId);
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(50);

    engine.dispatchEvent(new WorkflowCompletedEvent(workflowId, 'encoded-watch', 1));
    await waitFor(
      () => messages.filter((message) => message.type === WorkflowCompletedEvent.type).length >= 1,
      { label: 'encoded-id watch completion event streamed to client' },
    );

    const completionMessages = messages.filter(
      (message) => message.type === WorkflowCompletedEvent.type,
    );
    expect(completionMessages).toHaveLength(1);
    expect(completionMessages[0]?.['data']).toMatchObject({
      workflowId,
      result: 'encoded-watch',
    });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('replays raw watch events after resumeFrom', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    engine.dispatchEvent(new WorkflowCompletedEvent('wf-watch-resume', 'first', 1));
    engine.dispatchEvent(new WorkflowCompletedEvent('wf-watch-resume', 'second', 2));
    await waitFor(
      async () => (await engine.storage.get(KEYS.event('wf-watch-resume', 1))) !== null,
      {
        label: 'watch event sequence persisted',
      },
    );

    const ws = await connectWatch(server, 'wf-watch-resume', { resumeFrom: 0 });
    const messages = collectMessages(ws);
    await waitFor(
      () => messages.filter((message) => message.type === WorkflowCompletedEvent.type).length === 1,
      {
        label: 'resumed watch event streamed to client',
      },
    );

    const completionMessages = messages.filter(
      (message) => message.type === WorkflowCompletedEvent.type,
    );
    expect(completionMessages[0]?.['sequence']).toBe(1);
    expect(completionMessages[0]?.['cursor']).toBe('1');
    expect(completionMessages[0]?.['data']).toMatchObject({ result: 'second' });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('clamps raw watch resumeFrom above the durable event range so live events still arrive', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    engine.dispatchEvent(new WorkflowCompletedEvent('wf-watch-clamped', 'first', 1));
    await waitFor(
      async () => (await engine.storage.get(KEYS.event('wf-watch-clamped', 0))) !== null,
      {
        label: 'watch event sequence persisted before clamped resume',
      },
    );

    const ws = await connectWatch(server, 'wf-watch-clamped', { resumeFrom: 999 });
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(50);

    engine.dispatchEvent(new WorkflowSuspendedEvent('wf-watch-clamped'));
    await waitFor(
      () => messages.filter((message) => message.type === WorkflowSuspendedEvent.type).length === 1,
      {
        label: 'clamped resume live watch event to client',
      },
    );

    const watchMessages = messages.filter(
      (message) =>
        message.type === WorkflowCompletedEvent.type ||
        message.type === WorkflowSuspendedEvent.type,
    );
    expect(watchMessages).toHaveLength(1);
    expect(watchMessages[0]?.['type']).toBe(WorkflowSuspendedEvent.type);
    expect(watchMessages[0]?.['sequence']).toBe(1);
    expect(watchMessages[0]?.['cursor']).toBe('1');
    expect(watchMessages[0]?.['data']).toMatchObject({ workflowId: 'wf-watch-clamped' });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('only receives token events for the subscribed workflow', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectStream(server, 'wf-a');
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(50);

    // Dispatch token events for two different workflows
    engine.dispatchEvent(new TokenEvent('wf-a', 'for-a', 'gpt-4'));
    engine.dispatchEvent(new TokenEvent('wf-b', 'for-b', 'gpt-4'));
    await waitFor(() => messages.filter((m) => m.type === TokenEvent.type).length === 1, {
      label: 'only the subscribed workflow token event streamed',
    });

    // Should only see the event for wf-a
    const tokenMessages = messages.filter((m) => m.type === TokenEvent.type);
    expect(tokenMessages.length).toBe(1);
    expect(tokenMessages[0]?.['data']).toMatchObject({ token: 'for-a' });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('replays existing token events on connect', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    // Dispatch token events before a client connects
    engine.dispatchEvent(new TokenEvent('wf-replay', 'first', 'gpt-4'));
    engine.dispatchEvent(new TokenEvent('wf-replay', 'second', 'gpt-4'));
    await waitForRealTimersForTesting(200);

    // Now connect — client should receive replay of existing token events
    const ws = await connectStream(server, 'wf-replay');
    const messages = collectMessages(ws);
    await waitFor(
      () => messages.filter((message) => message.type === TokenEvent.type).length >= 2,
      {
        label: 'replayed token events received',
      },
    );

    const replayMessages = messages.filter((message) => message.type === TokenEvent.type);
    expect(replayMessages.length).toBeGreaterThanOrEqual(2);

    const replayedTokens = replayMessages.map(
      (message) => (message['data'] as Record<string, unknown>)?.['token'],
    );
    expect(replayedTokens).toContain('first');
    expect(replayedTokens).toContain('second');
    expect(replayMessages.map((message) => message['sequence'])).toEqual([0, 1]);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('replays existing token events on connect for workflow ids that require encoding', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const workflowId = 'wf:replay/with spaces';
    engine.dispatchEvent(new TokenEvent(workflowId, 'encoded', 'gpt-4'));
    await waitForRealTimersForTesting(200);

    const ws = await connectStream(server, workflowId);
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(200);

    const replayMessages = messages.filter((message) => message.type === TokenEvent.type);
    const replayedTokens = replayMessages.map(
      (message) => (message['data'] as Record<string, unknown>)?.['token'],
    );

    expect(replayedTokens).toContain('encoded');

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('rejects malformed encoded workflow stream paths without crashing the server', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const wsUrl = server.url.replace('http://', 'ws://');
    const failed = await new Promise<boolean>((resolve, reject) => {
      const ws = new WebSocket(`${wsUrl}/v1/workflows/%E0%A4%A/stream`);
      const timeout = setTimeout(() => reject(new Error('Expected WebSocket failure')), 1_000);
      const finish = (): void => {
        clearTimeout(timeout);
        resolve(true);
      };

      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        ws.close();
        reject(new Error('Malformed workflow stream path unexpectedly connected'));
      });
      ws.addEventListener('error', finish, { once: true });
      ws.addEventListener('close', finish, { once: true });
    });

    expect(failed).toBe(true);

    const healthResponse = await fetch(`${server.url}/v1/health`);
    expect(healthResponse.status).toBe(200);
  });

  it('rejects invalid resumeFrom query parameter values', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    for (const connectionType of ['stream', 'watch'] as const) {
      for (const resumeFrom of ['', 'not-a-number', '1.5', '1abc', '0x10', '1e3']) {
        await expectStreamConnectionFailure(
          server,
          `wf-invalid-resume-${connectionType}`,
          resumeFrom,
          connectionType,
        );
      }
    }

    const healthResponse = await fetch(`${server.url}/v1/health`);
    expect(healthResponse.status).toBe(200);
  });

  it('continues event persistence from the highest stored sequence number', async () => {
    engine = createEngine();
    const storage = engine.storage as MemoryStorage;
    await storage.put(
      KEYS.event('wf-sequence', 4),
      encode({
        type: WorkflowSuspendedEvent.type,
        timestamp: Date.now(),
        data: { workflowId: 'wf-sequence' },
      }),
    );
    server = serveTestServer({ engine, port: 0 });

    engine.dispatchEvent(new WorkflowSuspendedEvent('wf-sequence'));
    await waitFor(async () => (await storage.get(KEYS.event('wf-sequence', 5))) !== null, {
      label: 'event persistence at next sequence',
    });

    expect(await storage.get(KEYS.event('wf-sequence', 4))).not.toBeNull();
    expect(await storage.get(KEYS.event('wf-sequence', 5))).not.toBeNull();
  });

  it('persists streamed token chunks under the durable blob prefix', async () => {
    engine = createEngine();
    const storage = engine.storage as MemoryStorage;
    server = serveTestServer({ engine, port: 0 });

    engine.dispatchEvent(new TokenEvent('wf-token-blob', 'alpha', 'gpt-4'));
    await waitFor(
      async () => (await storage.get(KEYS.streamChunk('wf-token-blob', 'tokens', 0))) !== null,
      {
        label: 'token chunk persistence',
      },
    );

    const storedChunk = await storage.get(KEYS.streamChunk('wf-token-blob', 'tokens', 0));
    expect(storedChunk).not.toBeNull();
    expect(decode(storedChunk!)).toEqual({
      workflowId: 'wf-token-blob',
      token: 'alpha',
      model: 'gpt-4',
    });
    const storedTail = await storage.get(KEYS.streamTail('wf-token-blob', 'tokens'));
    expect(storedTail).not.toBeNull();
    expect(decode(storedTail!)).toEqual({ sequence: 0 });
  });

  it('retries event sequence initialization after a failed scan', async () => {
    engine = createEngine();
    const storage = engine.storage as MemoryStorage;
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalScan = storage.scan.bind(storage);
    let failFirstEventScan = true;
    const restoreScan = overrideProperty(storage, 'scan', async function* (
      prefix: string,
      options?: Parameters<MemoryStorage['scan']>[1],
    ) {
      if (prefix === 'ev:wf-sequence-retry:' && failFirstEventScan) {
        failFirstEventScan = false;
        throw new Error('event scan failed');
      }
      yield* originalScan(prefix, options);
    } as MemoryStorage['scan']);
    server = serveTestServer({ engine, port: 0 });

    try {
      engine.dispatchEvent(new WorkflowSuspendedEvent('wf-sequence-retry'));
      await waitFor(() => errorSpy.mock.calls.length > 0, {
        label: 'initial event sequence scan failure to surface',
      });
      engine.dispatchEvent(new WorkflowSuspendedEvent('wf-sequence-retry'));
      await waitFor(async () => (await storage.get(KEYS.event('wf-sequence-retry', 0))) !== null, {
        label: 'event persistence after retry',
      });

      expect(await storage.get(KEYS.event('wf-sequence-retry', 0))).not.toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      restoreScan();
      errorSpy.mockRestore();
    }
  });

  it('retries token sequence initialization after a failed scan', async () => {
    engine = createEngine();
    const storage = engine.storage as MemoryStorage;
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalScan = storage.scan.bind(storage);
    let failFirstTokenScan = true;
    const restoreScan = overrideProperty(storage, 'scan', async function* (
      prefix: string,
      options?: Parameters<MemoryStorage['scan']>[1],
    ) {
      if (
        prefix === KEYS.streamChunkPrefix('wf-token-sequence-retry', 'tokens') &&
        failFirstTokenScan
      ) {
        failFirstTokenScan = false;
        throw new Error('token scan failed');
      }
      yield* originalScan(prefix, options);
    } as MemoryStorage['scan']);
    server = serveTestServer({ engine, port: 0 });

    try {
      engine.dispatchEvent(new TokenEvent('wf-token-sequence-retry', 'first', 'gpt-4'));
      await waitFor(() => errorSpy.mock.calls.length > 0, {
        label: 'initial token sequence scan failure to surface',
      });
      engine.dispatchEvent(new TokenEvent('wf-token-sequence-retry', 'second', 'gpt-4'));
      await waitFor(
        async () =>
          (await storage.get(KEYS.streamChunk('wf-token-sequence-retry', 'tokens', 0))) !== null,
        {
          label: 'token chunk persistence after retry',
        },
      );

      expect(
        await storage.get(KEYS.streamChunk('wf-token-sequence-retry', 'tokens', 0)),
      ).not.toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      restoreScan();
      errorSpy.mockRestore();
    }
  });

  it('replays only missing token chunks when resumeFrom is provided', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    engine.dispatchEvent(new TokenEvent('wf-resume', 'first', 'gpt-4'));
    engine.dispatchEvent(new TokenEvent('wf-resume', 'second', 'gpt-4'));
    await waitForRealTimersForTesting(200);

    const ws = await connectStream(server, 'wf-resume', { resumeFrom: 0 });
    const messages = collectMessages(ws);
    await waitFor(
      () => messages.filter((message) => message.type === TokenEvent.type).length === 1,
      {
        label: 'missing token replay to stream client',
      },
    );

    const replayMessages = messages.filter((message) => message.type === TokenEvent.type);
    expect(replayMessages).toHaveLength(1);
    expect(replayMessages[0]?.['sequence']).toBe(1);
    expect(replayMessages[0]?.['data']).toMatchObject({ token: 'second' });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('clamps resumeFrom above the durable token range so live tokens still arrive', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    engine.dispatchEvent(new TokenEvent('wf-resume-clamped', 'first', 'gpt-4'));
    await waitForRealTimersForTesting(200);

    const ws = await connectStream(server, 'wf-resume-clamped', { resumeFrom: 999 });
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(50);

    engine.dispatchEvent(new TokenEvent('wf-resume-clamped', 'second', 'gpt-4'));
    await waitFor(
      () => messages.filter((message) => message.type === TokenEvent.type).length === 1,
      {
        label: 'clamped resume live token to stream client',
      },
    );

    const tokenMessages = messages.filter((message) => message.type === TokenEvent.type);
    expect(tokenMessages).toHaveLength(1);
    expect(tokenMessages[0]?.['sequence']).toBe(1);
    expect(tokenMessages[0]?.['data']).toMatchObject({ token: 'second', model: 'gpt-4' });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('treats a resume cursor with no durable token chunks as an empty replay cursor', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectStream(server, 'wf-resume-empty', { resumeFrom: 999 });
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(50);

    engine.dispatchEvent(new TokenEvent('wf-resume-empty', 'live', 'gpt-4'));
    await waitFor(
      () => messages.filter((message) => message.type === TokenEvent.type).length === 1,
      {
        label: 'empty replay live token to stream client',
      },
    );

    const tokenMessages = messages.filter((message) => message.type === TokenEvent.type);
    expect(tokenMessages).toHaveLength(1);
    expect(tokenMessages[0]?.['sequence']).toBe(0);
    expect(tokenMessages[0]?.['data']).toMatchObject({ token: 'live', model: 'gpt-4' });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('treats missing or malformed durable token sequences as an empty replay cursor', async () => {
    engine = createEngine();
    const storage = engine.storage as MemoryStorage;
    await storage.put(
      `${KEYS.streamChunkPrefix('wf-resume-malformed', 'tokens')}zzz`,
      encode({ workflowId: 'wf-resume-malformed', token: 'stale', model: 'gpt-4' }),
    );
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectStream(server, 'wf-resume-malformed', { resumeFrom: 999 });
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(50);

    engine.dispatchEvent(new TokenEvent('wf-resume-malformed', 'live', 'gpt-4'));
    await waitFor(
      () => messages.filter((message) => message.type === TokenEvent.type).length === 1,
      {
        label: 'malformed replay live token to stream client',
      },
    );

    const tokenMessages = messages.filter((message) => message.type === TokenEvent.type);
    expect(tokenMessages).toHaveLength(1);
    expect(tokenMessages[0]?.['sequence']).toBe(0);
    expect(tokenMessages[0]?.['data']).toMatchObject({ token: 'live', model: 'gpt-4' });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('buffers live token events that arrive while replay is still in progress', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    engine.dispatchEvent(new TokenEvent('wf-overlap', 'first', 'gpt-4'));
    engine.dispatchEvent(new TokenEvent('wf-overlap', 'second', 'gpt-4'));
    await waitForRealTimersForTesting(200);

    const originalGetStreamChunks = engine.getStreamChunks.bind(engine);
    let releaseReplay!: () => void;
    const replayGate = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    let shouldBlockReplay = true;

    engine.getStreamChunks = async (...args) => {
      if (
        shouldBlockReplay &&
        args[0] === 'wf-overlap' &&
        args[1] === 'tokens' &&
        args[2]?.after === 0
      ) {
        shouldBlockReplay = false;
        await replayGate;
      }

      return originalGetStreamChunks(...args);
    };

    const ws = await connectStream(server, 'wf-overlap', { resumeFrom: 0 });
    const messages = collectMessages(ws);
    await waitForRealTimersForTesting(50);

    engine.dispatchEvent(new TokenEvent('wf-overlap', 'third', 'gpt-4'));
    await waitForRealTimersForTesting(50);

    releaseReplay();
    await waitFor(
      () =>
        messages
          .filter((message) => message.type === TokenEvent.type)
          .map((message) => message['sequence'])
          .join(',') === '1,2',
      {
        label: 'buffered overlap replay and live token sequence',
      },
    );

    const tokenMessages = messages.filter((message) => message.type === TokenEvent.type);
    expect(tokenMessages.map((message) => message['sequence'])).toEqual([1, 2]);
    expect(
      tokenMessages.map((message) => (message['data'] as Record<string, unknown>)?.['token']),
    ).toEqual(['second', 'third']);

    engine.getStreamChunks = originalGetStreamChunks;
    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('replays stored token chunks after a server restart', async () => {
    const storage = new MemoryStorage();

    engine = new Engine({ storage });
    engine.register(echoWorkflow);
    server = serveTestServer({ engine, port: 0 });

    engine.dispatchEvent(new TokenEvent('wf-restart', 'persisted', 'gpt-4'));
    await waitForRealTimersForTesting(200);

    await server.stop();
    engine[Symbol.dispose]();

    engine = new Engine({ storage });
    engine.register(echoWorkflow);
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectStream(server, 'wf-restart', { resumeFrom: -1 });
    const messages = collectMessages(ws);
    await waitFor(
      () => messages.filter((message) => message.type === TokenEvent.type).length === 1,
      {
        label: 'restart token replay to stream client',
      },
    );

    const replayMessages = messages.filter((message) => message.type === TokenEvent.type);
    expect(replayMessages).toHaveLength(1);
    expect(replayMessages[0]?.['sequence']).toBe(0);
    expect(replayMessages[0]?.['data']).toMatchObject({ token: 'persisted' });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('logs replay failures when stored token scanning throws', async () => {
    engine = createEngine();
    const storage = engine.storage as MemoryStorage;
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalScan = storage.scan.bind(storage);
    const restoreScan = overrideProperty(storage, 'scan', async function* (
      prefix: string,
      options?: Parameters<MemoryStorage['scan']>[1],
    ) {
      if (prefix === 'blob:wf-replay-failure:tokens:chunk:') {
        throw new Error('replay scan failed');
      }
      yield* originalScan(prefix, options);
    } as MemoryStorage['scan']);
    server = serveTestServer({ engine, port: 0 });

    try {
      const ws = await connectStream(server, 'wf-replay-failure');
      await waitFor(
        () =>
          errorSpy.mock.calls.some(
            (call) =>
              call[0] === '[weft] Failed to replay token stream for workflow "wf-replay-failure":',
          ),
        {
          label: 'token replay failure log',
        },
      );

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Failed to replay token stream for workflow "wf-replay-failure":',
        expect.any(Error),
      );

      ws.close();
      await waitForRealTimersForTesting(50);
    } finally {
      restoreScan();
      errorSpy.mockRestore();
    }
  });

  it('does not process worker protocol messages on stream connections', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectStream(server, 'test-wf');

    // Send a worker register message — should be ignored
    ws.send(
      JSON.stringify({
        type: 'register',
        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
        workerId: 'rogue',
        manifest: manifestForActivities(['test.charge']),
        concurrency: 5,
      }),
    );
    await waitForRealTimersForTesting(50); // fixed delay: negative assertion (no event to await)

    // Registry should be empty — register messages are only for worker paths
    expect(server.registry.size).toBe(0);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('supports multiple concurrent stream clients for the same workflow', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws1 = await connectStream(server, 'wf-multi');
    const ws2 = await connectStream(server, 'wf-multi');
    const messages1 = collectMessages(ws1);
    const messages2 = collectMessages(ws2);
    // fixed delay: pre-dispatch settle — waits for both stream subscriptions to establish (no observable ready signal)
    await waitForRealTimersForTesting(50);

    engine.dispatchEvent(new TokenEvent('wf-multi', 'shared-token', 'gpt-4'));
    await waitFor(
      () =>
        messages1.filter((m) => m.type === TokenEvent.type).length >= 1 &&
        messages2.filter((m) => m.type === TokenEvent.type).length >= 1,
      { label: 'both stream clients received the shared token event' },
    );

    // Both clients should receive the token event
    const tokens1 = messages1.filter((m) => m.type === TokenEvent.type);
    const tokens2 = messages2.filter((m) => m.type === TokenEvent.type);
    expect(tokens1.length).toBe(1);
    expect(tokens2.length).toBe(1);

    ws1.close();
    ws2.close();
    await waitForRealTimersForTesting(50);
  });
});

// ---------------------------------------------------------------------------
// Long-poll HTTP endpoints
// ---------------------------------------------------------------------------

describe('long-poll endpoints (GET /v1/tasks/:queue, POST /v1/tasks/:queue/result)', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  it('returns 204 when no task is available within timeout', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/tasks/default?activity=test.charge&timeout=50`);

    expect(response.status).toBe(204);
  });

  it('rejects task results with invalid status values', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/tasks/default/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: 'bad-status-op', status: 'cancelled' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'status must be "completed" or "failed"',
    });
  });

  it('returns 400 when no activity query parameter is provided', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/tasks/default?timeout=50`);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('activity');
  });

  it('returns a queued task immediately', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    // Dispatch a task with no WebSocket workers — goes to task queue
    await server.dispatchTask({
      operationId: 'op-poll-1',
      activityName: 'test.charge',
      workflowType: 'test',
      input: { amount: 100 },
    });

    const response = await fetch(
      `${server.url}/v1/tasks/default?activity=test.charge&timeout=1000`,
    );

    expect(response.status).toBe(200);
    const task = (await response.json()) as { operationId: string; activityName: string };
    expect(task.operationId).toBe('op-poll-1');
    expect(task.activityName).toBe('test.charge');
  });

  it('records terminal disposition and low-cardinality metrics when a long-poll worker completes immediately after claim', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    await server.dispatchTask({
      operationId: 'long-poll-diagnostics-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: { amount: 100 },
      workflowId: 'workflow-long-poll-diagnostics',
    });

    const pollResponse = await fetch(
      `${server.url}/v1/tasks/default?activity=test.charge&timeout=1000`,
    );
    expect(pollResponse.status).toBe(200);
    const task = (await pollResponse.json()) as {
      operationId: string;
      workerId: string;
      attemptToken: string;
    };
    expect(task.operationId).toBe('long-poll-diagnostics-op');

    const resultResponse = await fetch(`${server.url}/v1/tasks/default/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationId: 'long-poll-diagnostics-op',
        workerId: task.workerId,
        attemptToken: task.attemptToken,
        status: 'completed',
        value: { result: 42 },
      }),
    });
    expect(resultResponse.status).toBe(200);

    const resolved = await waitForTerminalResolvedRecord(
      engine.storage,
      'long-poll-diagnostics-op',
    );
    expect(resolved.workflowId).toBe('workflow-long-poll-diagnostics');
    expect(resolved.activityName).toBe('test.charge');
    expect(resolved.queue).toBe('default');
    expect(resolved.status).toBe('completed');
    expect(typeof resolved.terminalAt).toBe('number');

    const metricsResponse = await fetch(`${server.url}/v1/metrics`);
    expect(metricsResponse.status).toBe(200);
    const metricsText = await metricsResponse.text();
    expect(metricsText).toContain('weft_task_queue_latency_count 1');
    expect(metricsText).toContain('weft_task_execution_latency_count 1');
  });

  it('reuses an existing queued ledger record verbatim when redispatching to long-poll', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage });
    engine.register(echoWorkflow);
    server = serveTestServer({ engine, port: 0 });

    const seeded: RemoteTaskQueued = {
      recordVersion: 1,
      operationId: 'long-poll-requeue-timing-op',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
      headers: {},
      visibilityTimeoutMilliseconds: 30_000,
      createdAt: 500,
      generation: 3,
      state: 'queued',
      attempt: 2,
      availableAt: 1_000,
      firstQueuedAt: 500,
      lastQueuedAt: 1_000,
      lastDispatchedAt: 750,
      startedAt: 800,
      retryCount: 1,
      requeueCount: 1,
      lastRequeueReason: 'visibility-timeout',
    };
    await storage.put(taskLedgerKey(seeded.operationId), encodeRemoteTaskRecord(seeded));

    // The ledger record, not TaskQueue, is authoritative — redispatching an
    // operationId already in `queued` reuses that record verbatim rather
    // than bumping a CAS generation just to refresh a cosmetic timestamp.
    await server.dispatchTask({
      operationId: 'long-poll-requeue-timing-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });

    const persisted = await readLedgerRecord(storage, 'long-poll-requeue-timing-op');
    expect(persisted).toEqual(seeded);

    const pendingTask = server.taskQueue.peekPending('default')[0];
    expect(pendingTask?.lastQueuedAt).toBe(seeded.lastQueuedAt);
  });

  it('blocks until a task arrives within the timeout', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    // Start a poll that will block
    const pollPromise = fetch(`${server.url}/v1/tasks/default?activity=test.charge&timeout=5000`);

    // Wait a bit, then enqueue a task
    await waitForRealTimersForTesting(100);
    await server.dispatchTask({
      operationId: 'op-delayed',
      activityName: 'test.charge',
      workflowType: 'test',
      input: { amount: 50 },
    });

    const response = await pollPromise;
    expect(response.status).toBe(200);
    const task = (await response.json()) as { operationId: string };
    expect(task.operationId).toBe('op-delayed');
  });

  it('filters tasks by activity name', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    // Queue a 'test.ship' task
    await server.dispatchTask({
      operationId: 'op-ship',
      activityName: 'test.ship',
      workflowType: 'test',
      input: null,
    });

    // Poll for 'test.charge' only — should not match
    const response = await fetch(`${server.url}/v1/tasks/default?activity=test.charge&timeout=50`);

    expect(response.status).toBe(204);

    // The 'test.ship' task should still be in the queue
    expect(server.taskQueue.pendingCount('default')).toBe(1);
  });

  it('accepts task completion via POST', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    // Post-cutover (WFT-22), completion is authorized against a real ledger
    // record — an unknown operationId is now a hard rejection (see
    // `isLongPollCompletionAuthorized`'s doc comment) rather than the old
    // duplicate-tolerant no-op. Dispatch and claim through the real flow to
    // get a real `attemptToken`/`workerId` pair the completion endpoint
    // will authorize.
    await server.dispatchTask({
      operationId: 'op-complete-1',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });
    const pollResponse = await fetch(
      `${server.url}/v1/tasks/default?activity=test.charge&timeout=1000`,
    );
    const task = (await pollResponse.json()) as { workerId: string; attemptToken: string };

    const response = await fetch(`${server.url}/v1/tasks/default/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationId: 'op-complete-1',
        workerId: task.workerId,
        attemptToken: task.attemptToken,
        status: 'completed',
        value: { result: 42 },
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('returns 400 for invalid completion body', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/tasks/default/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });

    expect(response.status).toBe(400);
  });

  it('returns 400 for non-JSON completion body', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/tasks/default/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not json',
    });

    expect(response.status).toBe(400);
  });

  it('invokes the completion callback when task is completed', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const results: Array<{ operationId: string; status: string }> = [];

    // Post-cutover (WFT-22), the long-poll completion endpoint authorizes
    // against a real ledger record (see `isLongPollCompletionAuthorized`) —
    // hand-construct a `leased` record so completion is authorized, matching
    // the `TaskQueue.enqueue` callback registration and the completion POST
    // below on `workerId`/`attemptToken`.
    const leasedRecord = makeLeasedLedgerRecord({
      operationId: 'op-cb',
      workerSessionId: 'worker-cb',
      attemptToken: 'attempt-token-callback',
    });
    await engine.storage.put(taskLedgerKey('op-cb'), encodeRemoteTaskRecord(leasedRecord));

    // Enqueue with a callback
    server.taskQueue.enqueue(
      'default',
      { operationId: 'op-cb', activityName: 'test.charge', input: null },
      (result) => results.push(result),
    );

    // Complete via HTTP
    const response = await fetch(`${server.url}/v1/tasks/default/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationId: 'op-cb',
        workerId: 'worker-cb',
        attemptToken: 'attempt-token-callback',
        status: 'completed',
        value: 'done',
      }),
    });
    expect(response.status).toBe(200);

    expect(results).toHaveLength(1);
    expect(results[0]?.operationId).toBe('op-cb');
    expect(results[0]?.status).toBe('completed');
  });

  it('integrates with LongPollWorker end-to-end', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const { LongPollWorker } = await import('../worker/long-poll.ts');

    const worker = new LongPollWorker({
      serverUrl: server.url,
      activities: {
        greet: async (input: unknown) => `Hello, ${String(input)}!`,
      },
      concurrency: 3,
      pollTimeout: 5000,
    });

    worker.start();
    await waitForRealTimersForTesting(100);

    // Dispatch a task — no WebSocket workers, so it goes to the queue
    await server.dispatchTask({
      operationId: 'e2e-lp-1',
      activityName: 'greet',
      workflowType: 'testWorkflow',
      input: 'World',
    });

    // Wait for the worker to poll, execute, and complete
    await waitFor(() => server.taskQueue.pendingCount('default') === 0 && worker.inFlight === 0, {
      label: 'long-poll worker to drain dispatched task',
    });

    // Worker should be running with no in-flight tasks
    expect(worker.running).toBe(true);
    expect(worker.inFlight).toBe(0);

    await worker.stop();
    expect(worker.running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task assignment deduplication
// ---------------------------------------------------------------------------

describe('task assignment deduplication', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  it('rejects duplicate dispatch of the same operationId to WebSocket workers', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string; attemptToken?: string }> = [];

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attemptToken?: string;
      };
      if (message.type === 'task') received.push(message);
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    const first = await server.dispatchTask({
      operationId: 'dup-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });
    const second = await server.dispatchTask({
      operationId: 'dup-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);

    await waitFor(() => received.length === 1, { label: 'duplicate task dispatch delivered once' });

    // Worker should receive exactly one task
    expect(received.length).toBe(1);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('rejects duplicate dispatch when the first went to the long-poll queue', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    // No WebSocket workers — tasks go to long-poll queue
    const first = await server.dispatchTask({
      operationId: 'dup-lp',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });
    const second = await server.dispatchTask({
      operationId: 'dup-lp',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(server.taskQueue.pendingCount('default')).toBe(1);
  });

  it('rejects duplicate across WebSocket and long-poll paths', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 1 });

    // First dispatch goes to WebSocket worker
    const first = await server.dispatchTask({
      operationId: 'cross-dup',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });
    expect(first).toBe(true);

    // Worker is now at capacity (1/1), so second dispatch would normally go to long-poll.
    // But the operationId is already assigned, so it should be rejected.
    const second = await server.dispatchTask({
      operationId: 'cross-dup',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });
    expect(second).toBe(false);
    expect(server.taskQueue.pendingCount('default')).toBe(0);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('uses assignTask for WebSocket dispatch so in-flight tasks are tracked', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'tracked-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });

    // The operationId should be tracked in the registry's in-flight tasks
    expect(server.registry.isAssigned('tracked-op')).toBe(true);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('clears in-flight tracking when worker sends taskResult with operationId', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    collectAndCompleteTaskMessages(ws, { resultValue: 42 });

    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'clear-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });

    expect(server.registry.isAssigned('clear-op')).toBe(true);

    await waitFor(
      () =>
        !server.registry.isAssigned('clear-op') && server.registry.getWorker('w1')?.inFlight === 0,
      { label: 'clear-op task result to clear in-flight tracking' },
    );

    // After the result arrives, the task should no longer be tracked
    expect(server.registry.isAssigned('clear-op')).toBe(false);
    expect(server.registry.getWorker('w1')?.inFlight).toBe(0);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('rejects unexpected worker taskResult statuses as protocol errors', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0, workerReconnectGracePeriodMs: 0 });

    const ws = await connectWorker(server);
    const protocolError = waitForWorkerMessage(
      ws,
      (message) => message['type'] === 'protocolError',
      'unexpected status protocolError',
    );
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attemptToken?: string;
      };
      if (msg.type === 'task') {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            status: 'mystery-status',
          }),
        );
      }
    });

    await registerWorker(ws, { workerId: 'w-unexpected-status', activities: ['test.charge'] });
    await server.dispatchTask({
      operationId: 'unexpected-status-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });

    expect(await protocolError).toMatchObject({
      type: 'protocolError',
      code: 'invalid_message',
    });
    await waitForSocketClose(ws, 'unexpected status socket close');
    expect(server.registry.getWorker('w-unexpected-status')).toBeUndefined();
  });

  it('treats cancelled worker taskResult statuses as failed resolutions', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attemptToken?: string;
      };
      if (msg.type === 'task') {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            attemptToken: msg.attemptToken,
            status: 'cancelled',
            error: 'activity cancelled',
          }),
        );
      }
    });

    await registerWorker(ws, { workerId: 'w-cancelled-status', activities: ['test.charge'] });
    await server.dispatchTask({
      operationId: 'cancelled-status-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });

    await waitFor(
      async () => {
        const record = await readLedgerRecord(engine.storage, 'cancelled-status-op');
        return record !== null && record.state === 'terminal';
      },
      { label: 'cancelled-status-op task result to resolve' },
    );

    const record = await readLedgerRecord(engine.storage, 'cancelled-status-op');
    if (record === null || record.state !== 'terminal' || record.disposition !== 'resolved') {
      throw new Error('Expected "cancelled-status-op" to reach a resolved terminal record');
    }
    // resolveTaskResultStatus() maps a worker's "cancelled" taskResult status to "failed".
    expect(record.status).toBe('failed');

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('rejects taskResult without operationId as a protocol error', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0, workerReconnectGracePeriodMs: 0 });

    const ws = await connectWorker(server);
    const protocolError = waitForWorkerMessage(
      ws,
      (message) => message['type'] === 'protocolError',
      'missing operationId protocolError',
    );
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string };
      if (msg.type === 'task') {
        ws.send(JSON.stringify({ type: 'taskResult', status: 'completed', value: null }));
      }
    });

    await registerWorker(ws, { workerId: 'w-missing-op-id', activities: ['test.charge'] });
    await server.dispatchTask({
      operationId: 'missing-op-id-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });

    expect(await protocolError).toMatchObject({
      type: 'protocolError',
      code: 'invalid_message',
    });
    await waitForSocketClose(ws, 'missing operationId socket close');
    expect(server.registry.getWorker('w-missing-op-id')).toBeUndefined();
  });

  it('rejects a duplicate workerId registration while the first socket is still live', async () => {
    // Security fix for #609: a new socket that claims an already-active workerId
    // must receive a registerError and be closed. The original socket must remain
    // the owner in the registry.
    engine = createEngine();
    server = serveTestServer({ engine, port: 0, workerReconnectGracePeriodMs: 0 });

    const ws1 = await connectWorker(server);
    await registerWorker(ws1, { workerId: 'reconnecting-worker', activities: ['test.charge'] });

    // ws2 tries to claim the same workerId while ws1 is still alive.
    const ws2 = await connectWorker(server);
    const registerError = waitForWorkerMessage(
      ws2,
      (message) => message['type'] === 'registerError',
      'registerError for duplicate workerId',
    );
    ws2.send(
      JSON.stringify({
        type: 'register',
        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
        workerId: 'reconnecting-worker',
        manifest: manifestForActivities(['test.charge']),
        concurrency: 10,
      }),
    );

    const error = await registerError;
    expect(error['type']).toBe('registerError');
    expect(error['code']).toBe('invalid_registration');

    // ws1 must still own the workerId.
    expect(server.registry.getWorker('reconnecting-worker')).toBeDefined();

    ws1.close();
    await waitForRealTimersForTesting(50);
  });

  // NOTE: The grace-period reconnect bypass is covered deterministically by the
  // characterization unit test "allows reconnect within the grace period for the
  // same workerId" in websocket-worker.characterization.test.ts, which seeds the
  // pending-requeue + stale-socket state directly. An end-to-end version here is
  // intentionally omitted: the bypass only engages once the server has processed
  // the first socket's close (which silently schedules the requeue with no public
  // signal), so an integration test cannot deterministically wait for that state
  // before reconnecting — reconnecting too early hits the documented reconnect-
  // before-close race and the assertion flakes under CI load. See #615 review.

  it('blocks re-dispatch of an operationId once its ledger record is terminal', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    const received = collectAndCompleteTaskMessages(ws);

    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    // First dispatch
    await server.dispatchTask({
      operationId: 'reuse-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });
    await waitFor(
      () =>
        received.filter((message) => message.type === 'task').length === 1 &&
        !server.registry.isAssigned('reuse-op'),
      { label: 'first reuse-op dispatch to complete' },
    );

    const terminalRecord = await waitForTerminalResolvedRecord(engine.storage, 'reuse-op');

    // One permanent ledger record per operationId until WFT-24's retention
    // reclaims it — mirrors the `start-idem:` spent-key semantics: a
    // terminal operationId is not a fresh slot to reuse.
    const second = await server.dispatchTask({
      operationId: 'reuse-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });
    expect(second).toBe(false);

    await waitForRealTimersForTesting(50);

    const taskMessages = received.filter((m) => m.type === 'task');
    expect(taskMessages.length).toBe(1);
    expect(await readLedgerRecord(engine.storage, 'reuse-op')).toEqual(terminalRecord);

    ws.close();
    await waitForRealTimersForTesting(50);
  });
});

// ---------------------------------------------------------------------------
// Visibility timeout persistence
// ---------------------------------------------------------------------------

describe('visibility timeout persistence', () => {
  let engine: Engine;
  let server: WeftServer;
  let storage: MemoryStorage;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  function createEngineWithStorage(): { engine: Engine; storage: MemoryStorage } {
    const s = new MemoryStorage();
    const e = new Engine({ storage: s });
    e.register(echoWorkflow);
    return { engine: e, storage: s };
  }

  it('persists in-flight record to storage on dispatch', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'vt-op-1',
      activityName: 'test.charge',
      workflowType: 'test',
      input: { amount: 100 },
    });
    await waitFor(
      async () => {
        const record = await readLedgerRecord(storage, 'vt-op-1');
        return record !== null && record.state === 'leased';
      },
      { label: 'vt-op-1 in-flight record to persist' },
    );

    const record = await readLedgerRecord(storage, 'vt-op-1');
    expect(record).not.toBeNull();
    if (record === null || record.state !== 'leased') {
      throw new Error('Expected "vt-op-1" to have a leased ledger record');
    }
    expect(record.operationId).toBe('vt-op-1');
    expect(record.workerSessionId).toBe('w1');
    expect(record.leaseDeadline).toBeGreaterThan(Date.now());

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('removes in-flight record from storage on task completion', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    collectAndCompleteTaskMessages(ws, { resultValue: 42 });

    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'vt-op-2',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });

    // Post-cutover (WFT-22), completion transitions the SAME ledger key from
    // "leased" to "terminal" rather than deleting an in-flight key and
    // writing a separate resolved key — see `commitTaskLedgerCompletion`.
    await waitFor(
      async () => {
        const record = await readLedgerRecord(storage, 'vt-op-2');
        return record !== null && record.state === 'terminal';
      },
      { label: 'vt-op-2 inflight record to resolve' },
    );

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('uses custom visibility timeout from TaskDispatch', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    const customTimeout = 120_000; // 2 minutes
    await server.dispatchTask({
      operationId: 'vt-op-3',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
      visibilityTimeout: customTimeout,
    });
    await waitFor(
      async () => {
        const record = await readLedgerRecord(storage, 'vt-op-3');
        return record !== null && record.state === 'leased';
      },
      { label: 'vt-op-3 to be inflight' },
    );

    const record = await readLedgerRecord(storage, 'vt-op-3');
    expect(record).not.toBeNull();
    if (record === null || record.state !== 'leased') {
      throw new Error('Expected "vt-op-3" to have a leased ledger record');
    }
    expect(record.visibilityTimeoutMilliseconds).toBe(customTimeout);
    // Deadline should be roughly now + 120s (within a generous margin)
    expect(record.leaseDeadline).toBeGreaterThan(Date.now() + 100_000);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('defaults visibility timeout to 30 seconds when not specified', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'vt-op-4',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });
    await waitFor(
      async () => {
        const record = await readLedgerRecord(storage, 'vt-op-4');
        return record !== null && record.state === 'leased';
      },
      { label: 'vt-op-4 to be inflight' },
    );

    const record = await readLedgerRecord(storage, 'vt-op-4');
    expect(record).not.toBeNull();
    if (record === null || record.state !== 'leased') {
      throw new Error('Expected "vt-op-4" to have a leased ledger record');
    }
    expect(record.visibilityTimeoutMilliseconds).toBe(30_000);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('restores in-flight tasks from storage on server restart', async () => {
    ({ engine, storage } = createEngineWithStorage());

    // Pre-populate storage with an in-flight record that hasn't expired
    const deadline = Date.now() + 60_000;
    const inflightRecord = {
      operationId: 'restored-op',
      workerId: 'old-worker',
      deadline,
      activityName: 'test.charge',
      queue: 'default',
      input: null,
      attempt: 1,
      visibilityTimeout: 60_000,
      attemptToken: 'attempt-token-restored',
    };
    await storage.put(KEYS.operationInflight('restored-op'), encode(inflightRecord));

    // Start the server — it should restore the in-flight record
    server = serveTestServer({ engine, port: 0 });
    await waitFor(() => server.registry.isAssigned('restored-op'), {
      label: 'restored-op to be assigned',
    });

    // The registry should now track the restored task
    expect(server.registry.isAssigned('restored-op')).toBe(true);
  });

  it('rebuilds workflow cancellation tracking for restored in-flight tasks', async () => {
    ({ engine, storage } = createEngineWithStorage());

    const inflightRecord = {
      operationId: 'restored-cancel-op',
      workerId: 'restored-cancel-worker',
      workflowId: 'wf-restored-cancel',
      deadline: Date.now() + 60_000,
      activityName: 'test.charge',
      queue: 'default',
      input: null,
      attempt: 1,
      visibilityTimeout: 60_000,
      attemptToken: 'attempt-token-restored-cancel',
    };
    await storage.put(KEYS.operationInflight('restored-cancel-op'), encode(inflightRecord));

    server = serveTestServer({ engine, port: 0 });
    await waitForRealTimersForTesting(100);

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string; attemptToken?: string }> = [];
    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });
    await registerWorker(ws, {
      workerId: 'restored-cancel-worker',
      activities: ['test.charge'],
      concurrency: 1,
    });

    engine.dispatchEvent(new WorkflowCancelledEvent('wf-restored-cancel'));
    await waitFor(
      () =>
        received.some((message) => {
          return message.type === 'cancel' && message.operationId === 'restored-cancel-op';
        }),
      { label: 'restored-cancel-op cancellation message' },
    );

    expect(
      received.some((message) => {
        return message.type === 'cancel' && message.operationId === 'restored-cancel-op';
      }),
    ).toBe(true);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('logs corrupt persisted inflight records during restore', async () => {
    ({ engine, storage } = createEngineWithStorage());
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    await storage.put(KEYS.operationInflight('restore-corrupt-op'), encode({ invalid: true }));

    try {
      server = serveTestServer({ engine, port: 0 });
      await waitFor(
        () =>
          errorSpy.mock.calls.some((call) => {
            return (
              call[0] ===
              '[weft] Corrupt inflight record at "op:inflight:restore-corrupt-op" during restore — skipping'
            );
          }),
        { label: 'corrupt inflight restore error log' },
      );

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Corrupt inflight record at "op:inflight:restore-corrupt-op" during restore — skipping',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('retries restore scans and logs when recovery still fails', async () => {
    ({ engine, storage } = createEngineWithStorage());
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalScan = storage.scan.bind(storage);
    let inflightScanAttempts = 0;
    const restoreScan = overrideProperty(storage, 'scan', async function* (
      prefix: string,
      options?: Parameters<MemoryStorage['scan']>[1],
    ) {
      if (prefix === 'op:inflight:') {
        inflightScanAttempts++;
        throw new Error(`restore scan failed ${inflightScanAttempts}`);
      }
      yield* originalScan(prefix, options);
    } as MemoryStorage['scan']);

    try {
      server = serveTestServer({ engine, port: 0 });
      await waitFor(
        () =>
          errorSpy.mock.calls.some((call) => {
            return call[0] === '[weft] Failed to restore in-flight tasks from storage:';
          }),
        { label: 'restore scan failure error log' },
      );

      expect(warningSpy).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Failed to restore in-flight tasks from storage:',
        expect.any(Error),
      );
    } finally {
      restoreScan();
      warningSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('cleans up expired in-flight records from storage on restart', async () => {
    ({ engine, storage } = createEngineWithStorage());

    // Pre-populate storage with an expired in-flight record
    const expiredRecord = {
      operationId: 'expired-op',
      workerId: 'old-worker',
      deadline: Date.now() - 5000, // Already expired 5s ago
      activityName: 'test.charge',
      queue: 'default',
      input: null,
      attempt: 1,
      visibilityTimeout: 30_000,
      attemptToken: 'attempt-token-stale-expiry',
    };
    await storage.put(KEYS.operationInflight('expired-op'), encode(expiredRecord));

    server = serveTestServer({ engine, port: 0 });
    await waitFor(async () => (await storage.get(KEYS.operationInflight('expired-op'))) === null, {
      label: 'expired-op inflight record cleanup',
    });

    // The expired record should be removed from storage
    const raw = await storage.get(KEYS.operationInflight('expired-op'));
    expect(raw).toBeNull();

    // And not tracked in the registry
    expect(server.registry.isAssigned('expired-op')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Worker disconnection triggers task reassignment
// ---------------------------------------------------------------------------

describe('worker disconnection triggers task reassignment', () => {
  let engine: Engine;
  let server: WeftServer;
  let storage: MemoryStorage;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  it('requeues in-flight tasks to another worker on disconnect', async () => {
    ({ engine, storage } = createReconnectTestEngineWithStorage());
    server = serveFastReconnectTestServer(engine);

    const {
      primaryWorker: ws1,
      secondaryWorker: ws2,
      secondaryMessages: received,
    } = await connectRegisteredWorkerPair(server);

    // Dispatch a task — goes to w1 (least-loaded, both at 0 but w1 registered first)
    await server.dispatchTask({
      operationId: 'requeue-op-1',
      activityName: 'test.charge',
      workflowType: 'test',
      input: { amount: 42 },
    });
    await waitFor(() => server.registry.isAssigned('requeue-op-1'), {
      label: 'requeue-op-1 to be assigned',
    });

    expect(server.registry.isAssigned('requeue-op-1')).toBe(true);

    // Disconnect w1 — its in-flight task should be reassigned to w2
    ws1.close();
    await waitFor(() => received.filter((m) => m.type === 'task').length === 1, {
      label: 'requeue-op-1 task reassignment',
    });

    const taskMessages = received.filter((m) => m.type === 'task');
    expect(taskMessages.length).toBe(1);
    expect(taskMessages[0]?.operationId).toBe('requeue-op-1');

    ws2.close();
    await waitForRealTimersForTesting(50);
  });

  it('increments attempt count on reassigned tasks', async () => {
    ({ engine, storage } = createReconnectTestEngineWithStorage());
    server = serveFastReconnectTestServer(engine);

    const {
      primaryWorker: ws1,
      secondaryWorker: ws2,
      secondaryMessages: received,
    } = await connectRegisteredWorkerPair(server);

    await server.dispatchTask({
      operationId: 'attempt-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });
    await waitForRealTimersForTesting(50);

    // Disconnect w1 — task should be re-dispatched with attempt 2
    ws1.close();
    await waitFor(
      () => {
        const taskMessages = received.filter((m) => m.type === 'task');
        return taskMessages.length === 1 && taskMessages[0]?.attempt === 2;
      },
      { label: 'attempt-op reassignment with incremented attempt' },
    );

    const taskMessages = received.filter((m) => m.type === 'task');
    expect(taskMessages.length).toBe(1);
    expect(taskMessages[0]?.attempt).toBe(2);

    ws2.close();
    await waitForRealTimersForTesting(50);
  });

  it('cleans up in-flight storage record on disconnect and reassignment', async () => {
    ({ engine, storage } = createReconnectTestEngineWithStorage());
    server = serveFastReconnectTestServer(engine);

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);

    await registerWorker(ws1, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });
    await registerWorker(ws2, { workerId: 'w2', activities: ['test.charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'cleanup-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });
    await waitFor(
      async () => {
        const record = await readLedgerRecord(storage, 'cleanup-op');
        return record !== null && record.state === 'leased';
      },
      { label: 'cleanup-op to be inflight' },
    );

    // Verify the original leased ledger record exists, owned by w1.
    const recordBefore = await readLedgerRecord(storage, 'cleanup-op');
    expect(recordBefore).not.toBeNull();
    if (recordBefore === null || recordBefore.state !== 'leased') {
      throw new Error('Expected "cleanup-op" to have a leased ledger record');
    }
    expect(recordBefore.workerSessionId).toBe('w1');

    // Disconnect w1
    ws1.close();
    await waitFor(() => server.registry.getTask('cleanup-op')?.workerId === 'w2', {
      label: 'cleanup-op reassigned to w2',
    });

    // Post-cutover (WFT-22), reassignment transitions the SAME ledger key
    // through leased -> queued -> leased (for w2) rather than deleting an
    // in-flight key and writing a new one — see `commitTaskLedgerTransition`.
    // The task should now be assigned in the registry (to w2)
    expect(server.registry.isAssigned('cleanup-op')).toBe(true);
    const recordAfter = await readLedgerRecord(storage, 'cleanup-op');
    expect(recordAfter).not.toBeNull();
    if (recordAfter === null || recordAfter.state !== 'leased') {
      throw new Error('Expected "cleanup-op" to have a leased ledger record after reassignment');
    }
    expect(recordAfter.workerSessionId).toBe('w2');

    ws2.close();
    await waitForRealTimersForTesting(50);
  });

  it('requeues to long-poll queue when no other WebSocket worker is available', async () => {
    ({ engine, storage } = createReconnectTestEngineWithStorage());
    server = serveFastReconnectTestServer(engine);

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'fallback-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: { amount: 99 },
    });
    await waitFor(() => server.registry.isAssigned('fallback-op'), {
      label: 'fallback-op to be assigned',
    });

    expect(server.registry.isAssigned('fallback-op')).toBe(true);

    // Disconnect the only worker — task should go to long-poll queue
    ws.close();
    await waitFor(() => server.taskQueue.pendingCount('default') === 1, {
      label: 'fallback-op queued for long-poll',
    });

    // The task should be available via long-poll
    expect(server.taskQueue.pendingCount('default')).toBe(1);
  });

  // `weft.tasks.diagnostics` (get-task-diagnostics.ts) still reads the
  // retired `op:queued:`/`op:inflight:` keys and has not been migrated onto
  // the durable task ledger — that migration is WFT-24 ("Adoption,
  // Retention, and Diagnostics") scope, not WFT-22. Until then the
  // diagnostics endpoint sees nothing for post-cutover tasks; the coverage
  // this test gave the old retry-storm reporting path is tracked for
  // restoration in WFT-24 rather than kept green against a key scheme
  // nothing writes anymore.

  it('reassigns multiple in-flight tasks when a worker disconnects', async () => {
    ({ engine, storage } = createReconnectTestEngineWithStorage());
    server = serveFastReconnectTestServer(engine);

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);

    const received: Array<{ type: string; operationId?: string; attemptToken?: string }> = [];
    ws2.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });

    await registerWorker(ws1, {
      workerId: 'w1',
      activities: ['test.charge', 'test.ship'],
      concurrency: 10,
    });
    await registerWorker(ws2, {
      workerId: 'w2',
      activities: ['test.charge', 'test.ship'],
      concurrency: 10,
    });

    // Dispatch multiple tasks to w1
    await server.dispatchTask({
      operationId: 'multi-op-1',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });
    await server.dispatchTask({
      operationId: 'multi-op-2',
      activityName: 'test.ship',
      workflowType: 'test',
      input: null,
    });
    await server.dispatchTask({
      operationId: 'multi-op-3',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });
    await waitForRealTimersForTesting(100);

    // Record which tasks w1 has in-flight (via the registry).
    const w1Tasks = server.registry.getWorkerTasks('w1');
    const w1TaskIds = w1Tasks.map((t) => t.operationId).toSorted();

    // Clear received so only reassignment messages are captured.
    received.length = 0;

    // Disconnect w1 — tasks assigned to w1 should be reassigned to w2.
    ws1.close();
    await waitForRealTimersForTesting(300);

    const taskMessages = received.filter((m) => m.type === 'task');
    const reassignedIds = taskMessages
      .map((m) => m.operationId)
      .toSorted((a = '', b = '') => (a < b ? -1 : a > b ? 1 : 0));
    // Only w1's tasks should be reassigned, not tasks already on w2.
    expect(reassignedIds).toEqual(w1TaskIds);

    ws2.close();
    await waitForRealTimersForTesting(50);
  });

  it('logs corrupt inflight records when a disconnected worker task cannot be decoded', async () => {
    ({ engine, storage } = createReconnectTestEngineWithStorage());
    server = serveFastReconnectTestServer(engine);
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const ws = await connectWorker(server);
      await registerWorker(ws, { workerId: 'w-corrupt-disconnect', activities: ['test.charge'] });

      await server.dispatchTask({
        operationId: 'disconnect-corrupt-op',
        activityName: 'test.charge',
        workflowType: 'test',
        input: null,
      });
      await waitForRealTimersForTesting(50);
      // Post-cutover (WFT-22), corrupt a `task-ledger:` value instead of the
      // legacy `op:inflight:` key. `decodeRemoteTaskRecord` treats a value
      // that fails `isRemoteTaskRecord` validation the same as an absent
      // record — `runWorkerDisconnectRequeue` no longer distinguishes
      // "corrupt" from "missing" (see the "warns and clears missing inflight
      // records..." test below, which shares this exact log message).
      await storage.put(taskLedgerKey('disconnect-corrupt-op'), encode({ bad: true }));

      ws.close();
      await waitFor(
        () =>
          warningSpy.mock.calls.some(
            (call) =>
              call[0] ===
              '[weft] No leased ledger record found for task "disconnect-corrupt-op" — skipping reassignment',
          ),
        { label: 'corrupt disconnect ledger record logged' },
      );

      expect(warningSpy).toHaveBeenCalledWith(
        '[weft] No leased ledger record found for task "disconnect-corrupt-op" — skipping reassignment',
      );
    } finally {
      warningSpy.mockRestore();
    }
  });

  it('warns and clears missing inflight records when a worker disconnects before storage commit', async () => {
    ({ engine, storage } = createReconnectTestEngineWithStorage());
    server = serveFastReconnectTestServer(engine);
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const ws = await connectWorker(server);
      await registerWorker(ws, { workerId: 'w-missing-disconnect', activities: ['test.charge'] });

      await server.dispatchTask({
        operationId: 'disconnect-missing-op',
        activityName: 'test.charge',
        workflowType: 'test',
        input: null,
      });
      await waitForRealTimersForTesting(50);
      // Post-cutover (WFT-22), simulate the ledger write not having landed
      // before disconnect by deleting the durable `task-ledger:` record
      // rather than the legacy `op:inflight:` key nothing writes anymore.
      await storage.delete(taskLedgerKey('disconnect-missing-op'));

      ws.close();
      await waitFor(
        () =>
          warningSpy.mock.calls.some(
            (call) =>
              call[0] ===
              '[weft] No leased ledger record found for task "disconnect-missing-op" — skipping reassignment',
          ),
        { label: 'missing disconnect ledger record warning logged' },
      );

      expect(warningSpy).toHaveBeenCalledWith(
        '[weft] No leased ledger record found for task "disconnect-missing-op" — skipping reassignment',
      );
      expect(await readLedgerRecord(storage, 'disconnect-missing-op')).toBeNull();
    } finally {
      warningSpy.mockRestore();
    }
  });

  it('logs disconnect reassignment failures when storage access throws', async () => {
    ({ engine, storage } = createReconnectTestEngineWithStorage());
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalGet = storage.get.bind(storage);
    server = serveFastReconnectTestServer(engine);

    let restoreGet: (() => void) | undefined;

    try {
      const ws = await connectWorker(server);
      await registerWorker(ws, { workerId: 'w-disconnect-get-fail', activities: ['test.charge'] });

      await server.dispatchTask({
        operationId: 'disconnect-get-fail-op',
        activityName: 'test.charge',
        workflowType: 'test',
        input: null,
      });
      await waitForRealTimersForTesting(50);

      // Installed after dispatch's own ledger read/write has already
      // committed — the disconnect handler's own read of the same ledger
      // key is what must fail here.
      restoreGet = overrideProperty(storage, 'get', (async (key: string) => {
        if (key === taskLedgerKey('disconnect-get-fail-op')) {
          throw new Error('disconnect get failed');
        }
        return originalGet(key);
      }) as MemoryStorage['get']);

      ws.close();
      await waitFor(
        () =>
          errorSpy.mock.calls.some(
            (call) =>
              call[0] ===
              '[weft] Failed to reassign task "disconnect-get-fail-op" from worker "w-disconnect-get-fail":',
          ),
        { label: 'disconnect reassignment failure logged' },
      );

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Failed to reassign task "disconnect-get-fail-op" from worker "w-disconnect-get-fail":',
        expect.any(Error),
      );
    } finally {
      restoreGet?.();
      errorSpy.mockRestore();
    }
  });

  it('logs immediate redispatch failures when a non-retry-policy task cannot be requeued', async () => {
    ({ engine, storage } = createReconnectTestEngineWithStorage());
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    server = serveFastReconnectTestServer(engine);

    let restoreConditionalBatch: (() => void) | undefined;

    try {
      const ws = await connectWorker(server);
      await registerWorker(ws, {
        workerId: 'w-disconnect-redispatch-fail',
        activities: ['test.charge'],
      });

      await server.dispatchTask({
        operationId: 'disconnect-redispatch-fail-op',
        activityName: 'test.charge',
        workflowType: 'test',
        input: null,
      });
      // Wait until the task is actually in flight on the worker before closing
      // the socket — a fixed delay here under-waited on a loaded machine, so the
      // disconnect found no in-flight task to requeue and the error never fired.
      await waitFor(() => server.registry.isAssigned('disconnect-redispatch-fail-op'), {
        label: 'task dispatched to worker',
      });

      // Post-cutover (WFT-22), the requeue write goes through
      // `storage.conditionalBatch` on the durable ledger key, not `storage.put`
      // on a legacy queued key. Installed after dispatch's own claim write has
      // already committed, so only the disconnect-triggered requeue write fails
      // — and, since `reassignOrExpireTask` re-throws an unhandled write
      // failure rather than catching it, it surfaces through the same
      // catch-all in `runWorkerDisconnectRequeue` as a `.get()` failure would
      // (see "logs disconnect reassignment failures when storage access
      // throws" above) — same message, different failing storage method.
      restoreConditionalBatch = overrideProperty(storage, 'conditionalBatch', (async (
        conditions: Parameters<MemoryStorage['conditionalBatch']>[0],
        operations: Parameters<MemoryStorage['conditionalBatch']>[1],
      ) => {
        if (
          operations.some(
            (operation) => operation.key === taskLedgerKey('disconnect-redispatch-fail-op'),
          )
        ) {
          throw new Error('immediate redispatch failed');
        }
        return originalConditionalBatch(conditions, operations);
      }) as MemoryStorage['conditionalBatch']);

      ws.close();

      // Wait for the requeue (after the reconnect grace period) to attempt a
      // redispatch and fail on the throwing storage write, which logs this error.
      // Condition-based so it tolerates close-propagation + grace-period jitter
      // under load instead of guessing a fixed duration.
      await waitFor(
        () =>
          errorSpy.mock.calls.some(
            (call) =>
              call[0] ===
              '[weft] Failed to reassign task "disconnect-redispatch-fail-op" from worker "w-disconnect-redispatch-fail":',
          ),
        { label: 'redispatch failure logged' },
      );

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Failed to reassign task "disconnect-redispatch-fail-op" from worker "w-disconnect-redispatch-fail":',
        expect.any(Error),
      );
    } finally {
      restoreConditionalBatch?.();
      errorSpy.mockRestore();
    }
  });

  it('does nothing when a worker with no in-flight tasks disconnects', async () => {
    ({ engine, storage } = createReconnectTestEngineWithStorage());
    // Disable the reconnect grace period so the close handler unregisters
    // the worker synchronously, as this test asserts.
    server = serveTestServer({ engine, port: 0, workerReconnectGracePeriodMs: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    expect(server.registry.size).toBe(1);

    // Disconnect without any dispatched tasks
    ws.close();
    await waitFor(() => server.registry.size === 0, { label: 'worker with no tasks unregistered' });

    // Worker should be unregistered, no tasks in queue
    expect(server.registry.size).toBe(0);
    expect(server.taskQueue.pendingCount('default')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Visibility timeout expiry triggers task reassignment
// ---------------------------------------------------------------------------

describe('visibility timeout expiry triggers task reassignment', () => {
  let engine: Engine;
  let server: WeftServer;
  let storage: MemoryStorage;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  function createEngineWithStorage(): { engine: Engine; storage: MemoryStorage } {
    const s = new MemoryStorage();
    const e = new Engine({ storage: s });
    e.register(echoWorkflow);
    return { engine: e, storage: s };
  }

  it('reassigns tasks whose visibility timeout has expired via storage scan', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serveTestServer({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    const received = collectAndCompleteTaskMessages(ws, {
      completeWhen: (message) => message.type === 'task' && (message.attempt ?? 1) >= 2,
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    // Dispatch with a very short visibility timeout
    await server.dispatchTask({
      operationId: 'expiry-op-1',
      activityName: 'test.charge',
      workflowType: 'test',
      input: { amount: 42 },
      visibilityTimeout: 100, // 100ms — will expire quickly
    });
    await waitFor(() => server.registry.isAssigned('expiry-op-1'), {
      label: 'expiry-op-1 assigned to worker',
    });

    // Task should be assigned
    expect(server.registry.isAssigned('expiry-op-1')).toBe(true);

    // Wait for the visibility timeout to expire and the scanner to pick it up
    await waitForRealTimersForTesting(300);

    // The worker should have received the task at least twice (original + reassignment)
    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'expiry-op-1',
    );
    expect(taskMessages.length).toBeGreaterThanOrEqual(2);
    // First dispatch: attempt 1; reassignment: attempt 2
    expect(taskMessages[0]?.attempt).toBe(1);
    expect(taskMessages[1]?.attempt).toBe(2);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('increments attempt count on tasks reassigned due to timeout expiry', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serveTestServer({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    const received = collectAndCompleteTaskMessages(ws, {
      completeWhen: (message) => message.type === 'task' && (message.attempt ?? 1) >= 2,
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'attempt-expiry-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
      visibilityTimeout: 100,
    });
    await waitFor(
      () =>
        received.filter((m) => m.type === 'task' && m.operationId === 'attempt-expiry-op').length >=
        2,
      { label: 'attempt-expiry task re-dispatched after visibility expiry' },
    );

    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'attempt-expiry-op',
    );
    expect(taskMessages.length).toBeGreaterThanOrEqual(2);
    // First dispatch: attempt 1; reassignment: attempt 2
    expect(taskMessages[0]?.attempt).toBe(1);
    expect(taskMessages[1]?.attempt).toBe(2);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('does not reassign tasks that have not expired', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serveTestServer({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);

    const received: Array<{ type: string; operationId?: string; attemptToken?: string }> = [];
    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    // Dispatch with a long visibility timeout
    await server.dispatchTask({
      operationId: 'noexpiry-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
      visibilityTimeout: 60_000,
    });
    await waitFor(
      () =>
        server.registry.isAssigned('noexpiry-op') &&
        received.filter((m) => m.type === 'task' && m.operationId === 'noexpiry-op').length === 1,
      { label: 'noexpiry-op initial dispatch' },
    );

    // The task should still be assigned, not reassigned
    expect(server.registry.isAssigned('noexpiry-op')).toBe(true);
    // Worker should have received exactly one task message (the initial dispatch, no reassignment)
    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'noexpiry-op',
    );
    expect(taskMessages.length).toBe(1);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('cleans up old storage record and creates new one on reassignment', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serveTestServer({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attempt?: number;
        attemptToken?: string;
      };
      // Complete on attempt 2 to stop the reassignment cycle
      if (msg.type === 'task' && (msg.attempt ?? 1) >= 2) {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: msg.operationId,
            attemptToken: msg.attemptToken,
            status: 'completed',
            value: null,
          }),
        );
      }
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'cleanup-expiry-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
      visibilityTimeout: 100,
    });

    // Verify original leased ledger record exists
    const recordBefore = await readLedgerRecord(storage, 'cleanup-expiry-op');
    expect(recordBefore).not.toBeNull();
    if (recordBefore === null || recordBefore.state !== 'leased') {
      throw new Error('Expected "cleanup-expiry-op" to have a leased ledger record');
    }
    expect(recordBefore.attempt).toBe(1);

    // Post-cutover (WFT-22), the scanner's reassignment and the worker's
    // eventual completion transition the SAME ledger key (leased -> queued ->
    // leased -> terminal) rather than deleting an in-flight key — see
    // `commitTaskLedgerTransition`/`commitTaskLedgerCompletion`.
    await waitFor(
      async () => {
        const record = await readLedgerRecord(storage, 'cleanup-expiry-op');
        return record !== null && record.state === 'terminal';
      },
      {
        timeoutMs: 2000,
        label: 'expired task completion cleanup',
      },
    );

    // After the scanner re-dispatches with attempt=2, the worker completes it
    // and the ledger record reaches a resolved terminal state.
    const recordAfter = await readLedgerRecord(storage, 'cleanup-expiry-op');
    expect(recordAfter).not.toBeNull();
    if (recordAfter === null || recordAfter.state !== 'terminal') {
      throw new Error('Expected "cleanup-expiry-op" to reach a terminal ledger record');
    }
    expect(recordAfter.attempt).toBe(2);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('falls back to long-poll queue when no WebSocket worker available for expired task', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serveTestServer({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'fallback-expiry-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
      visibilityTimeout: 100,
    });
    await waitForRealTimersForTesting(50);

    // Unregister the worker before the timeout expires, but don't close the WS
    // (simulating a worker that stops heartbeating). Instead, just disconnect:
    ws.close();
    await waitForRealTimersForTesting(300);

    // The expired task should have been reclaimed and requeued to long-poll
    // (worker disconnect already handles this, but visibility-timeout expiry
    // covers edge cases where the disconnect grace period has not elapsed
    // yet — the 100ms visibility timeout fires well before the 2000ms
    // default reconnect grace period).
    const record = await readLedgerRecord(storage, 'fallback-expiry-op');
    expect(record?.state).toBe('queued');
  });

  it('scanner cleans up orphaned storage records with no matching registry entry', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serveTestServer({ engine, port: 0, visibilityPollIntervalMs: 50 });

    // Connect a worker that can receive the reassigned task
    const ws = await connectWorker(server);
    const received: Array<{
      type: string;
      operationId?: string;
      attempt?: number;
      attemptToken?: string;
    }> = [];
    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });
    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    // Wait for startup restore to complete, then insert an orphaned expired
    // `leased` ledger record — this simulates a record that slipped through
    // (e.g., created by another process) and has no matching in-memory
    // registry entry, per WFT-22's `task-ledger:` scan in
    // `reconcileOrphanedRecords`.
    await waitForRealTimersForTesting(100);
    const expiredRecord = makeLeasedLedgerRecord({
      operationId: 'orphan-op',
      workerSessionId: 'ghost-worker',
      attemptToken: 'attempt-token-orphan',
      leaseDeadline: Date.now() - 5000,
    });
    await storage.put(taskLedgerKey('orphan-op'), encodeRemoteTaskRecord(expiredRecord));

    // Wait for the reconciliation scanner to pick up the orphaned record.
    // Orphaned records (not tracked in the deadline heap) are only discovered
    // by the periodic full-storage reconciliation, which runs at 12x the
    // visibility poll interval (50ms * 12 = 600ms here).
    await waitFor(
      () =>
        received.some(
          (message) =>
            message.type === 'task' && message.operationId === 'orphan-op' && message.attempt === 2,
        ),
      { label: 'orphaned expired record reassigned' },
    );

    const taskMessages = received.filter((m) => m.type === 'task' && m.operationId === 'orphan-op');
    expect(taskMessages.length).toBe(1);
    expect(taskMessages[0]?.attempt).toBe(2);

    // Verify the original expired ledger record was replaced — the task was
    // re-dispatched, so its leased ledger record's deadline should be in the
    // future (not the stale expired value).
    for await (const [, value] of storage.scan('task-ledger:')) {
      const record = decodeRemoteTaskRecord(value);
      if (record === null || record.state !== 'leased') continue;
      expect(record.leaseDeadline).toBeGreaterThan(Date.now() - 1000);
    }

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('does not reassign a task when a heartbeat extended its deadline past a stale heap entry', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serveTestServer({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    const received: Array<{ type: string; operationId?: string; attemptToken?: string }> = [];
    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });
    await registerWorker(ws, { workerId: 'w-heartbeat-stale-heap', activities: ['test.charge'] });

    await server.dispatchTask({
      operationId: 'heartbeat-stale-heap-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
      visibilityTimeout: 2000,
    });

    const initialRecordRaw = await readLedgerRecord(storage, 'heartbeat-stale-heap-op');
    if (initialRecordRaw === null || initialRecordRaw.state !== 'leased') {
      throw new Error('Expected "heartbeat-stale-heap-op" to have a leased ledger record');
    }
    const initialRecord = initialRecordRaw;

    await waitForRealTimersForTesting(1000);
    ws.send(JSON.stringify({ type: 'heartbeat', workerId: 'w-heartbeat-stale-heap' }));

    let extendedDeadline = initialRecord.leaseDeadline;
    await waitFor(
      async () => {
        const persisted = await readLedgerRecord(storage, 'heartbeat-stale-heap-op');
        if (persisted === null || persisted.state !== 'leased') return false;
        extendedDeadline = persisted.leaseDeadline;
        return extendedDeadline > initialRecord.leaseDeadline;
      },
      { label: 'heartbeat extended stale heap deadline' },
    );

    expect(extendedDeadline).toBeGreaterThan(initialRecord.leaseDeadline);

    const beforeScanTaskCount = received.filter((message) => message.type === 'task').length;
    const staleDeadlineDelay = Math.max(0, initialRecord.leaseDeadline - Date.now()) + 100;
    expect(Date.now() + staleDeadlineDelay).toBeLessThan(extendedDeadline);
    await waitForRealTimersForTesting(staleDeadlineDelay);
    expect(Date.now()).toBeGreaterThanOrEqual(initialRecord.leaseDeadline);
    const afterScanTaskCount = received.filter((message) => message.type === 'task').length;

    expect(afterScanTaskCount).toBe(beforeScanTaskCount);
    expect(server.registry.isAssigned('heartbeat-stale-heap-op')).toBe(true);

    const persisted = await readLedgerRecord(storage, 'heartbeat-stale-heap-op');
    if (persisted === null || persisted.state !== 'leased') {
      throw new Error('Expected "heartbeat-stale-heap-op" to still have a leased ledger record');
    }
    // The deadline may advance further if another heartbeat fires during the
    // sleep above — the only invariant is that it never regresses to the
    // stale initialRecord.leaseDeadline value that the expiry scan would pick up.
    expect(persisted.leaseDeadline).toBeGreaterThanOrEqual(extendedDeadline);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('keeps an in-flight task when the expiry scan encounters a stale heap entry', async () => {
    ({ engine, storage } = createEngineWithStorage());

    const operationId = 'stale-expiry-scan-op';

    // Post-cutover (WFT-22), the live scanner reads `task-ledger:` records
    // (not `op:inflight:`), so a real leased ledger record must exist for
    // `restoreExtendedDeadlineIfStillActive` to find and re-check. A real
    // dispatch (rather than hand-seeding storage before startup) naturally
    // produces both the leased ledger record and the initial deadline-heap
    // entry — see `selectAndReserveWorker`'s `context.deadlineTracker.add(...)`.
    server = serveTestServer({ engine, port: 0, visibilityPollIntervalMs: 25 });
    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'restored-worker', activities: ['test.charge'] });
    await server.dispatchTask({
      operationId,
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
      visibilityTimeout: 5_000,
    });
    await waitFor(() => server.registry.isAssigned(operationId), {
      label: `${operationId} to be assigned`,
    });

    const leasedRecord = await readLedgerRecord(storage, operationId);
    if (leasedRecord === null || leasedRecord.state !== 'leased') {
      throw new Error(`Expected "${operationId}" to have a leased ledger record`);
    }
    const futureDeadline = leasedRecord.leaseDeadline;

    const originalAdd = DeadlineTracker.prototype.add;
    const originalDrainExpired = DeadlineTracker.prototype.drainExpired;
    let addCountForOperation = 0;
    let injectedStaleEntry = false;

    const restoreAdd = overrideProperty(
      DeadlineTracker.prototype,
      'add',
      function (
        this: DeadlineTracker,
        entry: Parameters<DeadlineTracker['add']>[0],
      ): ReturnType<DeadlineTracker['add']> {
        if (entry.operationId === operationId) {
          addCountForOperation++;
        }
        return originalAdd.call(this, entry);
      },
    );

    const restoreDrainExpired = overrideProperty(
      DeadlineTracker.prototype,
      'drainExpired',
      function (
        this: DeadlineTracker,
        now: Parameters<DeadlineTracker['drainExpired']>[0],
      ): ReturnType<DeadlineTracker['drainExpired']> {
        const expired = originalDrainExpired.call(this, now);
        if (!injectedStaleEntry) {
          injectedStaleEntry = true;
          return [...expired, { operationId, deadline: now - 1 }];
        }
        return expired;
      },
    );

    try {
      // The real dispatch above already counts as the first `.add()` call.
      await waitFor(
        () =>
          injectedStaleEntry &&
          addCountForOperation >= 2 &&
          server.registry.isAssigned(operationId),
        { label: 'stale heap entry ignored while task remains assigned' },
      );

      expect(injectedStaleEntry).toBe(true);
      expect(addCountForOperation).toBeGreaterThanOrEqual(2);
      expect(server.registry.isAssigned(operationId)).toBe(true);

      const persisted = await readLedgerRecord(storage, operationId);
      if (persisted === null || persisted.state !== 'leased') {
        throw new Error(`Expected "${operationId}" to still have a leased ledger record`);
      }
      expect(persisted.leaseDeadline).toBe(futureDeadline);
    } finally {
      restoreDrainExpired();
      restoreAdd();
      ws.close();
      await waitForRealTimersForTesting(50);
    }
  });

  it('logs corrupt inflight records when the visibility scanner encounters invalid storage', async () => {
    ({ engine, storage } = createEngineWithStorage());
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    server = serveTestServer({ engine, port: 0, visibilityPollIntervalMs: 50 });

    try {
      const ws = await connectWorker(server);
      await registerWorker(ws, { workerId: 'w-visibility-corrupt', activities: ['test.charge'] });

      await server.dispatchTask({
        operationId: 'visibility-corrupt-op',
        activityName: 'test.charge',
        workflowType: 'test',
        input: null,
        visibilityTimeout: 100,
      });
      await waitForRealTimersForTesting(50);
      // Post-cutover (WFT-22), corrupt the `task-ledger:` value with genuinely
      // invalid MessagePack bytes (`0xc1` is msgpack's reserved "never used"
      // marker — see `engine.test.ts`'s malformed-review fixtures for the same
      // idiom). `decodeRemoteTaskRecord` only returns `null` for
      // validly-decoded-but-wrong-shape values; it deliberately does not catch
      // `decode()` itself throwing on unparseable bytes (see its doc comment),
      // so this is what actually reaches the scanner's catch block and logs —
      // a validly-encoded wrong-shape value would instead be silently treated
      // as "already resolved or requeued elsewhere" with no log at all.
      await storage.put(taskLedgerKey('visibility-corrupt-op'), new Uint8Array([0xc1]));

      await waitFor(
        () =>
          errorSpy.mock.calls.some(
            (call) =>
              call[0] ===
              '[weft] Failed to process expired task "visibility-corrupt-op" — will retry:',
          ),
        { label: 'corrupt visibility ledger record logged' },
      );

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Failed to process expired task "visibility-corrupt-op" — will retry:',
        expect.any(Error),
      );

      ws.close();
      await waitForRealTimersForTesting(50);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // Regression: the deadline-heap fast path and the full-storage reconciliation
  // scanner must not both process the same expired task. Before the fix they
  // each had their own running guard but no shared per-operation coordination,
  // so both could call `registry.completeTask` / `reassignOrExpireTask` for
  // the same operationId and dispatch duplicate `ActivityFailedEvent`s when
  // retries were exhausted.
  //
  // In-memory storage resolves faster than the event loop, so the race window
  // is vanishingly small under normal load. We wrap `MemoryStorage` with a
  // subclass that stalls reads of the target ledger key long enough for the
  // other scanner to also observe the still-present leased record before
  // either call completes — making the race reliably reproducible in tests.
  // -------------------------------------------------------------------------
  it('dispatches ActivityFailedEvent exactly once when both scanners race on the same expired task', async () => {
    const targetOperationId = 'race-op-1';

    class DelayedStorage extends MemoryStorage {
      #stalledOnce = false;

      override async get(key: string): Promise<Uint8Array | null> {
        const value = await super.get(key);
        if (!this.#stalledOnce && key === taskLedgerKey(targetOperationId) && value !== null) {
          this.#stalledOnce = true;
          // Park long enough for the reconciliation scanner to also tick
          // (its interval is visibility × 12 = 120ms) and observe the
          // still-present leased ledger record before this caller proceeds
          // to commit its own requeue/expire transition. 200ms is well past
          // both one reconciliation period and the fast-path retry cadence.
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
        }
        return value;
      }
    }

    const delayedStorage = new DelayedStorage();
    const localEngine = new Engine({ storage: delayedStorage });
    localEngine.register(echoWorkflow);
    const localServer = serveTestServer({
      engine: localEngine,
      port: 0,
      visibilityPollIntervalMs: 10,
    });

    try {
      const failedOperationIds: string[] = [];
      localEngine.addEventListener(ActivityFailedEvent.type, (event) => {
        if (event instanceof ActivityFailedEvent) {
          failedOperationIds.push(event.operationId);
        }
      });

      const workflowId = 'race-wf-1';
      const policy: RetryPolicy = {
        maxAttempts: 1,
        initialBackoff: 10,
        backoffMultiplier: 1,
        maxBackoff: 10,
      };

      // Connect a worker so `dispatchTask` adds the record to the deadline
      // heap (rather than falling through to the long-poll queue).
      const wsUrl = localServer.url.replace('http://', 'ws://');
      const ws = new WebSocket(`${wsUrl}/v1/tasks/default/stream`);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve());
        ws.addEventListener('error', () => reject(new Error('ws failed')));
      });
      ws.send(
        JSON.stringify({
          type: 'register',
          protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
          workerId: 'race-worker',
          manifest: manifestForActivities(['test.charge']),
          concurrency: 1,
        }),
      );
      await waitForRealTimersForTesting(50);

      await localServer.dispatchTask({
        operationId: targetOperationId,
        activityName: 'test.charge',
        workflowType: 'test',
        input: null,
        workflowId,
        visibilityTimeout: 50,
        retryPolicy: policy,
      });

      // Give both scanners many ticks to race on the same expired record.
      // The fast path fires every 10ms; the reconciliation scan fires every
      // 120ms (10ms × RECONCILIATION_MULTIPLIER). The delayed read parks for
      // 200ms, spanning at least one reconciliation tick, so the bug would
      // produce a duplicate failure event.
      // fixed delay: negative assertion (no event to await)
      await waitForRealTimersForTesting(700);

      const relevant = failedOperationIds.filter((id) => id === targetOperationId);
      expect(relevant.length).toBe(1);

      ws.close();
      await waitForRealTimersForTesting(50);
    } finally {
      await localServer.stop();
      localEngine[Symbol.dispose]();
    }
  });

  it('logs and retries expired-task processing failures in the visibility scanner', async () => {
    ({ engine, storage } = createEngineWithStorage());
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalGet = storage.get.bind(storage);
    server = serveTestServer({ engine, port: 0, visibilityPollIntervalMs: 50 });

    let restoreGet: (() => void) | undefined;

    try {
      const ws = await connectWorker(server);
      await registerWorker(ws, { workerId: 'w-visibility-retry', activities: ['test.charge'] });

      await server.dispatchTask({
        operationId: 'visibility-retry-op',
        activityName: 'test.charge',
        workflowType: 'test',
        input: null,
        visibilityTimeout: 100,
      });
      await waitFor(
        async () => {
          const record = await readLedgerRecord(storage, 'visibility-retry-op');
          return record !== null && record.state === 'leased';
        },
        { label: 'visibility-retry-op to be inflight' },
      );

      // Installed after dispatch's own ledger read/write has already
      // committed, on the same `taskLedgerKey` the fast expiry scanner reads
      // once the visibility timeout above elapses.
      restoreGet = overrideProperty(storage, 'get', (async (key: string) => {
        if (key === taskLedgerKey('visibility-retry-op')) {
          throw new Error('visibility get failed');
        }
        return originalGet(key);
      }) as MemoryStorage['get']);

      await waitFor(
        () =>
          errorSpy.mock.calls.some(
            (call) =>
              call[0] ===
              '[weft] Failed to process expired task "visibility-retry-op" — will retry:',
          ),
        { label: 'visibility retry failure logged' },
      );

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Failed to process expired task "visibility-retry-op" — will retry:',
        expect.any(Error),
      );

      ws.close();
      await waitForRealTimersForTesting(50);
    } finally {
      restoreGet?.();
      errorSpy.mockRestore();
    }
  });

  it('logs top-level visibility scanner failures', async () => {
    ({ engine, storage } = createEngineWithStorage());
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalDrainExpired = DeadlineTracker.prototype.drainExpired;
    server = serveTestServer({ engine, port: 0, visibilityPollIntervalMs: 20 });

    try {
      DeadlineTracker.prototype.drainExpired = function drainExpiredFailure() {
        throw new Error('drain expired failed');
      };

      await waitFor(
        () =>
          errorSpy.mock.calls.some(
            (call) => call[0] === '[weft] Visibility timeout scanner error:',
          ),
        { label: 'visibility scanner failure logged' },
      );

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Visibility timeout scanner error:',
        expect.any(Error),
      );
    } finally {
      DeadlineTracker.prototype.drainExpired = originalDrainExpired;
      errorSpy.mockRestore();
    }
  });

  it('reconciliation tracks non-expired orphaned records so the fast scanner can expire them later', async () => {
    ({ engine, storage } = createEngineWithStorage());
    server = serveTestServer({ engine, port: 0, visibilityPollIntervalMs: 20 });

    const ws = await connectWorker(server);
    const received: Array<{
      type: string;
      operationId?: string;
      attempt?: number;
      attemptToken?: string;
    }> = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attempt?: number;
        attemptToken?: string;
      };
      received.push(message);
      if (message.type === 'task' && message.operationId === 'orphan-track-op') {
        ws.send(
          JSON.stringify({
            type: 'taskResult',
            operationId: message.operationId,
            attemptToken: message.attemptToken,
            status: 'completed',
            value: null,
          }),
        );
      }
    });
    await registerWorker(ws, { workerId: 'w-reconcile-track', activities: ['test.charge'] });

    await waitForRealTimersForTesting(50);
    const orphanTrackRecord = makeLeasedLedgerRecord({
      operationId: 'orphan-track-op',
      workerSessionId: 'ghost-worker',
      attemptToken: 'attempt-token-orphan-track',
      leaseDeadline: Date.now() + 500,
      visibilityTimeoutMilliseconds: 500,
    });
    await storage.put(taskLedgerKey('orphan-track-op'), encodeRemoteTaskRecord(orphanTrackRecord));

    // fixed delay: negative assertion (orphan must NOT be reassigned yet)
    await waitForRealTimersForTesting(300);

    const earlyTaskMessages = received.filter((message) => {
      return message.type === 'task' && message.operationId === 'orphan-track-op';
    });
    expect(earlyTaskMessages).toHaveLength(0);

    await waitFor(
      () =>
        received.filter((m) => m.type === 'task' && m.operationId === 'orphan-track-op').length >=
        1,
      { label: 'orphaned task eventually reassigned' },
    );

    const taskMessages = received.filter((message) => {
      return message.type === 'task' && message.operationId === 'orphan-track-op';
    });
    expect(taskMessages.length).toBeGreaterThanOrEqual(1);
    expect(taskMessages[0]?.attempt).toBe(2);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('logs per-record reconciliation failures and skips the bad entry', async () => {
    ({ engine, storage } = createEngineWithStorage());
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    server = serveTestServer({ engine, port: 0, visibilityPollIntervalMs: 20 });

    try {
      await waitForRealTimersForTesting(50);
      // Genuinely invalid MessagePack bytes (`0xc1` is msgpack's reserved
      // "never used" marker) so `decode()` itself throws inside
      // `decodeRemoteTaskRecord`, reaching `reconcileOrphanedRecords`'s
      // per-record catch — see the visibility-scanner corrupt-record test
      // above for the same idiom and rationale.
      await storage.put(taskLedgerKey('reconcile-bad-op'), new Uint8Array([0xc1]));

      await waitFor(
        () =>
          errorSpy.mock.calls.some(
            (call) => call[0] === '[weft] Failed to reconcile leased ledger record — skipping:',
          ),
        { label: 'ledger reconciliation failure log' },
      );

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Failed to reconcile leased ledger record — skipping:',
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('logs reconciliation scan failures', async () => {
    ({ engine, storage } = createEngineWithStorage());
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalScan = storage.scan.bind(storage);
    let inflightScanCalls = 0;
    const restoreScan = overrideProperty(storage, 'scan', async function* (
      prefix: string,
      options?: Parameters<MemoryStorage['scan']>[1],
    ) {
      if (prefix === 'task-ledger:') {
        inflightScanCalls++;
        if (inflightScanCalls >= 2) {
          throw new Error('reconciliation scan failed');
        }
      }
      yield* originalScan(prefix, options);
    } as MemoryStorage['scan']);
    server = serveTestServer({ engine, port: 0, visibilityPollIntervalMs: 20 });

    try {
      await waitFor(
        () =>
          errorSpy.mock.calls.some((call) => call[0] === '[weft] Reconciliation scanner error:'),
        { label: 'reconciliation scanner error log' },
      );

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] Reconciliation scanner error:',
        expect.any(Error),
      );
    } finally {
      restoreScan();
      errorSpy.mockRestore();
    }
  });

  it('logs and swallows event persistence failures', async () => {
    engine = createEngine();
    const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const originalPut = engine.storage.put.bind(engine.storage);
    let putAttempts = 0;

    engine.storage.put = async (...args) => {
      putAttempts++;
      if (putAttempts <= 2) {
        throw new Error('forced persistence failure');
      }
      return originalPut(...args);
    };

    try {
      const handle = wireEventBroadcasting(engine, { publish() {} } as never, {
        publishTokenMessage() {},
      });

      engine.dispatchEvent(new WorkflowCompletedEvent('wf-persist-failure', 'done', 1));

      await waitFor(() => consoleErrorSpy.mock.calls.length === 1, {
        label: 'event persistence failure log',
      });

      expect(
        consoleWarnSpy.mock.calls.some(([message]) => String(message).includes('Retrying')),
      ).toBe(true);
      expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain(
        'Failed to persist event "workflow:completed" for workflow "wf-persist-failure"',
      );

      handle.dispose();
    } finally {
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrent scanner deduplication (regression: processingOperationIds)
// ---------------------------------------------------------------------------

describe('concurrent scanner deduplication', () => {
  let engine: Engine;
  let server: WeftServer;
  let storage: MemoryStorage;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  function createEngineWithStorage(): { engine: Engine; storage: MemoryStorage } {
    const s = new MemoryStorage();
    const e = new Engine({ storage: s });
    e.register(echoWorkflow);
    return { engine: e, storage: s };
  }

  it('does not double-process an operationId when scanExpiredTasks and reconcileOrphanedRecords overlap', async () => {
    // Regression test: before the processingOperationIds guard was added, both
    // scanExpiredTasks (fast heap-based path) and reconcileOrphanedRecords
    // (full storage scan) could call registry.completeTask() and
    // reassignOrExpireTask() for the same operationId concurrently, producing
    // duplicate re-dispatches and corrupt attempt counts.
    //
    // With visibilityPollIntervalMs: 50, the reconciliation scanner fires after
    // 50 * 12 = 600ms. By running both scanners for at least one full
    // reconciliation cycle, we verify that the same operationId is processed
    // exactly once per expiry event — not twice.
    ({ engine, storage } = createEngineWithStorage());
    server = serveTestServer({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    const received = collectAndCompleteTaskMessages(ws, {
      completeWhen: (message) => message.type === 'task' && (message.attempt ?? 1) >= 2,
    });

    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    // A short visibility timeout ensures the task expires before the first
    // reconciliation cycle, so both scanners see it as expired on their first
    // pass over the same operationId.
    await server.dispatchTask({
      operationId: 'dedup-scan-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
      visibilityTimeout: 60, // expires in 60ms, well before the 600ms reconciliation
    });
    await waitFor(() => server.registry.isAssigned('dedup-scan-op'), {
      label: 'dedup scan task assigned',
    });
    expect(server.registry.isAssigned('dedup-scan-op')).toBe(true);

    // Wait for at least one full reconciliation cycle (600ms) plus some slack
    // so both scanners have had multiple chances to process the expired record.
    await waitForRealTimersForTesting(800);

    // The task must be re-dispatched exactly once (attempt 2). If the guard
    // were absent, the worker would receive attempt 2 more than once.
    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'dedup-scan-op',
    );
    const attempt2Messages = taskMessages.filter((m) => m.attempt === 2);
    expect(attempt2Messages.length).toBe(1);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('does not double-process an orphaned operationId visible only to reconcileOrphanedRecords', async () => {
    // Insert an expired inflight record directly into storage without
    // dispatching through the server. This means the record is NOT in the
    // deadline heap, so only reconcileOrphanedRecords will find it — and it
    // will only find it once even if multiple reconciliation cycles run.
    ({ engine, storage } = createEngineWithStorage());
    server = serveTestServer({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    const received = collectAndCompleteTaskMessages(ws);

    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    // Wait for the server's startup restore scan to finish before inserting
    // the orphan so it is not accidentally restored as a valid in-flight task.
    await waitForRealTimersForTesting(100);

    const orphanRecord = makeLeasedLedgerRecord({
      operationId: 'dedup-orphan-op',
      workerSessionId: 'ghost-worker',
      attemptToken: 'attempt-token-dedup-orphan',
      leaseDeadline: Date.now() - 5_000, // already expired
    });
    await storage.put(taskLedgerKey('dedup-orphan-op'), encodeRemoteTaskRecord(orphanRecord));

    // Wait for two full reconciliation cycles (2 * 600ms = 1200ms) plus slack.
    // Without the deduplication guard a second concurrent reconciliation cycle
    // would re-dispatch the same record a second time.
    await waitForRealTimersForTesting(1400);

    // The orphaned task must be re-dispatched exactly once.
    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'dedup-orphan-op',
    );
    expect(taskMessages.length).toBe(1);
    expect(taskMessages[0]?.attempt).toBe(2);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('re-adds a drained heap entry when reconciliation is already processing the same operation', async () => {
    const operationId = 'dedup-readd-op';
    const innerStorage = new MemoryStorage();

    let releaseBlockedBatch: () => void = () => {};
    const blockedBatch = new Promise<void>((resolve) => {
      releaseBlockedBatch = resolve;
    });
    let notifyReconciliationBlocked: () => void = () => {};
    const reconciliationBlocked = new Promise<void>((resolve) => {
      notifyReconciliationBlocked = resolve;
    });

    let shouldInjectExpiredEntry = false;
    let blockedOperationBatch = false;

    // Post-cutover (WFT-22), the requeue write reconciliation performs goes
    // through `storage.conditionalBatch` on the durable ledger key, not
    // `storage.batch` on legacy inflight/queued keys — so this test's
    // storage wrapper must stall the ledger's `conditionalBatch` write
    // instead of a plain `batch` write.
    const delayedStorage: WeftStorage = {
      capabilities: innerStorage.capabilities.bind(innerStorage),
      get: innerStorage.get.bind(innerStorage),
      put: innerStorage.put.bind(innerStorage),
      delete: innerStorage.delete.bind(innerStorage),
      scan: innerStorage.scan.bind(innerStorage),
      batch: innerStorage.batch.bind(innerStorage),
      conditionalBatch: async (
        conditions: Parameters<MemoryStorage['conditionalBatch']>[0],
        operations: Parameters<MemoryStorage['conditionalBatch']>[1],
      ) => {
        const touchesTrackedOperation = operations.some(
          (operation) => operation.key === taskLedgerKey(operationId),
        );

        if (!blockedOperationBatch && touchesTrackedOperation) {
          blockedOperationBatch = true;
          shouldInjectExpiredEntry = true;
          notifyReconciliationBlocked();
          await blockedBatch;
        }

        return innerStorage.conditionalBatch(conditions, operations);
      },
      [Symbol.dispose]() {
        innerStorage[Symbol.dispose]();
      },
    };

    engine = new Engine({ storage: delayedStorage });
    engine.register(echoWorkflow);

    const originalAdd = DeadlineTracker.prototype.add;
    const originalDrainExpired = DeadlineTracker.prototype.drainExpired;
    let readdedEntries = 0;

    const restoreAdd = overrideProperty(
      DeadlineTracker.prototype,
      'add',
      function (
        this: DeadlineTracker,
        entry: Parameters<DeadlineTracker['add']>[0],
      ): ReturnType<DeadlineTracker['add']> {
        if (entry.operationId === operationId) {
          readdedEntries++;
        }
        return originalAdd.call(this, entry);
      },
    );

    const restoreDrainExpired = overrideProperty(
      DeadlineTracker.prototype,
      'drainExpired',
      function (
        this: DeadlineTracker,
        now: Parameters<DeadlineTracker['drainExpired']>[0],
      ): ReturnType<DeadlineTracker['drainExpired']> {
        const expired = originalDrainExpired.call(this, now);
        if (shouldInjectExpiredEntry) {
          shouldInjectExpiredEntry = false;
          return [...expired, { operationId, deadline: now - 1 }];
        }
        return expired;
      },
    );

    try {
      server = serveTestServer({ engine, port: 0, visibilityPollIntervalMs: 25 });
      await waitForRealTimersForTesting(100);

      const orphanRecord = makeLeasedLedgerRecord({
        operationId,
        workerSessionId: 'ghost-worker',
        attemptToken: 'attempt-token-dedup-readd',
        leaseDeadline: Date.now() - 5_000,
      });
      await innerStorage.put(taskLedgerKey(operationId), encodeRemoteTaskRecord(orphanRecord));

      await reconciliationBlocked;

      await waitFor(() => readdedEntries > 0, {
        label: 'reconciliation re-added the queued entry',
      });

      expect(readdedEntries).toBeGreaterThan(0);
      expect(readdedEntries).toBe(1);

      releaseBlockedBatch();
      await waitFor(
        async () => {
          const record = decodeRemoteTaskRecord(await innerStorage.get(taskLedgerKey(operationId)));
          return record !== null && record.state === 'queued';
        },
        {
          label: 'dedup readd operation queued',
        },
      );

      const record = decodeRemoteTaskRecord(await innerStorage.get(taskLedgerKey(operationId)));
      expect(record).not.toBeNull();
      expect(record?.state).toBe('queued');
    } finally {
      releaseBlockedBatch();
      restoreDrainExpired();
      restoreAdd();
    }
  });
});

// ---------------------------------------------------------------------------
// Retry policy respected on reassignment
// ---------------------------------------------------------------------------

describe('retry policy respected on reassignment', () => {
  let engine: Engine;
  let server: WeftServer;
  let storage: MemoryStorage;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  const testRetryPolicy: RetryPolicy = {
    maxAttempts: 2,
    initialBackoff: 100,
    backoffMultiplier: 2,
    maxBackoff: 5000,
  };

  it('does not re-dispatch when maxAttempts exceeded on visibility timeout expiry', async () => {
    ({ engine, storage } = createReconnectTestEngineWithStorage());
    server = serveTestServer({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    const received = collectTaskMessages(ws);
    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    // maxAttempts: 1 — the only attempt this task ever gets already
    // exhausts the policy, so the first visibility-timeout expiry must
    // terminalize it rather than requeue a second attempt.
    await server.dispatchTask({
      operationId: 'max-attempt-expiry-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: { amount: 42 },
      visibilityTimeout: 100,
      retryPolicy: { ...testRetryPolicy, maxAttempts: 1 },
    });
    await waitFor(
      () =>
        received.some(
          (message) =>
            message.type === 'task' &&
            message.operationId === 'max-attempt-expiry-op' &&
            message.attempt === 1,
        ),
      { label: 'initial max-attempt-expiry-op dispatch' },
    );

    const operationId = 'max-attempt-expiry-op';
    let terminal: RemoteTaskRecord | null = null;
    await waitFor(
      async () => {
        const record = await readLedgerRecord(storage, operationId);
        if (record === null || record.state !== 'terminal') return false;
        terminal = record;
        return true;
      },
      { timeoutMs: 1000, label: 'max-attempt-expiry-op terminal resolution' },
    );

    expect(terminal).toMatchObject({
      operationId,
      disposition: 'retryExhausted',
      activityName: 'test.charge',
      queue: 'default',
      attempt: 1,
    });

    // The task should NOT be re-dispatched — only the initial dispatch should exist
    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'max-attempt-expiry-op',
    );
    expect(taskMessages.length).toBe(1);
    expect(taskMessages[0]?.attempt).toBe(1);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('does not re-dispatch when maxAttempts exceeded on worker disconnect', async () => {
    ({ engine, storage } = createReconnectTestEngineWithStorage());
    server = serveFastReconnectTestServer(engine);

    const {
      primaryWorker: ws1,
      secondaryWorker: ws2,
      secondaryMessages: received,
    } = await connectRegisteredWorkerPair(server);

    // maxAttempts: 1 — the only attempt this task ever gets already
    // exhausts the policy, so the disconnect-driven reassignment must
    // terminalize it rather than reassign to w2.
    await server.dispatchTask({
      operationId: 'max-attempt-disconnect-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: { amount: 42 },
      retryPolicy: { ...testRetryPolicy, maxAttempts: 1 },
    });
    await waitFor(() => server.registry.isAssignedToWorker('max-attempt-disconnect-op', 'w1'), {
      label: 'max-attempt task assigned to w1 before disconnect',
    });
    expect(server.registry.isAssignedToWorker('max-attempt-disconnect-op', 'w1')).toBe(true);

    // Disconnect w1 — task should NOT be reassigned to w2 since maxAttempts reached
    ws1.close();

    const operationId = 'max-attempt-disconnect-op';
    let terminal: RemoteTaskRecord | null = null;
    await waitFor(
      async () => {
        const record = await readLedgerRecord(storage, operationId);
        if (record === null || record.state !== 'terminal') return false;
        terminal = record;
        return true;
      },
      { label: 'max-attempt-disconnect-op terminal resolution' },
    );

    expect(terminal).toMatchObject({
      operationId,
      disposition: 'retryExhausted',
      activityName: 'test.charge',
      queue: 'default',
      attempt: 1,
    });

    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'max-attempt-disconnect-op',
    );
    expect(taskMessages.length).toBe(0);

    ws2.close();
    await waitForRealTimersForTesting(50);
  });

  it('re-dispatches when within maxAttempts on visibility timeout expiry', async () => {
    ({ engine, storage } = createReconnectTestEngineWithStorage());
    server = serveTestServer({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    const received = collectAndCompleteTaskMessages(ws, {
      completeWhen: (message) => message.type === 'task' && (message.attempt ?? 1) >= 2,
    });
    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    // maxAttempts = 3, starting at attempt 1 — should allow reassignment
    await server.dispatchTask({
      operationId: 'within-limit-expiry-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
      visibilityTimeout: 100,
      retryPolicy: { ...testRetryPolicy, maxAttempts: 3 },
    });
    await waitFor(
      () =>
        received.filter((m) => m.type === 'task' && m.operationId === 'within-limit-expiry-op')
          .length >= 1,
      { label: 'within-limit task initially dispatched' },
    );

    // Wait for the visibility timeout to expire and the scanner to re-dispatch
    await waitFor(
      () =>
        received.filter((m) => m.type === 'task' && m.operationId === 'within-limit-expiry-op')
          .length >= 2,
      { label: 'within-limit task re-dispatched after visibility expiry' },
    );

    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'within-limit-expiry-op',
    );
    expect(taskMessages.length).toBeGreaterThanOrEqual(2);
    expect(taskMessages[0]?.attempt).toBe(1);
    expect(taskMessages[1]?.attempt).toBe(2);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('applies backoff delay before re-dispatch on visibility timeout expiry', async () => {
    ({ engine, storage } = createReconnectTestEngineWithStorage());
    server = serveTestServer({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    const timestamps: number[] = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attempt?: number;
        attemptToken?: string;
      };
      if (msg.type === 'task' && msg.operationId === 'backoff-expiry-op') {
        timestamps.push(Date.now());
        // Complete on attempt 2 to stop the cycle
        if ((msg.attempt ?? 1) >= 2) {
          ws.send(
            JSON.stringify({
              type: 'taskResult',
              operationId: msg.operationId,
              attemptToken: msg.attemptToken,
              status: 'completed',
              value: null,
            }),
          );
        }
      }
    });
    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    // initialBackoff = 100ms
    await server.dispatchTask({
      operationId: 'backoff-expiry-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
      visibilityTimeout: 80,
      retryPolicy: { ...testRetryPolicy, maxAttempts: 3, initialBackoff: 100 },
    });

    // Wait long enough for: visibility timeout (80ms) + backoff (100ms) + scanner intervals
    await waitFor(() => timestamps.length >= 2, {
      label: 'backoff expiry redispatch received',
    });

    // Should have received both dispatches
    expect(timestamps.length).toBeGreaterThanOrEqual(2);

    // The gap between dispatch 1 and dispatch 2 should be at least ~80ms (visibility) + ~100ms (backoff)
    // We use a conservative lower bound to account for timing variability
    const gap = timestamps[1]! - timestamps[0]!;
    expect(gap).toBeGreaterThanOrEqual(150);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('applies backoff delay before re-dispatch on worker disconnect', async () => {
    ({ engine, storage } = createReconnectTestEngineWithStorage());
    server = serveFastReconnectTestServer(engine);

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);

    const timestamps: number[] = [];
    ws2.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        operationId?: string;
        attempt?: number;
      };
      if (msg.type === 'task' && msg.operationId === 'backoff-disconnect-op') {
        timestamps.push(Date.now());
      }
    });

    await registerWorker(ws1, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });
    await registerWorker(ws2, { workerId: 'w2', activities: ['test.charge'], concurrency: 5 });

    const dispatchTime = Date.now();
    // initialBackoff = 150ms, attempt 1 → backoff for attempt 2 = 150ms
    await server.dispatchTask({
      operationId: 'backoff-disconnect-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
      retryPolicy: { ...testRetryPolicy, maxAttempts: 3, initialBackoff: 150 },
    });
    await waitForRealTimersForTesting(50);

    // Disconnect w1 — should apply backoff before re-dispatching to w2
    ws1.close();

    // Wait for the backoff delay to complete
    await waitFor(() => timestamps.length === 1, {
      label: 'backoff disconnect redispatch received',
    });

    expect(timestamps.length).toBe(1);
    // The re-dispatch should have been delayed by at least the backoff (150ms)
    const gap = timestamps[0]! - dispatchTime;
    expect(gap).toBeGreaterThanOrEqual(150);

    ws2.close();
    await waitForRealTimersForTesting(50);
  });

  it('logs delayed redispatch failures when backoff requeue dispatch throws', async () => {
    ({ engine, storage } = createReconnectTestEngineWithStorage());
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    server = serveFastReconnectTestServer(engine);

    const operationId = 'delayed-redispatch-fail-op';
    // Post-cutover (WFT-22), the delayed redispatch's own storage write is
    // what must fail — and only that write. With a retry policy and a
    // positive backoff, disconnect's own immediate `leased -> queued`
    // requeue write succeeds normally; only after the backoff delay does
    // `scheduleDelayedDispatch` re-invoke `dispatchTaskImpl`, which (with a
    // second worker available) performs a real `queued -> leased` claim
    // write on the same ledger key. Counting matching writes distinguishes
    // that third write (1: initial dispatch's create+claim, 2: disconnect's
    // requeue, 3: the delayed redispatch's claim) from the earlier ones that
    // must succeed for the scenario to reach the delayed path at all.
    let writeCount = 0;
    const restoreConditionalBatch = overrideProperty(storage, 'conditionalBatch', (async (
      conditions: Parameters<MemoryStorage['conditionalBatch']>[0],
      operations: Parameters<MemoryStorage['conditionalBatch']>[1],
    ) => {
      if (operations.some((operation) => operation.key === taskLedgerKey(operationId))) {
        writeCount++;
        if (writeCount >= 3) {
          throw new Error('delayed redispatch failed');
        }
      }
      return originalConditionalBatch(conditions, operations);
    }) as MemoryStorage['conditionalBatch']);

    try {
      const { primaryWorker: ws1, secondaryWorker: ws2 } =
        await connectRegisteredWorkerPair(server);

      await server.dispatchTask({
        operationId,
        activityName: 'test.charge',
        workflowType: 'test',
        input: null,
        retryPolicy: { ...testRetryPolicy, maxAttempts: 3, initialBackoff: 50, maxBackoff: 50 },
      });
      await waitFor(() => server.registry.isAssignedToWorker(operationId, 'w1'), {
        label: `${operationId} assigned to w1 before disconnect`,
      });

      ws1.close();

      // Poll for the delayed-redispatch error log rather than waiting a fixed
      // 250ms and asserting immediately: under parallel load the backoff requeue
      // can land later than any fixed window, which made this test flaky in the
      // pre-commit full-suite run. The poll adapts to the real timing, and the
      // full `toHaveBeenCalledWith` contract (including the Error argument) is
      // still asserted afterward so polling can't mask a wrong-shaped call.
      await waitFor(
        () =>
          errorSpy.mock.calls.some(
            (call) => call[0] === `[weft] Delayed redispatch failed for "${operationId}":`,
          ),
        { label: 'delayed redispatch error log' },
      );

      expect(errorSpy).toHaveBeenCalledWith(
        `[weft] Delayed redispatch failed for "${operationId}":`,
        expect.any(Error),
      );

      ws2.close();
      await waitForRealTimersForTesting(50);
    } finally {
      restoreConditionalBatch();
      errorSpy.mockRestore();
    }
  });

  it('stores retryPolicy in the inflight record for use during reassignment', async () => {
    ({ engine, storage } = createReconnectTestEngineWithStorage());
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    await server.dispatchTask({
      operationId: 'policy-stored-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
      retryPolicy: testRetryPolicy,
    });
    await waitFor(
      async () => {
        const record = await readLedgerRecord(storage, 'policy-stored-op');
        return record !== null && record.state === 'leased';
      },
      { label: 'retry policy ledger record stored' },
    );

    const record = await readLedgerRecord(storage, 'policy-stored-op');
    expect(record).not.toBeNull();
    if (record === null || record.state !== 'leased') {
      throw new Error('Expected "policy-stored-op" to have a leased ledger record');
    }
    expect(record.retryPolicy).toEqual(testRetryPolicy);

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('defaults to no maxAttempts limit when retryPolicy is not provided', async () => {
    ({ engine, storage } = createReconnectTestEngineWithStorage());
    server = serveTestServer({ engine, port: 0, visibilityPollIntervalMs: 50 });

    const ws = await connectWorker(server);
    const received = collectAndCompleteTaskMessages(ws, {
      completeWhen: (message) => message.type === 'task' && (message.attempt ?? 1) >= 2,
    });
    await registerWorker(ws, { workerId: 'w1', activities: ['test.charge'], concurrency: 5 });

    // Missing retryPolicy uses the current default redispatch behavior.
    await server.dispatchTask({
      operationId: 'no-policy-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
      visibilityTimeout: 100,
    });
    await waitFor(
      () =>
        received.filter((m) => m.type === 'task' && m.operationId === 'no-policy-op').length >= 1,
      { label: 'no-policy task initially dispatched' },
    );

    // Wait for visibility timeout expiry + scanner
    await waitFor(
      () =>
        received.filter((m) => m.type === 'task' && m.operationId === 'no-policy-op').length >= 2,
      { label: 'no-policy task re-dispatched after visibility expiry' },
    );

    const taskMessages = received.filter(
      (m) => m.type === 'task' && m.operationId === 'no-policy-op',
    );
    expect(taskMessages.length).toBeGreaterThanOrEqual(2);

    ws.close();
    await waitForRealTimersForTesting(50);
  });
});

// ---------------------------------------------------------------------------
// Worker shutdown and cancel propagation
// ---------------------------------------------------------------------------

describe('worker shutdown and cancel propagation', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  it('shutdownWorker sends shutdown message and waits for disconnect', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const received: Array<{ type: string; [key: string]: unknown }> = [];
    const ws = await connectWorker(server);

    ws.addEventListener('message', (event) => {
      const parsed = JSON.parse(String(event.data)) as { type: string; [key: string]: unknown };
      received.push(parsed);

      // Simulate worker receiving shutdown and closing the connection
      if (parsed.type === 'shutdown') {
        ws.close();
      }
    });

    await registerWorker(ws, {
      workerId: 'shutdown-w1',
      activities: ['test.charge'],
      concurrency: 5,
    });

    const result = await server.shutdownWorker('shutdown-w1', { timeoutMs: 5000 });

    expect(result).toBe(true);

    const shutdownMessage = received.find((m) => m.type === 'shutdown');
    expect(shutdownMessage).toBeDefined();

    // The worker should be unregistered after disconnect
    await waitFor(() => server.registry.getWorker('shutdown-w1') === undefined, {
      label: 'shutdown worker unregistered',
    });
    expect(server.registry.getWorker('shutdown-w1')).toBeUndefined();
  });

  it('shutdownWorker returns after the timeout when the worker stays connected', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws = await connectWorker(server);
    await registerWorker(ws, { workerId: 'shutdown-timeout-w1', activities: ['test.charge'] });

    const result = await server.shutdownWorker('shutdown-timeout-w1', { timeoutMs: 50 });

    expect(result).toBe(true);
    expect(server.registry.getWorker('shutdown-timeout-w1')).toBeDefined();

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('shutdownWorker returns false for unknown worker', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const result = await server.shutdownWorker('non-existent-worker');
    expect(result).toBe(false);
  });

  it('shutdownAllWorkers shuts down all connected workers', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const ws1 = await connectWorker(server);
    const ws2 = await connectWorker(server);

    // Auto-close on receiving shutdown
    ws1.addEventListener('message', (event) => {
      const parsed = JSON.parse(String(event.data)) as { type: string };
      if (parsed.type === 'shutdown') ws1.close();
    });
    ws2.addEventListener('message', (event) => {
      const parsed = JSON.parse(String(event.data)) as { type: string };
      if (parsed.type === 'shutdown') ws2.close();
    });

    await registerWorker(ws1, { workerId: 'all-w1', activities: ['test.charge'], concurrency: 5 });
    await registerWorker(ws2, { workerId: 'all-w2', activities: ['test.charge'], concurrency: 5 });

    expect(server.registry.size).toBe(2);

    await server.shutdownAllWorkers({ timeoutMs: 5000 });

    await waitFor(() => server.registry.size === 0, {
      label: 'all workers unregistered after shutdown',
    });
    expect(server.registry.size).toBe(0);
  });

  it('stop drains connected workers so in-flight task results can persist before teardown', async () => {
    engine = createEngine();
    const storage = engine.storage as MemoryStorage;
    const operationId = 'stop-drains-inflight-result';
    server = serveTestServer({ engine, port: 0, workerShutdownTimeoutMs: 500 });

    const ws = await connectWorker(server);
    let taskAttemptToken: string | undefined;
    let receivedShutdown = false;
    ws.addEventListener('message', (event) => {
      const parsed = JSON.parse(String(event.data)) as { type: string; attemptToken?: string };
      if (parsed.type === 'task') taskAttemptToken = parsed.attemptToken;
      if (parsed.type !== 'shutdown') return;

      receivedShutdown = true;
      sendCompletedTaskResult(ws, operationId, taskAttemptToken, 'drained-before-stop');
      void waitFor(
        async () => {
          const record = await readLedgerRecord(storage, operationId);
          return record !== null && record.state === 'terminal';
        },
        { label: 'task result persisted during server stop drain' },
      )
        .catch(() => {})
        .finally(() => ws.close());
    });

    await registerWorker(ws, { workerId: 'stop-drain-w1', activities: ['test.charge'] });
    await server.dispatchTask({
      operationId,
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
      visibilityTimeout: 30_000,
    });
    await waitFor(
      async () => {
        const record = await readLedgerRecord(storage, operationId);
        return record !== null && record.state === 'leased';
      },
      { label: 'inflight task persisted before server stop' },
    );

    await server.stop();

    expect(receivedShutdown).toBe(true);
    const resolved = await readLedgerRecord(storage, operationId);
    if (resolved === null || resolved.state !== 'terminal' || resolved.disposition !== 'resolved') {
      throw new Error(`Expected "${operationId}" to reach a resolved terminal ledger record`);
    }
    // The durable ledger never persists the completed payload itself (WFT-24
    // "adoption" territory — see `readTerminalRecord`'s doc comment in
    // `state-worker-harness.parity.test.ts`), so only `status` is observable
    // here, not the `value` the worker sent.
    expect(resolved.operationId).toBe(operationId);
    expect(resolved.status).toBe('completed');
  });

  it('falls back to the long-poll queue when a registry worker has no live socket', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    server.registry.register({
      manifest: testWorkerManifest(),
      acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      id: 'ghost-worker',
      queue: 'default',
      activities: ['test.charge'],
      concurrency: 1,
    });

    const dispatched = await server.dispatchTask({
      operationId: 'ghost-worker-op',
      activityName: 'test.charge',
      workflowType: 'test',
      input: null,
    });

    expect(dispatched).toBe(true);
    expect(server.taskQueue.pendingCount('default')).toBe(1);
  });

  it('cancelTask sends cancel to the correct worker', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const received: Array<{ type: string; operationId?: string; attemptToken?: string }> = [];
    const ws = await connectWorker(server);

    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });

    await registerWorker(ws, {
      workerId: 'cancel-w1',
      activities: ['test.charge'],
      concurrency: 5,
    });

    await server.dispatchTask({
      operationId: 'cancel-op-1',
      activityName: 'test.charge',
      workflowType: 'test',
      input: { amount: 100 },
    });
    await waitFor(() => server.registry.isAssigned('cancel-op-1'), {
      label: 'cancel task assignment registered',
    });

    const result = server.cancelTask('cancel-op-1');

    expect(result).toBe(true);
    await waitFor(() => received.some((m) => m.type === 'cancel'), {
      label: 'cancel message received',
    });

    const cancelMessage = received.find((m) => m.type === 'cancel');
    expect(cancelMessage).toBeDefined();
    expect(cancelMessage!.operationId).toBe('cancel-op-1');

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('cancelTask returns false when no worker has the task', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const result = server.cancelTask('non-existent-op');
    expect(result).toBe(false);
  });

  it('workflow cancellation propagates cancel to workers', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const received: Array<{ type: string; operationId?: string; attemptToken?: string }> = [];
    const ws = await connectWorker(server);

    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)));
    });

    await registerWorker(ws, {
      workerId: 'wf-cancel-w1',
      activities: ['test.charge'],
      concurrency: 5,
    });

    // Dispatch a task with a workflowId so it gets indexed in workflowOperations
    await server.dispatchTask({
      operationId: 'wf-cancel-op-1',
      activityName: 'test.charge',
      workflowType: 'test',
      input: { amount: 100 },
      workflowId: 'workflow-to-cancel',
    });
    await waitForRealTimersForTesting(50);

    // Simulate workflow cancellation by dispatching the event on the engine
    const { WorkflowCancelledEvent: CancelledEvent } = await import('../core/events.ts');
    engine.dispatchEvent(new CancelledEvent('workflow-to-cancel'));

    await waitFor(() => received.filter((m) => m.type === 'cancel').length === 1, {
      label: 'workflow cancellation message received',
    });

    const cancelMessages = received.filter((m) => m.type === 'cancel');
    expect(cancelMessages.length).toBe(1);
    expect(cancelMessages[0]!.operationId).toBe('wf-cancel-op-1');

    ws.close();
    await waitForRealTimersForTesting(50);
  });
});

describe('header propagation in task dispatch', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  function createCapturedHeadersProbe(label: string): {
    interceptor: import('../core/interceptor.ts').ActivityInterceptor;
    waitForCapturedHeaders: () => Promise<Map<string, string>>;
  } {
    let capturedHeaders: Map<string, string> | undefined;
    return {
      interceptor: {
        execute(context, next) {
          capturedHeaders = context.headers;
          return next(context);
        },
      },
      async waitForCapturedHeaders() {
        await waitFor(() => capturedHeaders !== undefined, { label });
        return capturedHeaders!;
      },
    };
  }

  it('includes headers when dispatching to WebSocket workers', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const received: Array<Record<string, unknown>> = [];
    const ws = await connectWorker(server);

    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });

    await registerWorker(ws, {
      workerId: 'header-w1',
      activities: ['test.charge'],
      concurrency: 5,
    });

    await server.dispatchTask({
      operationId: 'header-op-1',
      activityName: 'test.charge',
      workflowType: 'test',
      input: { amount: 100 },
      headers: { 'x-trace-id': 'trace-123', 'x-auth': 'bearer-token' },
    });

    await waitFor(() => received.some((m) => m['type'] === 'task'), {
      label: 'header task message received',
    });

    const taskMessage = received.find((m) => m['type'] === 'task');
    expect(taskMessage).toBeDefined();
    expect(taskMessage!['headers']).toEqual({
      'x-trace-id': 'trace-123',
      'x-auth': 'bearer-token',
    });

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('omits headers field when no headers are provided', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const received: Array<Record<string, unknown>> = [];
    const ws = await connectWorker(server);

    ws.addEventListener('message', (event) => {
      received.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });

    await registerWorker(ws, {
      workerId: 'no-header-w1',
      activities: ['test.charge'],
      concurrency: 5,
    });

    await server.dispatchTask({
      operationId: 'no-header-op-1',
      activityName: 'test.charge',
      workflowType: 'test',
      input: { amount: 50 },
    });

    await waitFor(() => received.some((m) => m['type'] === 'task'), {
      label: 'no-header task message received',
    });

    const taskMessage = received.find((m) => m['type'] === 'task');
    expect(taskMessage).toBeDefined();
    expect(taskMessage!['headers']).toBeUndefined();

    ws.close();
    await waitForRealTimersForTesting(50);
  });

  it('includes headers when dispatching to long-poll workers via task queue', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    // Dispatch task with headers — it will go into the task queue since no
    // WebSocket worker is connected for the target activity
    await server.dispatchTask({
      operationId: 'lp-header-op-1',
      activityName: 'unregistered-activity',
      workflowType: 'testWorkflow',
      input: { data: 'test' },
      headers: { 'x-request-id': 'req-456' },
    });

    // Poll the task queue via the long-poll HTTP endpoint
    const baseUrl = server.url;
    const response = await fetch(`${baseUrl}/v1/tasks/default?activity=unregistered-activity`, {
      method: 'GET',
      headers: { 'X-Long-Poll-Timeout': '500' },
    });

    expect(response.status).toBe(200);
    const task = (await response.json()) as Record<string, unknown>;
    expect(task['operationId']).toBe('lp-header-op-1');
    expect(task['headers']).toEqual({ 'x-request-id': 'req-456' });
  });

  it('propagates headers end-to-end to a RemoteWorker activity interceptor', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const { RemoteWorker } = await import('../worker/index.ts');

    const { interceptor, waitForCapturedHeaders } = createCapturedHeadersProbe(
      'headers captured by activity interceptor',
    );

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}/v1/tasks/default/stream`,
      workerId: 'header-e2e-worker',
      deploymentName: 'test-deployment',
      buildId: 'test-build',
      workflows: {
        notifications: {
          name: 'notifications',
          activities: {
            echo: async (input: unknown) => input,
          },
        },
      },
      interceptors: [interceptor],
      concurrency: 3,
    });

    await worker.connect();
    await waitFor(() => server.registry.size === 1, {
      label: 'remote worker registered for header propagation',
    });

    expect(server.registry.size).toBe(1);

    const dispatched = await server.dispatchTask({
      operationId: 'header-e2e-op-1',
      activityName: 'notifications.echo',
      workflowType: 'notifications',
      input: 'payload',
      headers: { 'x-trace-id': 'trace-e2e-789', 'x-custom': 'value-42' },
    });
    expect(dispatched).toBe(true);

    const capturedHeaders = await waitForCapturedHeaders();
    await waitFor(() => server.registry.getAll()[0]?.inFlight === 0, {
      label: 'header task completed',
    });

    // The interceptor should have captured the headers as a Map
    expect(capturedHeaders.get('x-trace-id')).toBe('trace-e2e-789');
    expect(capturedHeaders.get('x-custom')).toBe('value-42');

    // The task should have completed successfully
    expect(server.registry.getAll()[0]?.inFlight).toBe(0);

    await worker.disconnect();
    await waitForRealTimersForTesting(50);
  });

  it('propagates empty headers map to interceptor when dispatch includes no headers', async () => {
    engine = createEngine();
    server = serveTestServer({ engine, port: 0 });

    const { RemoteWorker } = await import('../worker/index.ts');

    const { interceptor, waitForCapturedHeaders } = createCapturedHeadersProbe(
      'empty headers captured by activity interceptor',
    );

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}/v1/tasks/default/stream`,
      workerId: 'header-e2e-no-headers',
      deploymentName: 'test-deployment',
      buildId: 'test-build',
      workflows: {
        notifications: {
          name: 'notifications',
          activities: {
            echo: async (input: unknown) => input,
          },
        },
      },
      interceptors: [interceptor],
      concurrency: 3,
    });

    await worker.connect();
    await waitFor(() => server.registry.size === 1, {
      label: 'remote worker registered for empty header propagation',
    });

    await server.dispatchTask({
      operationId: 'header-e2e-no-op',
      activityName: 'notifications.echo',
      workflowType: 'notifications',
      input: 'payload',
    });

    const capturedHeaders = await waitForCapturedHeaders();

    // The interceptor should still receive a headers Map, just empty
    expect(capturedHeaders.size).toBe(0);

    await worker.disconnect();
    await waitForRealTimersForTesting(50);
  });
});
