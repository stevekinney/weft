import { WEFT_SCOPE_VOCABULARY } from '../authorization-scopes.ts';
/**
 * `rpc.discover` on an engine-hosted Weft server lists a registered workflow's MCP tool, over each
 * JSON-RPC transport (HTTP, WebSocket and stdio), and carries Weft's own document title and version
 * (COR-2472).
 *
 * The document is produced for the transport's host: the HTTP, WebSocket and stdio entry points
 * Weft's server composes each get the engine's live tool list, so a method that names a workflow's
 * tool resolves to it. A host without an engine lists no tools, and a method that needs one is a
 * missing-metadata error rather than a silently wrong document.
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createWeftDiscoverDocument } from './weft-documents.ts';

import { defineOperation } from "../embedded/backchannel/src/index.ts";
import {
  createOperationRegistry,
  type JsonRpcWebSocketSession,
  type OperationRegistry,
  runStdioSession,
} from "../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { Engine } from '../core/engine.ts';
import { workflow } from '../core/types.ts';
import { VERSION } from '../version.ts';
import { createInMemoryEventBackend } from './in-memory-event-feed-backend.test-support.ts';
import { handleJsonRpcHttpRequestSafely } from './json-rpc-transport-helpers.ts';
import { openJsonRpcWebSocketSession, type WebSocketData } from './json-rpc-websocket-runtime.ts';
import { collectingWritable, readableFromLines } from './stdio-stream.test-support.ts';
import { createWorkflowEventFeed } from './workflow-event-feed.ts';

function createCheckoutEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(
    workflow({
      name: 'checkout_flow',
      inputSchema: z.object({ orderId: z.string() }),
    }).execute(async function* () {
      yield { ok: true };
    }),
  );
  return engine;
}

/** A registry whose one method starts the engine's `checkout_flow` workflow as an MCP tool. */
function createCheckoutRegistry(): OperationRegistry {
  return createOperationRegistry([
    defineOperation({
      name: 'weft.workflows.checkout.start',
      mcpExposable: true,
      mcpTool: { workflowType: 'checkout_flow' },
      destructive: false,
      summary: 'Start checkout',
      tags: [],
      access: { kind: 'public' },
      inputSchema: z.object({ orderId: z.string() }),
      outputSchema: z.object({ workflowId: z.string() }),
      transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      discoverable: true,
      invoke: async () => ({ workflowId: 'unused' }),
    }),
  ]);
}

const DISCOVER_REQUEST = { jsonrpc: '2.0', id: 'discover', method: 'rpc.discover', params: {} };

type DiscoverDocument = {
  info?: { title?: string; version?: string };
  'x-weft-mcp'?: unknown;
  methods?: Array<{ name: string; 'x-weft-mcp'?: unknown }>;
};

function expectCheckoutTool(document: DiscoverDocument | undefined): void {
  expect(document?.info?.title).toBe('Weft Workflow Engine');
  expect(document?.info?.version).toBe(VERSION);
  expect(document?.['x-weft-mcp']).toEqual({
    discoveryPath: '/.well-known/mcp.json',
    toolDiscoveryMethod: 'tools/list',
    toolNames: ['checkout_flow'],
  });
  const method = document?.methods?.find(
    (candidate) => candidate.name === 'weft.workflows.checkout.start',
  );
  expect(method?.['x-weft-mcp']).toEqual({
    workflowType: 'checkout_flow',
    toolName: 'checkout_flow',
    toolDiscovery: { method: 'tools/list', source: 'live' },
  });
}

describe('rpc.discover lists a workflow MCP tool on an engine-hosted server', () => {
  it('over HTTP', async () => {
    using engine = createCheckoutEngine();
    const response = await handleJsonRpcHttpRequestSafely({
      request: new Request('http://weft.test/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(DISCOVER_REQUEST),
      }),
      registry: createCheckoutRegistry(),
      engine,
      authContext: undefined,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { error?: unknown; result?: DiscoverDocument };
    expect(body.error).toBeUndefined();
    expectCheckoutTool(body.result);
  });

  it('over WebSocket', async () => {
    using engine = createCheckoutEngine();
    const sent: string[] = [];
    const data: WebSocketData = { pathname: '/jsonrpc', connectionType: 'jsonrpc' };
    const activeSessions = new Set<JsonRpcWebSocketSession>();
    openJsonRpcWebSocketSession({
      ws: {
        data,
        send: (message: string) => {
          sent.push(message);
          return message.length;
        },
        close: () => undefined,
      },
      registry: createCheckoutRegistry(),
      engine,
      feed: createWorkflowEventFeed(createInMemoryEventBackend()),
      activeSessions,
    });
    const session = data.jsonRpcSession;
    expect(session).toBeDefined();
    await session!.handleMessage(JSON.stringify(DISCOVER_REQUEST));
    await session!.close();
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0]!) as { error?: unknown; result?: DiscoverDocument };
    expect(body.error).toBeUndefined();
    expectCheckoutTool(body.result);
  });

  it('over stdio', async () => {
    using engine = createCheckoutEngine();
    const output = collectingWritable();
    const result = await runStdioSession({
      scopeVocabulary: WEFT_SCOPE_VOCABULARY,
      input: readableFromLines([`${JSON.stringify(DISCOVER_REQUEST)}\n`]),
      output: output.stream,
      admission: { kind: 'allow-unauthenticated-local-admin' },
      registry: createCheckoutRegistry(),
      engine,
      discoverDocument: createWeftDiscoverDocument(createCheckoutRegistry(), engine),
      feed: createWorkflowEventFeed(createInMemoryEventBackend()),
    });
    expect(result.exitCode).toBe(0);
    const lines = output.lines();
    expect(lines).toHaveLength(1);
    const body = JSON.parse(lines[0]!) as { error?: unknown; result?: DiscoverDocument };
    expect(body.error).toBeUndefined();
    expectCheckoutTool(body.result);
  });
});
