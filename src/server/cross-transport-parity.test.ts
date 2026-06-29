import { afterEach, describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';

import { Engine } from '../core/engine.ts';
import type {
  BulkCancelResult,
  BulkDeleteResult,
  BulkOperationCommitOptions,
  BulkOperationDryRunOptions,
  BulkOperationDryRunResult,
  BulkOperationOptions,
  BulkRetryFailedResult,
  BulkSignalResult,
  BulkTagResult,
  ListFilter,
  WorkflowContext,
} from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { createEngineEventFeedBackend } from './engine-event-feed-backend.ts';
import { serve, type WeftServer } from './index.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';
import { runStdioSession } from './stdio-session.ts';
import {
  assertIdenticalFaultCode,
  assertIdenticalJson,
  assertShapeEquivalent,
  type ParityInvariants,
} from './operation-catalog-parity-invariants.test-support.ts';
import { createWorkflowEventFeed } from './workflow-event-feed.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});
const holdWorkflow = workflow({ name: 'hold' }).execute(async function* (ctx: WorkflowContext) {
  return yield* ctx.waitForSignal('release');
});

type WorkflowTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'timed-out';
type WorkflowStatus = 'running' | WorkflowTerminalStatus;
type TransportName = 'rest' | 'json-rpc-http' | 'json-rpc-websocket' | 'json-rpc-stdio';
type JsonRpcErrorEnvelope = { code?: number; data?: Record<string, unknown> };
type JsonRpcResponseEnvelope = { error?: JsonRpcErrorEnvelope; result?: unknown };
type BulkTransportOutcome = {
  authorizationOutcome: string;
  callCount: number;
  result: unknown;
  staleFaultCode: string;
};
type BulkPreviewStaleCommitOutcome = {
  authorizationOutcome: string;
  result: unknown;
  staleFaultCode: string;
};

const registry = createLiveOperationRegistry();
const BULK_TEST_API_KEY = 'weft_test_bulk_workflows_admin_scope_key_xxx';
const bulkServeOptions = {
  port: 0,
  auth: {
    apiKeys: [BULK_TEST_API_KEY],
    defaultApiKeyScopes: ['workflows:admin'] as const,
  },
};

function bulkJsonHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${BULK_TEST_API_KEY}`,
  };
}

function createHoldEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(echoWorkflow);
  engine.register(holdWorkflow);
  return engine;
}

async function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: WorkflowStatus,
  timeoutMilliseconds = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const state = await engine.get(workflowId);
    if (state?.status === status) return;
    await sleepForTesting(10);
  }

  throw new Error(`workflow ${workflowId} did not reach ${status} in time`);
}

async function postJsonRpc(
  server: WeftServer,
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): Promise<unknown> {
  const body = await postJsonRpcEnvelope(server, method, params, headers);
  expect(body.error).toBeUndefined();
  return body.result;
}

async function postJsonRpcEnvelope(
  server: WeftServer,
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): Promise<JsonRpcResponseEnvelope> {
  const response = await fetch(`${server.url}/jsonrpc`, {
    method: 'POST',
    headers: { ...headers, 'content-type': headers['content-type'] ?? 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method,
      params,
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as JsonRpcResponseEnvelope;
}

async function postJsonRpcExpectError(
  server: WeftServer,
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): Promise<{ code: number; data?: Record<string, unknown> }> {
  const body = await postJsonRpcEnvelope(server, method, params, headers);
  expect(body.error).toBeDefined();
  expect(typeof body.error?.code).toBe('number');
  return {
    code: body.error!.code!,
    ...(body.error?.data === undefined ? {} : { data: body.error.data }),
  };
}

function waitForMessage(
  webSocket: WebSocket,
  predicate: (parsed: unknown) => boolean,
  timeoutMilliseconds = 3_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      webSocket.removeEventListener('message', handler);
      reject(new Error('waitForMessage timed out'));
    }, timeoutMilliseconds);

    function handler(event: MessageEvent): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (predicate(parsed)) {
        clearTimeout(timer);
        webSocket.removeEventListener('message', handler);
        resolve(parsed);
      }
    }

    webSocket.addEventListener('message', handler);
  });
}

function openWebSocket(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const webSocket =
      headers === undefined ? new WebSocket(url) : new WebSocket(url, { headers } as any);
    webSocket.addEventListener('open', () => resolve(webSocket));
    webSocket.addEventListener('error', (event) => reject(event));
  });
}

function readableFromLines(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
}

function collectingWritable(): {
  stream: WritableStream<Uint8Array>;
  lines(): string[];
} {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const complete: string[] = [];

  return {
    stream: new WritableStream<Uint8Array>({
      write(chunk) {
        buffer += decoder.decode(chunk, { stream: true });
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          complete.push(buffer.slice(0, newlineIndex));
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf('\n');
        }
      },
      close() {
        if (buffer.length > 0) {
          complete.push(buffer);
        }
      },
    }),
    lines() {
      return [...complete];
    },
  };
}

async function invokeStdioJsonRpc(
  engine: Engine,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const response = await invokeStdioJsonRpcEnvelope(engine, method, params);
  expect(response.error).toBeUndefined();
  return response.result;
}

async function invokeStdioJsonRpcEnvelope(
  engine: Engine,
  method: string,
  params: Record<string, unknown>,
): Promise<JsonRpcResponseEnvelope> {
  const feed = createWorkflowEventFeed(createEngineEventFeedBackend(engine));
  const output = collectingWritable();
  try {
    const result = await runStdioSession({
      input: readableFromLines([
        JSON.stringify({
          jsonrpc: '2.0',
          id: crypto.randomUUID(),
          method,
          params,
        }) + '\n',
      ]),
      output: output.stream,
      admission: { kind: 'allow-unauthenticated-local-admin' },
      registry,
      engine,
      feed,
    });

    expect(result.exitCode).toBe(0);
    const [firstLine] = output.lines();
    expect(firstLine).toBeDefined();
    return JSON.parse(firstLine!) as JsonRpcResponseEnvelope;
  } finally {
    feed.dispose();
  }
}

async function invokeStdioJsonRpcExpectError(
  engine: Engine,
  method: string,
  params: Record<string, unknown>,
): Promise<{ code: number; data?: Record<string, unknown> }> {
  const response = await invokeStdioJsonRpcEnvelope(engine, method, params);
  expect(response.error).toBeDefined();
  expect(typeof response.error?.code).toBe('number');
  return {
    code: response.error!.code!,
    ...(response.error?.data !== undefined ? { data: response.error.data } : {}),
  };
}

function assertSuccessParity(
  results: Record<TransportName, unknown>,
  invariants: ParityInvariants,
  label: string,
): void {
  const baselineTransport: TransportName = 'rest';
  const baseline = results[baselineTransport];

  for (const [transport, result] of Object.entries(results) as Array<[TransportName, unknown]>) {
    if (transport === baselineTransport) continue;

    if (invariants.successPayload === 'identical-json') {
      assertIdenticalJson(baseline, result, `${label}: ${baselineTransport} vs ${transport}`);
    } else {
      assertShapeEquivalent(baseline, result, `${label}: ${baselineTransport} vs ${transport}`);
    }
  }
}

function assertBulkOperationInvariants(
  results: Record<TransportName, BulkTransportOutcome>,
  invariants: ParityInvariants,
  label: string,
  expectedCallCount: number,
): void {
  const baselineTransport: TransportName = 'rest';
  const baseline = results[baselineTransport];

  for (const [transport, result] of Object.entries(results) as Array<
    [TransportName, BulkTransportOutcome]
  >) {
    if (transport === baselineTransport) continue;

    if (invariants.errorMapping === 'one-to-one') {
      assertIdenticalFaultCode(
        baseline.staleFaultCode,
        result.staleFaultCode,
        `${label} stale confirmation: ${baselineTransport} vs ${transport}`,
      );
    }

    if (invariants.authBehavior === 'identical') {
      expect(result.authorizationOutcome).toBe(baseline.authorizationOutcome);
    }
  }

  if (invariants.sideEffects === 'invoked-once-per-call') {
    for (const result of Object.values(results)) {
      expect(result.callCount).toBe(expectedCallCount);
    }
  }
}

function bulkRestFaultCodeFromStatus(status: number): string {
  if (status === 400) return 'InvalidParams';
  if (status === 401) return 'Unauthorized';
  if (status === 403) return 'Forbidden';
  if (status === 422) return 'Unprocessable';
  return `HTTP ${status.toString()}`;
}

function authorizationOutcomeFromRestStatus(status: number): string {
  if (status >= 200 && status < 300) return 'allowed';
  return bulkRestFaultCodeFromStatus(status);
}

function authorizationOutcomeFromJsonRpcResponse(response: JsonRpcResponseEnvelope): string {
  if (response.error === undefined) return 'allowed';
  const weftCode = response.error.data?.['weftCode'];
  return typeof weftCode === 'string'
    ? weftCode
    : `JSON-RPC ${String(response.error.code ?? 'error')}`;
}

function confirmationTokenFromPreview(preview: unknown): string {
  const token = (preview as { confirmationToken?: unknown }).confirmationToken;
  if (typeof token !== 'string') throw new Error('Expected bulk preview confirmation token');
  return token;
}

function normalizeBulkAuditParityPayload(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return payload;
  const result = payload as { auditEvent?: unknown };
  if (typeof result.auditEvent !== 'object' || result.auditEvent === null) return payload;

  const auditEvent = result.auditEvent as { principal?: unknown };
  if (typeof auditEvent.principal !== 'object' || auditEvent.principal === null) return payload;
  const principal = auditEvent.principal as { method?: unknown };

  return {
    ...result,
    auditEvent: {
      ...auditEvent,
      principal: { method: typeof principal.method === 'string' ? principal.method : 'unknown' },
    },
  };
}

function normalizeBulkCancelParityPayload(payload: unknown): unknown {
  return normalizeBulkAuditParityPayload(payload);
}

async function invokeGetAcrossTransports(
  engine: Engine,
  server: WeftServer,
  workflowId: string,
): Promise<Record<TransportName, unknown>> {
  const restResponse = await fetch(`${server.url}/v1/workflows/${workflowId}`);
  expect(restResponse.status).toBe(200);
  const rest = await restResponse.json();

  const jsonRpcHttp = await postJsonRpc(server, 'weft.workflows.get', { workflowId });

  const webSocket = await openWebSocket(`${server.url.replace('http://', 'ws://')}/jsonrpc`);
  try {
    const messagePromise = waitForMessage(
      webSocket,
      (parsed) =>
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { id?: string }).id === 'parity-get',
    );
    webSocket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'parity-get',
        method: 'weft.workflows.get',
        params: { workflowId },
      }),
    );
    const webSocketResponse = (await messagePromise) as { error?: unknown; result?: unknown };
    expect(webSocketResponse.error).toBeUndefined();

    const stdio = await invokeStdioJsonRpc(engine, 'weft.workflows.get', { workflowId });

    return {
      rest,
      'json-rpc-http': jsonRpcHttp,
      'json-rpc-websocket': webSocketResponse.result,
      'json-rpc-stdio': stdio,
    };
  } finally {
    webSocket.close();
  }
}

async function invokeSignalTransport(
  transport: TransportName,
  servers: WeftServer[],
  engines: Engine[],
): Promise<{ callCount: number; result: unknown; workflowResult: unknown }> {
  const engine = createHoldEngine();
  engines.push(engine);

  let callCount = 0;
  const originalSignal = engine.signal.bind(engine) as (
    workflowId: string,
    name: string | { readonly name: string },
    payload?: unknown,
  ) => Promise<void>;
  engine.signal = (async (
    workflowId: string,
    name: string | { readonly name: string },
    payload?: unknown,
  ) => {
    callCount += 1;
    return originalSignal(workflowId, name, payload);
  }) as Engine['signal'];

  const handle = await engine.start('hold', null, { id: `parity-signal-${transport}` });
  await waitForStatus(engine, handle.id, 'running');

  const server = serve({ engine, port: 0 });
  servers.push(server);

  let result: unknown;
  switch (transport) {
    case 'rest': {
      const response = await fetch(`${server.url}/v1/workflows/${handle.id}/signal/release`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: 'released' }),
      });
      expect(response.status).toBe(200);
      result = await response.json();
      break;
    }
    case 'json-rpc-http':
      result = await postJsonRpc(server, 'weft.workflows.signal', {
        workflowId: handle.id,
        signalName: 'release',
        payload: 'released',
      });
      break;
    case 'json-rpc-websocket': {
      const webSocket = await openWebSocket(`${server.url.replace('http://', 'ws://')}/jsonrpc`);
      try {
        const messagePromise = waitForMessage(
          webSocket,
          (parsed) =>
            typeof parsed === 'object' &&
            parsed !== null &&
            (parsed as { id?: string }).id === 'parity-signal',
        );
        webSocket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'parity-signal',
            method: 'weft.workflows.signal',
            params: {
              workflowId: handle.id,
              signalName: 'release',
              payload: 'released',
            },
          }),
        );
        const response = (await messagePromise) as { error?: unknown; result?: unknown };
        expect(response.error).toBeUndefined();
        result = response.result;
      } finally {
        webSocket.close();
      }
      break;
    }
    case 'json-rpc-stdio':
      result = await invokeStdioJsonRpc(engine, 'weft.workflows.signal', {
        workflowId: handle.id,
        signalName: 'release',
        payload: 'released',
      });
      break;
  }

  const workflowResult = await handle.result();
  return { callCount, result, workflowResult };
}

async function invokeStartTransport(
  transport: TransportName,
  servers: WeftServer[],
  engines: Engine[],
): Promise<{ callCount: number; result: unknown; state: unknown }> {
  const engine = createHoldEngine();
  engines.push(engine);

  let callCount = 0;
  const originalStart = engine.start.bind(engine);
  engine.start = async (...args: Parameters<Engine['start']>) => {
    callCount += 1;
    return originalStart(...args);
  };

  const server = serve({ engine, port: 0 });
  servers.push(server);

  let result: unknown;
  switch (transport) {
    case 'rest': {
      const response = await fetch(`${server.url}/v1/workflows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'hold' }),
      });
      expect(response.status).toBe(201);
      result = await response.json();
      break;
    }
    case 'json-rpc-http':
      result = await postJsonRpc(server, 'weft.workflows.start', { type: 'hold' });
      break;
    case 'json-rpc-websocket': {
      const webSocket = await openWebSocket(`${server.url.replace('http://', 'ws://')}/jsonrpc`);
      try {
        const messagePromise = waitForMessage(
          webSocket,
          (parsed) =>
            typeof parsed === 'object' &&
            parsed !== null &&
            (parsed as { id?: string }).id === 'parity-start',
        );
        webSocket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'parity-start',
            method: 'weft.workflows.start',
            params: { type: 'hold' },
          }),
        );
        const response = (await messagePromise) as { error?: unknown; result?: unknown };
        expect(response.error).toBeUndefined();
        result = response.result;
      } finally {
        webSocket.close();
      }
      break;
    }
    case 'json-rpc-stdio':
      result = await invokeStdioJsonRpc(engine, 'weft.workflows.start', { type: 'hold' });
      break;
  }

  const workflowId = (result as { id?: string }).id;
  expect(typeof workflowId).toBe('string');
  const state = await postJsonRpc(server, 'weft.workflows.get', { workflowId });
  return { callCount, result, state };
}

async function invokeBulkCancelTransport(
  transport: TransportName,
  servers: WeftServer[],
  engines: Engine[],
): Promise<BulkTransportOutcome> {
  const engine = createHoldEngine();
  engines.push(engine);

  let callCount = 0;
  const originalCancelAll = engine.cancelAll.bind(engine);

  async function trackedCancelAll(
    filter: ListFilter,
    options: BulkOperationDryRunOptions,
  ): Promise<BulkOperationDryRunResult>;
  async function trackedCancelAll(
    filter: ListFilter,
    options?: BulkOperationCommitOptions,
  ): Promise<BulkCancelResult>;
  async function trackedCancelAll(
    filter: ListFilter,
    options?: BulkOperationOptions,
  ): Promise<BulkCancelResult | BulkOperationDryRunResult> {
    callCount += 1;
    if (options?.dryRun === true) {
      return originalCancelAll(filter, options);
    }
    return originalCancelAll(filter, options);
  }

  engine.cancelAll = trackedCancelAll;

  await engine.start('hold', null, {
    id: `parity-bulk-selected-a-${transport}`,
    tags: ['selected'],
  });
  await engine.start('hold', null, {
    id: `parity-bulk-selected-b-${transport}`,
    tags: ['selected'],
  });
  await engine.start('hold', null, {
    id: `parity-bulk-other-${transport}`,
    tags: ['other'],
  });

  await Promise.all([
    waitForStatus(engine, `parity-bulk-selected-a-${transport}`, 'running'),
    waitForStatus(engine, `parity-bulk-selected-b-${transport}`, 'running'),
    waitForStatus(engine, `parity-bulk-other-${transport}`, 'running'),
  ]);

  const server = serve({ engine, ...bulkServeOptions });
  servers.push(server);

  const requestId = `parity-bulk-cancel-${transport}`;
  const previewParameters = { tags: ['selected'], dryRun: true, requestId };
  const staleParameters = (confirmationToken: string) => ({
    tags: ['other'],
    confirmationToken,
    requestId,
  });
  const commitParameters = (confirmationToken: string) => ({
    tags: ['selected'],
    confirmationToken,
    requestId,
  });

  let outcome: BulkPreviewStaleCommitOutcome;
  switch (transport) {
    case 'rest':
      outcome = await invokeBulkRestPreviewStaleCommit(
        server,
        { method: 'POST', path: '/v1/workflows/bulk/cancel' },
        { filter: { tags: ['selected'] }, dryRun: true, requestId },
        (confirmationToken) => ({ filter: { tags: ['other'] }, confirmationToken, requestId }),
        (confirmationToken) => ({
          filter: { tags: ['selected'] },
          confirmationToken,
          requestId,
        }),
      );
      break;
    case 'json-rpc-http':
      outcome = await invokeBulkJsonRpcPreviewStaleCommit(
        server,
        'weft.workflows.bulk.cancel',
        previewParameters,
        staleParameters,
        commitParameters,
      );
      break;
    case 'json-rpc-websocket':
      outcome = await invokeBulkWebSocketPreviewStaleCommit(
        server,
        'weft.workflows.bulk.cancel',
        previewParameters,
        staleParameters,
        commitParameters,
        `parity-bulk-cancel-${transport}`,
      );
      break;
    case 'json-rpc-stdio':
      outcome = await invokeBulkStdioPreviewStaleCommit(
        engine,
        'weft.workflows.bulk.cancel',
        previewParameters,
        staleParameters,
        commitParameters,
      );
      break;
  }

  return { callCount, ...outcome };
}

function createRetryFailedEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  const attemptsByInput = new Map<string, number>();
  const retryOnceWorkflow = workflow({ name: 'parity-retry-once' }).execute(async function* (
    _ctx: WorkflowContext,
    input: { value: string },
  ) {
    const attempts = attemptsByInput.get(input.value) ?? 0;
    attemptsByInput.set(input.value, attempts + 1);
    if (attempts === 0) {
      throw new Error(`failed:${input.value}`);
    }
    return `retried:${input.value}`;
  });

  engine.register(retryOnceWorkflow);
  return engine;
}

async function invokeBulkRetryFailedTransport(
  transport: TransportName,
  servers: WeftServer[],
  engines: Engine[],
): Promise<BulkTransportOutcome> {
  const engine = createRetryFailedEngine();
  engines.push(engine);

  let callCount = 0;
  const originalRetryFailedAll = engine.retryFailedAll.bind(engine);

  async function trackedRetryFailedAll(
    filter: ListFilter,
    options: BulkOperationDryRunOptions,
  ): Promise<BulkOperationDryRunResult>;
  async function trackedRetryFailedAll(
    filter: ListFilter,
    options?: BulkOperationCommitOptions,
  ): Promise<BulkRetryFailedResult>;
  async function trackedRetryFailedAll(
    filter: ListFilter,
    options?: BulkOperationOptions,
  ): Promise<BulkRetryFailedResult | BulkOperationDryRunResult> {
    callCount += 1;
    if (options?.dryRun === true) {
      return originalRetryFailedAll(filter, options);
    }
    return originalRetryFailedAll(filter, options);
  }

  engine.retryFailedAll = trackedRetryFailedAll;

  await engine.start(
    'parity-retry-once',
    { value: 'selected-a' },
    {
      id: `parity-bulk-retry-selected-a-${transport}`,
      tags: ['selected'],
    },
  );
  await engine.start(
    'parity-retry-once',
    { value: 'selected-b' },
    {
      id: `parity-bulk-retry-selected-b-${transport}`,
      tags: ['selected'],
    },
  );
  await engine.start(
    'parity-retry-once',
    { value: 'other' },
    {
      id: `parity-bulk-retry-other-${transport}`,
      tags: ['other'],
    },
  );

  await Promise.all([
    waitForStatus(engine, `parity-bulk-retry-selected-a-${transport}`, 'failed'),
    waitForStatus(engine, `parity-bulk-retry-selected-b-${transport}`, 'failed'),
    waitForStatus(engine, `parity-bulk-retry-other-${transport}`, 'failed'),
  ]);

  const server = serve({ engine, ...bulkServeOptions });
  servers.push(server);

  const requestId = `parity-bulk-retry-failed-${transport}`;
  const previewParameters = { tags: ['selected'], dryRun: true, requestId };
  const staleParameters = (confirmationToken: string) => ({
    tags: ['other'],
    confirmationToken,
    requestId,
  });
  const commitParameters = (confirmationToken: string) => ({
    tags: ['selected'],
    confirmationToken,
    requestId,
  });

  let outcome: BulkPreviewStaleCommitOutcome;
  switch (transport) {
    case 'rest':
      outcome = await invokeBulkRestPreviewStaleCommit(
        server,
        { method: 'POST', path: '/v1/workflows/bulk/retry-failed' },
        { filter: { tags: ['selected'] }, dryRun: true, requestId },
        (confirmationToken) => ({ filter: { tags: ['other'] }, confirmationToken, requestId }),
        (confirmationToken) => ({
          filter: { tags: ['selected'] },
          confirmationToken,
          requestId,
        }),
      );
      break;
    case 'json-rpc-http':
      outcome = await invokeBulkJsonRpcPreviewStaleCommit(
        server,
        'weft.workflows.bulk.retryfailed',
        previewParameters,
        staleParameters,
        commitParameters,
      );
      break;
    case 'json-rpc-websocket':
      outcome = await invokeBulkWebSocketPreviewStaleCommit(
        server,
        'weft.workflows.bulk.retryfailed',
        previewParameters,
        staleParameters,
        commitParameters,
        `parity-bulk-retry-failed-${transport}`,
      );
      break;
    case 'json-rpc-stdio':
      outcome = await invokeBulkStdioPreviewStaleCommit(
        engine,
        'weft.workflows.bulk.retryfailed',
        previewParameters,
        staleParameters,
        commitParameters,
      );
      break;
  }

  await Promise.all([
    waitForStatus(engine, `parity-bulk-retry-selected-a-${transport}`, 'completed'),
    waitForStatus(engine, `parity-bulk-retry-selected-b-${transport}`, 'completed'),
  ]);
  const otherState = await engine.get(`parity-bulk-retry-other-${transport}`);
  expect(otherState?.status).toBe('failed');
  return { callCount, ...outcome };
}

type BulkRestRoute = {
  method: 'POST' | 'PATCH' | 'DELETE';
  path: string;
};

async function invokeBulkRestPreviewStaleCommit(
  server: WeftServer,
  route: BulkRestRoute,
  previewBody: Record<string, unknown>,
  staleBody: (confirmationToken: string) => Record<string, unknown>,
  commitBody: (confirmationToken: string) => Record<string, unknown>,
): Promise<BulkPreviewStaleCommitOutcome> {
  const previewResponse = await fetch(`${server.url}${route.path}`, {
    method: route.method,
    headers: bulkJsonHeaders(),
    body: JSON.stringify(previewBody),
  });
  const authorizationOutcome = authorizationOutcomeFromRestStatus(previewResponse.status);
  expect(authorizationOutcome).toBe('allowed');
  expect(previewResponse.status).toBe(200);
  const preview = await previewResponse.json();
  const confirmationToken = confirmationTokenFromPreview(preview);

  const staleResponse = await fetch(`${server.url}${route.path}`, {
    method: route.method,
    headers: bulkJsonHeaders(),
    body: JSON.stringify(staleBody(confirmationToken)),
  });
  expect(staleResponse.status).toBe(400);
  await staleResponse.json();
  const staleFaultCode = bulkRestFaultCodeFromStatus(staleResponse.status);
  expect(staleFaultCode).toBe('InvalidParams');

  const response = await fetch(`${server.url}${route.path}`, {
    method: route.method,
    headers: bulkJsonHeaders(),
    body: JSON.stringify(commitBody(confirmationToken)),
  });
  expect(response.status).toBe(200);
  return { authorizationOutcome, result: await response.json(), staleFaultCode };
}

async function invokeBulkJsonRpcPreviewStaleCommit(
  server: WeftServer,
  operationName: string,
  previewParameters: Record<string, unknown>,
  staleParameters: (confirmationToken: string) => Record<string, unknown>,
  commitParameters: (confirmationToken: string) => Record<string, unknown>,
): Promise<BulkPreviewStaleCommitOutcome> {
  const previewResponse = await postJsonRpcEnvelope(
    server,
    operationName,
    previewParameters,
    bulkJsonHeaders(),
  );
  const authorizationOutcome = authorizationOutcomeFromJsonRpcResponse(previewResponse);
  expect(authorizationOutcome).toBe('allowed');
  expect(previewResponse.error).toBeUndefined();
  const confirmationToken = confirmationTokenFromPreview(previewResponse.result);

  const staleError = await postJsonRpcExpectError(
    server,
    operationName,
    staleParameters(confirmationToken),
    bulkJsonHeaders(),
  );
  const staleFaultCode = String(staleError.data?.['weftCode']);
  expect(staleFaultCode).toBe('InvalidParams');

  return {
    result: await postJsonRpc(
      server,
      operationName,
      commitParameters(confirmationToken),
      bulkJsonHeaders(),
    ),
    staleFaultCode,
    authorizationOutcome,
  };
}

async function sendWebSocketJsonRpc(
  webSocket: WebSocket,
  id: string,
  operationName: string,
  params: Record<string, unknown>,
): Promise<{ error?: { code?: number; data?: Record<string, unknown> }; result?: unknown }> {
  const messagePromise = waitForMessage(
    webSocket,
    (parsed) =>
      typeof parsed === 'object' && parsed !== null && (parsed as { id?: string }).id === id,
  );
  webSocket.send(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: operationName,
      params,
    }),
  );
  return (await messagePromise) as {
    error?: { code?: number; data?: Record<string, unknown> };
    result?: unknown;
  };
}

async function invokeBulkWebSocketPreviewStaleCommit(
  server: WeftServer,
  operationName: string,
  previewParameters: Record<string, unknown>,
  staleParameters: (confirmationToken: string) => Record<string, unknown>,
  commitParameters: (confirmationToken: string) => Record<string, unknown>,
  idPrefix: string,
): Promise<BulkPreviewStaleCommitOutcome> {
  const webSocket = await openWebSocket(`${server.url.replace('http://', 'ws://')}/jsonrpc`, {
    authorization: `Bearer ${BULK_TEST_API_KEY}`,
  });
  try {
    const previewResponse = await sendWebSocketJsonRpc(
      webSocket,
      `${idPrefix}-preview`,
      operationName,
      previewParameters,
    );
    const authorizationOutcome = authorizationOutcomeFromJsonRpcResponse(previewResponse);
    expect(authorizationOutcome).toBe('allowed');
    expect(previewResponse.error).toBeUndefined();
    const confirmationToken = confirmationTokenFromPreview(previewResponse.result);

    const staleResponse = await sendWebSocketJsonRpc(
      webSocket,
      `${idPrefix}-stale`,
      operationName,
      staleParameters(confirmationToken),
    );
    const staleFaultCode = String(staleResponse.error?.data?.['weftCode']);
    expect(staleFaultCode).toBe('InvalidParams');

    const response = await sendWebSocketJsonRpc(
      webSocket,
      `${idPrefix}-commit`,
      operationName,
      commitParameters(confirmationToken),
    );
    expect(response.error).toBeUndefined();
    return { authorizationOutcome, result: response.result, staleFaultCode };
  } finally {
    webSocket.close();
  }
}

async function invokeBulkStdioPreviewStaleCommit(
  engine: Engine,
  operationName: string,
  previewParameters: Record<string, unknown>,
  staleParameters: (confirmationToken: string) => Record<string, unknown>,
  commitParameters: (confirmationToken: string) => Record<string, unknown>,
): Promise<BulkPreviewStaleCommitOutcome> {
  const previewResponse = await invokeStdioJsonRpcEnvelope(
    engine,
    operationName,
    previewParameters,
  );
  const authorizationOutcome = authorizationOutcomeFromJsonRpcResponse(previewResponse);
  expect(authorizationOutcome).toBe('allowed');
  expect(previewResponse.error).toBeUndefined();
  const confirmationToken = confirmationTokenFromPreview(previewResponse.result);

  const staleError = await invokeStdioJsonRpcExpectError(
    engine,
    operationName,
    staleParameters(confirmationToken),
  );
  const staleFaultCode = String(staleError.data?.['weftCode']);
  expect(staleFaultCode).toBe('InvalidParams');

  return {
    result: await invokeStdioJsonRpc(engine, operationName, commitParameters(confirmationToken)),
    staleFaultCode,
    authorizationOutcome,
  };
}

async function invokeBulkSignalTransport(
  transport: TransportName,
  servers: WeftServer[],
  engines: Engine[],
): Promise<BulkTransportOutcome> {
  const engine = createHoldEngine();
  engines.push(engine);

  let callCount = 0;
  const originalSignalAll = engine.signalAll.bind(engine) as (
    filter: ListFilter,
    name: string,
    payloadOrOptions?: unknown,
    options?: BulkOperationOptions,
  ) => Promise<BulkSignalResult | BulkOperationDryRunResult>;
  engine.signalAll = (async (
    filter: ListFilter,
    name: string,
    payloadOrOptions?: unknown,
    options?: BulkOperationOptions,
  ) => {
    callCount += 1;
    return originalSignalAll(filter, name, payloadOrOptions, options);
  }) as Engine['signalAll'];

  const firstHandle = await engine.start('hold', null, {
    id: `parity-bulk-signal-selected-a-${transport}`,
    tags: ['selected'],
  });
  const secondHandle = await engine.start('hold', null, {
    id: `parity-bulk-signal-selected-b-${transport}`,
    tags: ['selected'],
  });
  const otherHandle = await engine.start('hold', null, {
    id: `parity-bulk-signal-other-${transport}`,
    tags: ['other'],
  });

  await Promise.all([
    waitForStatus(engine, firstHandle.id, 'running'),
    waitForStatus(engine, secondHandle.id, 'running'),
    waitForStatus(engine, otherHandle.id, 'running'),
  ]);

  const server = serve({ engine, ...bulkServeOptions });
  servers.push(server);

  const requestId = `parity-bulk-signal-${transport}`;
  const previewParameters = {
    tags: ['selected'],
    name: 'release',
    payload: 'released',
    dryRun: true,
    requestId,
  };
  const staleParameters = (confirmationToken: string) => ({
    tags: ['selected'],
    name: 'release',
    payload: 'different',
    confirmationToken,
    requestId,
  });
  const commitParameters = (confirmationToken: string) => ({
    tags: ['selected'],
    name: 'release',
    payload: 'released',
    confirmationToken,
    requestId,
  });

  let outcome: BulkPreviewStaleCommitOutcome;
  switch (transport) {
    case 'rest':
      outcome = await invokeBulkRestPreviewStaleCommit(
        server,
        { method: 'POST', path: '/v1/workflows/bulk/signal' },
        {
          filter: { tags: ['selected'] },
          name: 'release',
          payload: 'released',
          dryRun: true,
          requestId,
        },
        (confirmationToken) => ({
          filter: { tags: ['selected'] },
          name: 'release',
          payload: 'different',
          confirmationToken,
          requestId,
        }),
        (confirmationToken) => ({
          filter: { tags: ['selected'] },
          name: 'release',
          payload: 'released',
          confirmationToken,
          requestId,
        }),
      );
      break;
    case 'json-rpc-http':
      outcome = await invokeBulkJsonRpcPreviewStaleCommit(
        server,
        'weft.workflows.bulk.signal',
        previewParameters,
        staleParameters,
        commitParameters,
      );
      break;
    case 'json-rpc-websocket':
      outcome = await invokeBulkWebSocketPreviewStaleCommit(
        server,
        'weft.workflows.bulk.signal',
        previewParameters,
        staleParameters,
        commitParameters,
        `parity-bulk-signal-${transport}`,
      );
      break;
    case 'json-rpc-stdio':
      outcome = await invokeBulkStdioPreviewStaleCommit(
        engine,
        'weft.workflows.bulk.signal',
        previewParameters,
        staleParameters,
        commitParameters,
      );
      break;
  }

  await expect(firstHandle.result()).resolves.toBe('released');
  await expect(secondHandle.result()).resolves.toBe('released');
  await engine.signal(otherHandle.id, 'release', 'cleanup');
  await otherHandle.result();
  return { callCount, ...outcome };
}

async function invokeBulkDeleteTransport(
  transport: TransportName,
  servers: WeftServer[],
  engines: Engine[],
): Promise<BulkTransportOutcome> {
  const engine = createHoldEngine();
  engines.push(engine);

  let callCount = 0;
  const originalDeleteAll = engine.deleteAll.bind(engine);

  async function trackedDeleteAll(
    filter: ListFilter,
    options: BulkOperationDryRunOptions,
  ): Promise<BulkOperationDryRunResult>;
  async function trackedDeleteAll(
    filter: ListFilter,
    options?: BulkOperationCommitOptions,
  ): Promise<BulkDeleteResult>;
  async function trackedDeleteAll(
    filter: ListFilter,
    options?: BulkOperationOptions,
  ): Promise<BulkDeleteResult | BulkOperationDryRunResult> {
    callCount += 1;
    if (options?.dryRun === true) {
      return originalDeleteAll(filter, options);
    }
    return originalDeleteAll(filter, options);
  }

  engine.deleteAll = trackedDeleteAll;

  const firstHandle = await engine.start('echo', 'first', {
    id: `parity-bulk-delete-selected-a-${transport}`,
    tags: ['selected'],
  });
  const secondHandle = await engine.start('echo', 'second', {
    id: `parity-bulk-delete-selected-b-${transport}`,
    tags: ['selected'],
  });
  await firstHandle.result();
  await secondHandle.result();

  const server = serve({ engine, ...bulkServeOptions });
  servers.push(server);

  const requestId = `parity-bulk-delete-${transport}`;
  const previewParameters = { tags: ['selected'], dryRun: true, requestId };
  const staleParameters = (confirmationToken: string) => ({
    tags: ['other'],
    confirmationToken,
    requestId,
  });
  const commitParameters = (confirmationToken: string) => ({
    tags: ['selected'],
    confirmationToken,
    requestId,
  });

  let outcome: BulkPreviewStaleCommitOutcome;
  switch (transport) {
    case 'rest':
      outcome = await invokeBulkRestPreviewStaleCommit(
        server,
        { method: 'DELETE', path: '/v1/workflows/bulk' },
        { filter: { tags: ['selected'] }, dryRun: true, requestId },
        (confirmationToken) => ({ filter: { tags: ['other'] }, confirmationToken, requestId }),
        (confirmationToken) => ({ filter: { tags: ['selected'] }, confirmationToken, requestId }),
      );
      break;
    case 'json-rpc-http':
      outcome = await invokeBulkJsonRpcPreviewStaleCommit(
        server,
        'weft.workflows.bulk.delete',
        previewParameters,
        staleParameters,
        commitParameters,
      );
      break;
    case 'json-rpc-websocket':
      outcome = await invokeBulkWebSocketPreviewStaleCommit(
        server,
        'weft.workflows.bulk.delete',
        previewParameters,
        staleParameters,
        commitParameters,
        `parity-bulk-delete-${transport}`,
      );
      break;
    case 'json-rpc-stdio':
      outcome = await invokeBulkStdioPreviewStaleCommit(
        engine,
        'weft.workflows.bulk.delete',
        previewParameters,
        staleParameters,
        commitParameters,
      );
      break;
  }

  expect(await engine.get(firstHandle.id)).toBeNull();
  expect(await engine.get(secondHandle.id)).toBeNull();
  return { callCount, ...outcome };
}

async function invokeBulkTagsTransport(
  transport: TransportName,
  servers: WeftServer[],
  engines: Engine[],
): Promise<BulkTransportOutcome> {
  const engine = createHoldEngine();
  engines.push(engine);

  let callCount = 0;
  const originalTagAll = engine.tagAll.bind(engine);

  async function trackedTagAll(
    filter: ListFilter,
    tags: string[],
    options: BulkOperationDryRunOptions,
  ): Promise<BulkOperationDryRunResult>;
  async function trackedTagAll(
    filter: ListFilter,
    tags: string[],
    options?: BulkOperationCommitOptions,
  ): Promise<BulkTagResult>;
  async function trackedTagAll(
    filter: ListFilter,
    tags: string[],
    options?: BulkOperationOptions,
  ): Promise<BulkTagResult | BulkOperationDryRunResult> {
    callCount += 1;
    if (options?.dryRun === true) {
      return originalTagAll(filter, tags, options);
    }
    return originalTagAll(filter, tags, options);
  }

  engine.tagAll = trackedTagAll;

  const firstHandle = await engine.start('echo', 'first', {
    id: `parity-bulk-tags-selected-a-${transport}`,
    tags: ['selected'],
  });
  const secondHandle = await engine.start('echo', 'second', {
    id: `parity-bulk-tags-selected-b-${transport}`,
    tags: ['selected'],
  });
  await firstHandle.result();
  await secondHandle.result();

  const server = serve({ engine, ...bulkServeOptions });
  servers.push(server);

  const requestId = `parity-bulk-tags-${transport}`;
  const previewParameters = {
    filter: { tags: ['selected'] },
    tags: ['bulk'],
    operation: 'add',
    dryRun: true,
    requestId,
  };
  const staleParameters = (confirmationToken: string) => ({
    filter: { tags: ['selected'] },
    tags: ['different'],
    operation: 'add',
    confirmationToken,
    requestId,
  });
  const commitParameters = (confirmationToken: string) => ({
    filter: { tags: ['selected'] },
    tags: ['bulk'],
    operation: 'add',
    confirmationToken,
    requestId,
  });

  let outcome: BulkPreviewStaleCommitOutcome;
  switch (transport) {
    case 'rest':
      outcome = await invokeBulkRestPreviewStaleCommit(
        server,
        { method: 'PATCH', path: '/v1/workflows/bulk/tags' },
        previewParameters,
        staleParameters,
        commitParameters,
      );
      break;
    case 'json-rpc-http':
      outcome = await invokeBulkJsonRpcPreviewStaleCommit(
        server,
        'weft.workflows.bulk.tags',
        previewParameters,
        staleParameters,
        commitParameters,
      );
      break;
    case 'json-rpc-websocket':
      outcome = await invokeBulkWebSocketPreviewStaleCommit(
        server,
        'weft.workflows.bulk.tags',
        previewParameters,
        staleParameters,
        commitParameters,
        `parity-bulk-tags-${transport}`,
      );
      break;
    case 'json-rpc-stdio':
      outcome = await invokeBulkStdioPreviewStaleCommit(
        engine,
        'weft.workflows.bulk.tags',
        previewParameters,
        staleParameters,
        commitParameters,
      );
      break;
  }

  const firstState = await engine.get(firstHandle.id);
  const secondState = await engine.get(secondHandle.id);
  expect(firstState?.tags).toEqual(['bulk', 'selected']);
  expect(secondState?.tags).toEqual(['bulk', 'selected']);
  return { callCount, ...outcome };
}

describe('cross-transport parity', () => {
  const servers: WeftServer[] = [];
  const engines: Engine[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.stop();
    }
    while (engines.length > 0) {
      engines.pop()?.[Symbol.dispose]();
    }
  });

  it('REST and JSON-RPC requests dispatch into the same Engine methods', async () => {
    const invariants: ParityInvariants = {
      successPayload: 'identical-json',
      errorMapping: 'one-to-one',
      authBehavior: 'identical',
      sideEffects: 'invoked-once-per-call',
    };

    const engine = createHoldEngine();
    engines.push(engine);
    const handle = await engine.start('hold', null, { id: 'parity-parity-get' });
    await waitForStatus(engine, handle.id, 'running');

    const server = serve({ engine, port: 0 });
    servers.push(server);

    const results = await invokeGetAcrossTransports(engine, server, handle.id);
    assertSuccessParity(results, invariants, 'weft.workflows.get');
  });

  it('REST and JSON-RPC share one engine-error mapping layer', async () => {
    const engine = createHoldEngine();
    engines.push(engine);

    const server = serve({ engine, port: 0 });
    servers.push(server);

    const workflowId = 'nonexistent-workflow-id';

    const restResponse = await fetch(`${server.url}/v1/workflows/${workflowId}`);
    expect(restResponse.status).toBe(404);
    await restResponse.json();

    const jsonRpcHttpResponse = await fetch(`${server.url}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'parity-not-found-http',
        method: 'weft.workflows.get',
        params: { workflowId },
      }),
    });
    expect(jsonRpcHttpResponse.status).toBe(200);
    const jsonRpcHttpBody = (await jsonRpcHttpResponse.json()) as {
      error?: { code?: number; data?: Record<string, unknown> };
    };
    expect(jsonRpcHttpBody.error).toBeDefined();
    expect(jsonRpcHttpBody.error?.data?.['weftCode']).toBe('NotFound');

    const webSocket = await openWebSocket(`${server.url.replace('http://', 'ws://')}/jsonrpc`);
    try {
      const messagePromise = waitForMessage(
        webSocket,
        (parsed) =>
          typeof parsed === 'object' &&
          parsed !== null &&
          (parsed as { id?: string }).id === 'parity-not-found-websocket',
      );
      webSocket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'parity-not-found-websocket',
          method: 'weft.workflows.get',
          params: { workflowId },
        }),
      );
      const webSocketBody = (await messagePromise) as {
        error?: { code?: number; data?: Record<string, unknown> };
      };
      expect(webSocketBody.error).toBeDefined();
      expect(webSocketBody.error?.data?.['weftCode']).toBe('NotFound');

      const stdioError = await invokeStdioJsonRpcExpectError(engine, 'weft.workflows.get', {
        workflowId,
      });
      expect(stdioError.data?.['weftCode']).toBe('NotFound');

      assertIdenticalFaultCode(
        String(jsonRpcHttpBody.error?.code),
        String(webSocketBody.error?.code),
        'weft.workflows.get NotFound: json-rpc-http vs json-rpc-websocket',
      );
      assertIdenticalFaultCode(
        String(jsonRpcHttpBody.error?.code),
        String(stdioError.code),
        'weft.workflows.get NotFound: json-rpc-http vs json-rpc-stdio',
      );
    } finally {
      webSocket.close();
    }
  });

  it('keeps weft.workflows.signal parity across REST, JSON-RPC HTTP, JSON-RPC WebSocket, and JSON-RPC stdio', async () => {
    const invariants: ParityInvariants = {
      successPayload: 'identical-json',
      errorMapping: 'one-to-one',
      authBehavior: 'identical',
      sideEffects: 'invoked-once-per-call',
    };

    const results = {
      rest: await invokeSignalTransport('rest', servers, engines),
      'json-rpc-http': await invokeSignalTransport('json-rpc-http', servers, engines),
      'json-rpc-websocket': await invokeSignalTransport('json-rpc-websocket', servers, engines),
      'json-rpc-stdio': await invokeSignalTransport('json-rpc-stdio', servers, engines),
    };

    assertSuccessParity(
      {
        rest: results.rest.result,
        'json-rpc-http': results['json-rpc-http'].result,
        'json-rpc-websocket': results['json-rpc-websocket'].result,
        'json-rpc-stdio': results['json-rpc-stdio'].result,
      },
      invariants,
      'weft.workflows.signal',
    );

    for (const outcome of Object.values(results)) {
      expect(outcome.callCount).toBe(1);
      expect(outcome.workflowResult).toBe('released');
      expect(outcome.result).toEqual({ ok: true });
    }
  });

  it('keeps weft.workflows.start parity across REST, JSON-RPC HTTP, JSON-RPC WebSocket, and JSON-RPC stdio', async () => {
    const invariants: ParityInvariants = {
      successPayload: 'shape-equivalent',
      errorMapping: 'one-to-one',
      authBehavior: 'identical',
      sideEffects: 'invoked-once-per-call',
    };

    const results = {
      rest: await invokeStartTransport('rest', servers, engines),
      'json-rpc-http': await invokeStartTransport('json-rpc-http', servers, engines),
      'json-rpc-websocket': await invokeStartTransport('json-rpc-websocket', servers, engines),
      'json-rpc-stdio': await invokeStartTransport('json-rpc-stdio', servers, engines),
    };

    assertSuccessParity(
      {
        rest: results.rest.result,
        'json-rpc-http': results['json-rpc-http'].result,
        'json-rpc-websocket': results['json-rpc-websocket'].result,
        'json-rpc-stdio': results['json-rpc-stdio'].result,
      },
      invariants,
      'weft.workflows.start',
    );

    for (const outcome of Object.values(results)) {
      expect(outcome.callCount).toBe(1);
      expect((outcome.state as { id?: string }).id).toBe((outcome.result as { id?: string }).id);
    }
  });

  it('keeps weft.workflows.bulk.cancel parity across REST, JSON-RPC HTTP, JSON-RPC WebSocket, and JSON-RPC stdio', async () => {
    const invariants: ParityInvariants = {
      successPayload: 'shape-equivalent',
      errorMapping: 'one-to-one',
      authBehavior: 'identical',
      sideEffects: 'invoked-once-per-call',
    };

    const results = {
      rest: await invokeBulkCancelTransport('rest', servers, engines),
      'json-rpc-http': await invokeBulkCancelTransport('json-rpc-http', servers, engines),
      'json-rpc-websocket': await invokeBulkCancelTransport('json-rpc-websocket', servers, engines),
      'json-rpc-stdio': await invokeBulkCancelTransport('json-rpc-stdio', servers, engines),
    };

    assertSuccessParity(
      {
        rest: normalizeBulkCancelParityPayload(results.rest.result),
        'json-rpc-http': normalizeBulkCancelParityPayload(results['json-rpc-http'].result),
        'json-rpc-websocket': normalizeBulkCancelParityPayload(
          results['json-rpc-websocket'].result,
        ),
        'json-rpc-stdio': normalizeBulkCancelParityPayload(results['json-rpc-stdio'].result),
      },
      invariants,
      'weft.workflows.bulk.cancel',
    );

    assertBulkOperationInvariants(results, invariants, 'weft.workflows.bulk.cancel', 3);

    for (const outcome of Object.values(results)) {
      expect((outcome.result as { cancelled?: number }).cancelled).toBe(2);
    }
  });

  it('keeps weft.workflows.bulk.signal parity across REST, JSON-RPC HTTP, JSON-RPC WebSocket, and JSON-RPC stdio', async () => {
    const invariants: ParityInvariants = {
      successPayload: 'shape-equivalent',
      errorMapping: 'one-to-one',
      authBehavior: 'identical',
      sideEffects: 'invoked-once-per-call',
    };

    const results = {
      rest: await invokeBulkSignalTransport('rest', servers, engines),
      'json-rpc-http': await invokeBulkSignalTransport('json-rpc-http', servers, engines),
      'json-rpc-websocket': await invokeBulkSignalTransport('json-rpc-websocket', servers, engines),
      'json-rpc-stdio': await invokeBulkSignalTransport('json-rpc-stdio', servers, engines),
    };

    assertSuccessParity(
      {
        rest: normalizeBulkAuditParityPayload(results.rest.result),
        'json-rpc-http': normalizeBulkAuditParityPayload(results['json-rpc-http'].result),
        'json-rpc-websocket': normalizeBulkAuditParityPayload(results['json-rpc-websocket'].result),
        'json-rpc-stdio': normalizeBulkAuditParityPayload(results['json-rpc-stdio'].result),
      },
      invariants,
      'weft.workflows.bulk.signal',
    );

    assertBulkOperationInvariants(results, invariants, 'weft.workflows.bulk.signal', 3);

    for (const outcome of Object.values(results)) {
      expect((outcome.result as BulkSignalResult).signalled).toBe(2);
    }
  });

  it('keeps weft.workflows.bulk.retryfailed parity across REST, JSON-RPC HTTP, JSON-RPC WebSocket, and JSON-RPC stdio', async () => {
    const invariants: ParityInvariants = {
      successPayload: 'shape-equivalent',
      errorMapping: 'one-to-one',
      authBehavior: 'identical',
      sideEffects: 'invoked-once-per-call',
    };

    const results = {
      rest: await invokeBulkRetryFailedTransport('rest', servers, engines),
      'json-rpc-http': await invokeBulkRetryFailedTransport('json-rpc-http', servers, engines),
      'json-rpc-websocket': await invokeBulkRetryFailedTransport(
        'json-rpc-websocket',
        servers,
        engines,
      ),
      'json-rpc-stdio': await invokeBulkRetryFailedTransport('json-rpc-stdio', servers, engines),
    };

    assertSuccessParity(
      {
        rest: normalizeBulkAuditParityPayload(results.rest.result),
        'json-rpc-http': normalizeBulkAuditParityPayload(results['json-rpc-http'].result),
        'json-rpc-websocket': normalizeBulkAuditParityPayload(results['json-rpc-websocket'].result),
        'json-rpc-stdio': normalizeBulkAuditParityPayload(results['json-rpc-stdio'].result),
      },
      invariants,
      'weft.workflows.bulk.retryfailed',
    );

    assertBulkOperationInvariants(results, invariants, 'weft.workflows.bulk.retryfailed', 3);

    for (const outcome of Object.values(results)) {
      expect((outcome.result as BulkRetryFailedResult).retried).toBe(2);
    }
  });

  it('keeps weft.workflows.bulk.delete parity across REST, JSON-RPC HTTP, JSON-RPC WebSocket, and JSON-RPC stdio', async () => {
    const invariants: ParityInvariants = {
      successPayload: 'shape-equivalent',
      errorMapping: 'one-to-one',
      authBehavior: 'identical',
      sideEffects: 'invoked-once-per-call',
    };

    const results = {
      rest: await invokeBulkDeleteTransport('rest', servers, engines),
      'json-rpc-http': await invokeBulkDeleteTransport('json-rpc-http', servers, engines),
      'json-rpc-websocket': await invokeBulkDeleteTransport('json-rpc-websocket', servers, engines),
      'json-rpc-stdio': await invokeBulkDeleteTransport('json-rpc-stdio', servers, engines),
    };

    assertSuccessParity(
      {
        rest: normalizeBulkAuditParityPayload(results.rest.result),
        'json-rpc-http': normalizeBulkAuditParityPayload(results['json-rpc-http'].result),
        'json-rpc-websocket': normalizeBulkAuditParityPayload(results['json-rpc-websocket'].result),
        'json-rpc-stdio': normalizeBulkAuditParityPayload(results['json-rpc-stdio'].result),
      },
      invariants,
      'weft.workflows.bulk.delete',
    );

    assertBulkOperationInvariants(results, invariants, 'weft.workflows.bulk.delete', 3);

    for (const outcome of Object.values(results)) {
      expect((outcome.result as BulkDeleteResult).deleted).toBe(2);
    }
  });

  it('keeps weft.workflows.bulk.tags parity across REST, JSON-RPC HTTP, JSON-RPC WebSocket, and JSON-RPC stdio', async () => {
    const invariants: ParityInvariants = {
      successPayload: 'shape-equivalent',
      errorMapping: 'one-to-one',
      authBehavior: 'identical',
      sideEffects: 'invoked-once-per-call',
    };

    const results = {
      rest: await invokeBulkTagsTransport('rest', servers, engines),
      'json-rpc-http': await invokeBulkTagsTransport('json-rpc-http', servers, engines),
      'json-rpc-websocket': await invokeBulkTagsTransport('json-rpc-websocket', servers, engines),
      'json-rpc-stdio': await invokeBulkTagsTransport('json-rpc-stdio', servers, engines),
    };

    assertSuccessParity(
      {
        rest: normalizeBulkAuditParityPayload(results.rest.result),
        'json-rpc-http': normalizeBulkAuditParityPayload(results['json-rpc-http'].result),
        'json-rpc-websocket': normalizeBulkAuditParityPayload(results['json-rpc-websocket'].result),
        'json-rpc-stdio': normalizeBulkAuditParityPayload(results['json-rpc-stdio'].result),
      },
      invariants,
      'weft.workflows.bulk.tags',
    );

    assertBulkOperationInvariants(results, invariants, 'weft.workflows.bulk.tags', 3);

    for (const outcome of Object.values(results)) {
      expect((outcome.result as BulkTagResult).modified).toBe(2);
    }
  });
});
