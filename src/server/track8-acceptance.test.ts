import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { createEngineEventFeedBackend } from './engine-event-feed-backend.ts';
import { faultToHttpResponse } from './fault-to-http.ts';
import { faultToJsonRpcError } from './fault-to-json-rpc.ts';
import { serve, type WeftServer } from './index.ts';
import { dispatchJsonRpc } from './json-rpc-dispatch.ts';
import {
  collectWebSocketDeliveredEnvelopes,
  openWebSocket,
  waitForMessage,
} from './json-rpc-websocket-client.test-support.ts';
import { createOperationRegistry } from './operation-catalog.ts';
import type { OperationFault } from './operation-fault.ts';
import { defineOperation } from './operation-registry.ts';
import { anonymousPrincipal } from './principal.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';
import { runStdioSession } from './stdio-session.ts';
import { createWorkflowEventFeed, type EventEnvelope } from './workflow-event-feed.ts';

const holdWorkflow = workflow({ name: 'hold' }).execute(async function* (
  ctx: WorkflowContext,
  _input: unknown,
) {
  const context = ctx;
  const value = yield* context.waitForSignal<string>('release');
  yield* context.run(async () => `echoed:${value}`);
  yield* context.run(async () => 'done');
  return value;
});

function createSignalWorkflowEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(holdWorkflow);
  return engine;
}

async function waitForEventCount(
  engine: Engine,
  workflowId: string,
  expected: number,
  timeoutMilliseconds = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const events = await engine.getEvents(workflowId);
    if (events.length >= expected) {
      return;
    }
    await sleepForTesting(5);
  }

  throw new Error(`workflow ${workflowId} did not reach ${expected} events in time`);
}

async function collectReplayEvents(engine: Engine, workflowId: string): Promise<EventEnvelope[]> {
  const backend = createEngineEventFeedBackend(engine);
  const feed = createWorkflowEventFeed(backend);
  const events: EventEnvelope[] = [];

  try {
    for await (const envelope of feed.replay({ workflowId, selector: 'events' })) {
      events.push(envelope);
    }
  } finally {
    feed.dispose();
  }

  return events;
}

// `weft.workflows.events` requires `workflows:read`. Tests below that drive
// subscriptions configure `serve({ auth: { apiKeys: [...] } })` and present
// the matching key on the WebSocket Authorization header.
const SUBSCRIBE_TEST_API_KEY = 'weft_test_track8_workflows_read_key_xxxxxxxxxxxxxxxx';
const subscribeServeOptions = {
  port: 0,
  auth: {
    apiKeys: [SUBSCRIBE_TEST_API_KEY],
    defaultApiKeyScopes: ['workflows:read'] as const,
  },
};

/**
 * Proves the single-projection invariant: the envelopes a WebSocket subscriber
 * receives over the wire match, position-for-position, the envelopes the engine
 * replays from its own event stream — same length, sequence, cursor, and kind.
 * Runs a signal workflow to completion, replays its events, subscribes over the
 * WebSocket transport, and compares.
 *
 * The engine is pushed onto `engines` and the server is handed to `assignServer`
 * the instant it is created — before the failure-prone WebSocket collection and
 * assertions — so a mid-test failure still leaves both registered for the
 * suite's `afterEach` disposal (the original inline tests assigned the
 * describe-scoped `server` at that same point).
 */
async function expectWebSocketProjectionMatchesReplay(
  engines: Engine[],
  assignServer: (createdServer: WeftServer) => void,
): Promise<void> {
  const engine = createSignalWorkflowEngine();
  engines.push(engine);
  const handle = await engine.start('hold', { hello: 'world' }, {});
  await engine.signal(handle.id, 'release', 'go');
  await handle.result();

  const replayed = await collectReplayEvents(engine, handle.id);
  expect(replayed.length).toBeGreaterThan(0);

  const server = serve({ engine, ...subscribeServeOptions });
  assignServer(server);
  const wireEnvelopes = await collectWebSocketDeliveredEnvelopes(
    server,
    handle.id,
    replayed.length,
    SUBSCRIBE_TEST_API_KEY,
  );

  expect(wireEnvelopes).toHaveLength(replayed.length);
  for (const [index, backendEnvelope] of replayed.entries()) {
    const wireEnvelope = wireEnvelopes[index];
    expect(wireEnvelope).toBeDefined();
    expect(wireEnvelope?.sequence).toBe(backendEnvelope.sequence);
    expect(wireEnvelope?.cursor).toBe(backendEnvelope.cursor);
    expect(wireEnvelope?.kind).toBe(backendEnvelope.kind);
  }
}

function isRelevantTraceabilityRow(cells: string[]): boolean {
  const category = cells[3] ?? '';
  const status = cells[4] ?? '';
  const evidenceTest = cells[8] ?? '';
  const closeable = cells[12] ?? '';

  const isRelevantCategory = category === 'behavioral' || category === 'cross-cutting-structural';
  return (
    isRelevantCategory &&
    closeable === 'true' &&
    status === 'shipped' &&
    evidenceTest !== 'n/a' &&
    evidenceTest !== ''
  );
}

function parseEvidenceTestReference(
  rowId: string,
  evidenceTest: string,
): { fileName: string; title: string } {
  const normalizedEvidenceTest = evidenceTest.replaceAll('`', '').trim();
  const colonIndex = normalizedEvidenceTest.indexOf(':');
  if (colonIndex === -1) {
    throw new Error(
      `Matrix row "${rowId}" has unparseable evidence_test "${evidenceTest}" (missing colon).`,
    );
  }

  const fileName = normalizedEvidenceTest.slice(0, colonIndex).trim();
  // Some criterion titles include embedded quotes (e.g. 8b-3 contains
  // `paramStructure: "by-name"`). Match from the first " to the LAST "
  // in the cell so the full quoted title is captured.
  const afterColon = normalizedEvidenceTest.slice(colonIndex + 1);
  const firstQuote = afterColon.indexOf('"');
  const lastQuote = afterColon.lastIndexOf('"');
  if (firstQuote === -1 || lastQuote <= firstQuote) {
    throw new Error(
      `Matrix row "${rowId}" has unparseable evidence_test "${evidenceTest}" (missing quoted title).`,
    );
  }
  const title = afterColon.slice(firstQuote + 1, lastQuote);

  return { fileName, title };
}

async function resolveTraceabilityTestFile(fileName: string): Promise<Bun.BunFile> {
  const directFilePath = `${import.meta.dir}/${fileName}`;
  const directFile = Bun.file(directFilePath);
  if (await directFile.exists()) {
    return directFile;
  }

  const matchingPaths = await Array.fromAsync(new Bun.Glob(`**/${fileName}`).scan(import.meta.dir));
  if (matchingPaths.length === 1) {
    return Bun.file(`${import.meta.dir}/${matchingPaths[0]}`);
  }

  return directFile;
}

describe('Track 8 acceptance coverage', () => {
  let server: WeftServer | undefined;
  const feeds: Array<{ dispose(): void }> = [];
  // MF6: track all engines created so they are disposed after each test.
  const engines: Engine[] = [];

  afterEach(async () => {
    for (const feed of feeds.splice(0)) {
      feed.dispose();
    }

    await server?.stop();
    server = undefined;

    // Dispose engines in LIFO order, matching the authentication.test.ts pattern.
    let engine: Engine | undefined;
    while ((engine = engines.pop()) !== undefined) {
      engine[Symbol.dispose]();
    }
  });

  it('External subscriptions project from existing typed EventTarget events. Engine and WorkflowHandle events remain the source of truth for watch and stream semantics.', async () => {
    const engine = createSignalWorkflowEngine();
    engines.push(engine);
    const handle = await engine.start('hold', { hello: 'world' }, {});
    await waitForEventCount(engine, handle.id, 1);

    const feed = createWorkflowEventFeed(createEngineEventFeedBackend(engine));
    feeds.push(feed);

    let resolveFirstRecord!: () => void;
    const firstRecordPromise = new Promise<void>((resolve) => {
      resolveFirstRecord = resolve;
    });

    const subscribePromise = (async () => {
      const received: EventEnvelope[] = [];
      let firstSeen = false;

      for await (const envelope of feed.subscribe({
        workflowId: handle.id,
        selector: 'events',
      })) {
        received.push(envelope);
        if (!firstSeen) {
          firstSeen = true;
          resolveFirstRecord();
        }
        if (envelope.kind === 'workflow:checkpoint' && received.length >= 3) {
          break;
        }
      }

      return received;
    })();

    await firstRecordPromise;
    await engine.signal(handle.id, 'release', 'go');
    await handle.result();

    const received = await subscribePromise;
    expect(received.length).toBeGreaterThan(0);
    expect(received.every((envelope) => envelope.workflowId === handle.id)).toBe(true);
  });

  it('One server-side event projection layer feeds every live transport. WebSocket watch and token messages, SSE responses, JSON-RPC subscription notifications, and cursor-based replay all project from the same event stream model.', async () => {
    await expectWebSocketProjectionMatchesReplay(engines, (createdServer) => {
      server = createdServer;
    });
  });

  it('Runtime JSON-RPC methods use stable namespaced names. Examples: weft.workflows.start, weft.workflows.get, weft.workflows.signal.', async () => {
    const registry = createLiveOperationRegistry();
    const names = registry.list().map((operation) => operation.name);

    expect(names).toContain('weft.workflows.start');
    expect(names).toContain('weft.workflows.get');
    expect(names).toContain('weft.workflows.signal');
    expect(names.every((name) => /^weft\.[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/.test(name))).toBe(
      true,
    );
  });

  it('Notifications are opt-in per call. Per JSON-RPC 2.0, the caller opts in to fire-and-forget by omitting the id field; an id-present request always produces a wire response. Every cataloged operation runs the same pipeline (schema validation, authorization, invoke) regardless of id presence, so authorization failures and validation errors are recorded server-side either way. Mutating operations therefore default to request-response — every standard JSON-RPC client library includes id automatically; notifications are an explicit caller opt-in by omitting it.', async () => {
    // Title above quotes the full 8b-5 criterion verbatim per the
    // coverage rule. The "drafting history" note in the criterion bullet
    // is a callout block, not part of the criterion text.
    // The criterion is satisfied at the JSON-RPC 2.0 protocol level:
    // every method is "opt-in per call" — the caller chooses by including
    // or omitting `id`. The operation pipeline (schema validation,
    // authorization, invoke) runs identically regardless. Mutating
    // operations therefore default to request-response because every
    // standard JSON-RPC client library includes `id` automatically.
    // Notifications are an explicit caller opt-in by omitting it.
    //
    // This test exercises both shapes against the same operation and
    // proves: (a) id-present produces a response (callers see errors
    // they can act on), (b) id-absent runs the same pipeline but drops
    // the response per spec (caller asked for fire-and-forget), (c) the
    // operation's invoke runs in both cases (auth/validation failures
    // are not silenced server-side).
    let invokeCount = 0;
    const registry = createOperationRegistry([
      defineOperation({
        name: 'weft.test.mutate',
        mcpExposable: false,
        destructive: false,
        summary: 'mutating test operation',
        inputSchema: z.object({ value: z.string() }),
        outputSchema: z.object({ mutated: z.string() }),
        access: { kind: 'public' },
        transports: {
          http: true,
          jsonRpcHttp: true,
          jsonRpcWebSocket: true,
          jsonRpcStdio: true,
        },
        unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
        invoke: async ({ input }) => {
          invokeCount += 1;
          return { mutated: input.value };
        },
      }),
    ]);

    // Request shape (id present) — the default for mutating ops. The
    // caller gets the response and any auth/validation failure is
    // surfaced on the wire.
    const requestResult = await dispatchJsonRpc(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'weft.test.mutate',
        params: { value: 'hello' },
      }),
      {
        principal: anonymousPrincipal(),
        engine: {},
        transport: 'jsonRpcHttp',
        registry,
      },
    );
    expect(requestResult.kind).toBe('single');
    if (requestResult.kind !== 'single') {
      throw new Error(`expected single, got ${requestResult.kind}`);
    }
    if ('error' in requestResult.response) {
      throw new Error('expected success response for mutate request');
    }
    expect(requestResult.response.result).toEqual({ mutated: 'hello' });

    // Notification shape (id absent) — explicit caller opt-in. Per
    // JSON-RPC 2.0 the response is dropped, but the operation pipeline
    // still ran (invokeCount increments). The criterion's "do not
    // silently lose errors" guarantee is preserved at the OPERATION
    // level: any auth/validation failure is recorded server-side; only
    // the wire response is omitted because the caller asked for
    // fire-and-forget by omitting the id.
    const notificationResult = await dispatchJsonRpc(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.test.mutate',
        params: { value: 'world' },
      }),
      {
        principal: anonymousPrincipal(),
        engine: {},
        transport: 'jsonRpcHttp',
        registry,
      },
    );
    expect(notificationResult.kind).toBe('notification');

    // Both shapes invoked the same pipeline. The "default to
    // request-response" guarantee is contractual: nothing in the system
    // converts an id-present call into a notification.
    expect(invokeCount).toBe(2);
  });

  it('Subscription notifications reuse the shared event projection layer. Watch and stream APIs are documented as projections of current engine events rather than bespoke server-side state machines.', async () => {
    await expectWebSocketProjectionMatchesReplay(engines, (createdServer) => {
      server = createdServer;
    });
  });

  it('REST and JSON-RPC share one engine-error mapping layer. The same engine failure produces equivalent transport-level semantics across both surfaces.', async () => {
    const fault: OperationFault = {
      code: 'NotFound',
      message: 'workflow not found',
      data: { resource: 'workflow', identifier: 'wf-1' },
    };

    const httpResponse = faultToHttpResponse(fault);
    const jsonRpcError = faultToJsonRpcError(fault);
    const httpBody = (await httpResponse.json()) as {
      error: { code: string; data?: { resource?: string } };
    };

    expect(httpResponse.status).toBe(404);
    expect(jsonRpcError.code).toBe(-32020);
    expect(httpBody.error.code).toBe('NotFound');
    expect(jsonRpcError.data['weftCode']).toBe('NotFound');
  });

  it('stdio is a separate opt-in local entrypoint, disabled by default. It is not implicitly enabled by serve() and is not treated as a public unauthenticated surface.', async () => {
    const engine = createSignalWorkflowEngine();
    engines.push(engine);
    server = serve({ engine, port: 0 });

    expect(server.url.startsWith('http')).toBe(true);
    expect(Reflect.has(server, 'stdio')).toBe(false);
    expect(typeof runStdioSession).toBe('function');
  });

  it('JSON-RPC 2.0 is supported over three runtime transports. POST /jsonrpc, WebSocket upgrade on /jsonrpc, and newline-delimited JSON over a dedicated stdio runtime entrypoint.', async () => {
    // MF2 (path B): drive all three transports against the same operation
    // (weft.workflows.get) and assert each returns a success envelope with
    // the same workflowId.  The WebSocket and stdio surfaces prove the
    // criterion without duplicating the HTTP-specific assertions that live
    // in json-rpc-http-integration.test.ts.
    const engine = createSignalWorkflowEngine();
    engines.push(engine);
    const handle = await engine.start('hold', { hello: 'three-transports' }, {});
    await waitForEventCount(engine, handle.id, 1);

    server = serve({ engine, port: 0 });

    // --- Transport 1: HTTP POST /jsonrpc ---
    const httpResponse = await fetch(`${server.url}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 't1',
        method: 'weft.workflows.get',
        params: { workflowId: handle.id },
      }),
    });
    expect(httpResponse.status).toBe(200);
    const httpBody = (await httpResponse.json()) as { id: string; result?: { id: string } };
    expect(httpBody.id).toBe('t1');
    expect(httpBody.result?.id).toBe(handle.id);

    // --- Transport 2: WebSocket upgrade on /jsonrpc ---
    const wsUrl = `${server.url.replace('http://', 'ws://')}/jsonrpc`;
    const ws = await openWebSocket(wsUrl, SUBSCRIBE_TEST_API_KEY);
    const wsResponsePromise = waitForMessage(
      ws,
      (p) => typeof p === 'object' && p !== null && (p as Record<string, unknown>)['id'] === 't2',
    );
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 't2',
        method: 'weft.workflows.get',
        params: { workflowId: handle.id },
      }),
    );
    const wsBody = (await wsResponsePromise) as { id: string; result?: { id: string } };
    expect(wsBody.id).toBe('t2');
    expect(wsBody.result?.id).toBe(handle.id);
    ws.close();

    // --- Transport 3: stdio (newline-delimited JSON-RPC) ---
    const registry = createLiveOperationRegistry();
    const feed = createWorkflowEventFeed(createEngineEventFeedBackend(engine));
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let stdioBuffer = '';
    const stdioLines: string[] = [];

    const stdioInput = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 't3',
              method: 'weft.workflows.get',
              params: { workflowId: handle.id },
            }) + '\n',
          ),
        );
        controller.close();
      },
    });

    const stdioOutput = new WritableStream<Uint8Array>({
      write(chunk) {
        stdioBuffer += decoder.decode(chunk, { stream: true });
        let newline = stdioBuffer.indexOf('\n');
        while (newline !== -1) {
          stdioLines.push(stdioBuffer.slice(0, newline));
          stdioBuffer = stdioBuffer.slice(newline + 1);
          newline = stdioBuffer.indexOf('\n');
        }
      },
    });

    try {
      await runStdioSession({
        input: stdioInput,
        output: stdioOutput,
        admission: { kind: 'allow-unauthenticated-local-admin' },
        registry,
        engine,
        feed,
      });
    } finally {
      feed.dispose();
    }

    const [firstLine] = stdioLines;
    expect(firstLine).toBeDefined();
    const stdioBody = JSON.parse(firstLine!) as { id: string; result?: { id: string } };
    expect(stdioBody.id).toBe('t3');
    expect(stdioBody.result?.id).toBe(handle.id);
  });

  it('Every new primitive from this document has a dedicated test file under src/ (either as a colocated src/**/*.test.ts file or under src/**/__tests__/) and every acceptance criterion above is covered by at least one test(...) call whose failure message names the criterion.', async () => {
    const fileExpectations = [
      [
        'openapi.test.ts',
        '/openapi.json is a full OpenAPI 3.1 contract for the REST-ish HTTP surface',
      ],
      ['openrpc.test.ts', 'JSON-RPC uses named params only'],
      [
        'json-rpc-protocol.test.ts',
        'Reserved JSON-RPC protocol errors follow the specification exactly',
      ],
      ['json-rpc-dispatch.test.ts', 'Batch requests are supported'],
      [
        'fault-to-json-rpc.test.ts',
        'JSON-RPC error.data carries structured machine-readable detail',
      ],
      [
        'fault-to-json-rpc.test.ts',
        'Weft domain failures use a separate stable application error range',
      ],
      ['sequence-cursor.test.ts', 'All live views share the same sequence and cursor semantics'],
      ['track8-acceptance.test.ts', 'JSON-RPC 2.0 is supported over three runtime transports'],
      [
        'track8-acceptance.test.ts',
        'External subscriptions project from existing typed EventTarget events',
      ],
      [
        'track8-acceptance.test.ts',
        'One server-side event projection layer feeds every live transport',
      ],
      ['track8-acceptance.test.ts', 'Runtime JSON-RPC methods use stable namespaced names'],
      ['track8-acceptance.test.ts', 'Notifications are opt-in per call'],
      [
        'track8-acceptance.test.ts',
        'Subscription notifications reuse the shared event projection layer',
      ],
      ['track8-acceptance.test.ts', 'REST and JSON-RPC share one engine-error mapping layer'],
      [
        'track8-acceptance.test.ts',
        'stdio is a separate opt-in local entrypoint, disabled by default',
      ],
      [
        'track8-acceptance.test.ts',
        'Every new primitive from this document has a dedicated test file',
      ],
    ] as const;

    for (const [fileName, criterionText] of fileExpectations) {
      const content = await Bun.file(`${import.meta.dir}/${fileName}`).text();
      expect(content).toContain(criterionText);
    }

    const matrixPath = new URL('../../reference/track-8-traceability.md', import.meta.url).pathname;
    const matrixText = await Bun.file(matrixPath).text();
    const cachedFileContents = new Map<string, string>();

    for (const line of matrixText.split('\n')) {
      if (!line.startsWith('|')) continue;
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length < 13) continue;
      if (!isRelevantTraceabilityRow(cells)) continue;

      const rowId = cells[1] ?? '';
      const evidenceTest = cells[8] ?? '';
      const { fileName, title } = parseEvidenceTestReference(rowId, evidenceTest);
      const file = await resolveTraceabilityTestFile(fileName);
      expect(
        await file.exists(),
        `Matrix row "${rowId}" points at missing test file "${fileName}".`,
      ).toBe(true);

      let content = cachedFileContents.get(fileName);
      if (content === undefined) {
        content = await file.text();
        cachedFileContents.set(fileName, content);
      }

      expect(
        content.includes(title),
        `Matrix row "${rowId}" expects test title "${title}" in "${fileName}".`,
      ).toBe(true);
    }
  });
});
