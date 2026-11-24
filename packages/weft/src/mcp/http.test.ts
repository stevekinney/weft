import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';
import { WEFT_SCOPE_VOCABULARY } from '../authorization-scopes.ts';

import { anonymousPrincipal, principalFromJwtClaims } from "../embedded/backchannel/src/index.ts";
import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { waitForCondition } from "../../test-support/embedded/testing/src/fake-timers.ts";
import { HANG_GUARD_MILLISECONDS, afterAwakeTime } from "../../test-support/embedded/testing/src/hang-guard.ts";
import { rejectionOf, throwingRejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { Engine } from '../core/engine.ts';
import { activity, type DefinitionSchema, type WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types/workflow-function.ts';
import { serve, type WeftServer } from '../server/index.ts';
import { createMcpEndpoint, handleMcpHttpRequest, type McpEndpoint } from './http.ts';
import { connectInProcessClient, readJsonRpcResponse } from './mcp-client.test-support.ts';
import { MCP_LEGACY_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION } from './protocol.ts';
import { callMcpTool, listMcpTools } from './tools.ts';

const enginesToDispose: Engine[] = [];

type JsonRpcEnvelope = {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type ToolCallResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function createEngine(): Engine {
  const engine = new Engine({
    storage: new MemoryStorage(),
  });
  enginesToDispose.push(engine);

  const greetCustomer = workflow({
    name: 'greet-customer',
    description: 'Greet a customer by name.',
    inputSchema: z.object({
      accountId: z.string().optional(),
      name: z.string(),
    }),
  }).execute(async function* (_context: WorkflowContext, input: { name: string }) {
    return { message: `Hello, ${input.name}!` };
  });
  engine.register(greetCustomer);

  const holdForCancel = workflow({
    name: 'hold-for-cancel',
    description: 'Wait for a release signal.',
    inputSchema: z.object({
      accountId: z.string().optional(),
      label: z.string().optional(),
    }),
  }).execute(async function* (
    context: WorkflowContext,
    input: { accountId?: string | undefined; label?: string | undefined },
  ) {
    let label = input.label ?? 'initial';
    context.onQuery('label', () => label);
    context.onUpdate('setLabel', (payload) => {
      label = typeof payload === 'string' ? payload : 'updated';
      return label;
    });
    const released = yield* context.waitForSignal<string>('release');
    return { label, released };
  });
  engine.register(holdForCancel);

  const timeoutMsInput = workflow({
    name: 'timeout-ms-input',
    description: 'Echo a workflow input that includes a timeoutMs field.',
    inputSchema: z.object({
      label: z.string().optional(),
      timeoutMs: z.number(),
      wait: z.boolean().optional(),
    }),
  }).execute(async function* (
    context: WorkflowContext,
    input: { label?: string | undefined; timeoutMs: number; wait?: boolean | undefined },
  ) {
    context.onQuery('input', () => input);
    if (input.wait === true) {
      yield* context.waitForSignal('release');
    }
    return input;
  });
  engine.register(timeoutMsInput);

  const hiddenNoSchema = workflow({ name: 'hidden-no-schema' }).execute(async function* () {
    return 'hidden';
  });
  engine.register(hiddenNoSchema);

  engine.register(activity({ name: 'internal-only-activity', execute: async () => 'not exposed' }));

  return engine;
}

function trackEngine(engine: Engine): Engine {
  enginesToDispose.push(engine);
  return engine;
}

async function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: 'running' | 'completed' | 'cancelled',
): Promise<void> {
  await waitForCondition(
    async () => {
      const state = await engine.get(workflowId);
      return state?.status === status;
    },
    { intervalMs: 10, label: `workflow ${workflowId} to reach ${status}` },
  );
}

// A 2025-era client on the SDK's stateless legacy lane: every request is one
// POST that names the negotiated revision, with no session to create or carry.
async function initialize(server: WeftServer): Promise<void> {
  const response = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: legacyHeaders(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'weft-test-client', version: '1.0.0' },
      },
    }),
  });

  expect(response.status).toBe(200);
  // The stateless lane keeps no session, so it names none.
  expect(response.headers.get('Mcp-Session-Id')).toBeNull();
  const body = (await readJsonRpcResponse(response)) as JsonRpcEnvelope;
  expect(body.error).toBeUndefined();
  expect(body.result).toMatchObject({
    protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
    capabilities: {
      tools: expect.any(Object),
      resources: expect.any(Object),
    },
    serverInfo: { name: 'weft' },
  });
  // The stateless lane keeps no instance to deliver `notifications/tools/list_changed` from, and
  // the SDK's stateless legacy handler advertises neither it nor resource subscriptions.
  const { capabilities } = body.result as { capabilities: { tools: { listChanged?: boolean } } };
  expect(capabilities.tools.listChanged).not.toBe(true);
}

function legacyHeaders(headers?: HeadersInit): Headers {
  const requestHeaders = new Headers({
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'Mcp-Protocol-Version': MCP_LEGACY_PROTOCOL_VERSION,
  });
  for (const [name, value] of new Headers(headers)) requestHeaders.set(name, value);
  return requestHeaders;
}

async function mcpPost(
  server: WeftServer,
  message: Record<string, unknown>,
  headers?: HeadersInit,
): Promise<Response> {
  return fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: legacyHeaders(headers),
    body: JSON.stringify(message),
  });
}

async function mcpJson(
  server: WeftServer,
  message: Record<string, unknown>,
  headers?: HeadersInit,
): Promise<JsonRpcEnvelope> {
  const response = await mcpPost(server, message, headers);
  expect(response.status).toBe(200);
  return (await readJsonRpcResponse(response)) as JsonRpcEnvelope;
}

async function connectModernClient(server: WeftServer): Promise<Client> {
  const client = new Client(
    { name: 'weft-test-client', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  return client;
}

function waitForResourceUpdate(client: Client, uri: string): Promise<string> {
  return resolveWithin(
    new Promise<string>((resolve) => {
      client.setNotificationHandler('notifications/resources/updated', (notification) => {
        if (notification.params.uri === uri) resolve(notification.params.uri);
      });
    }),
    { label: `resources/updated for ${uri}` },
  );
}

function parseToolText(result: unknown): unknown {
  const toolResult = result as ToolCallResult;
  expect(toolResult.isError).not.toBe(true);
  expect(toolResult.content[0]?.type).toBe('text');
  return JSON.parse(toolResult.content[0]!.text);
}

/**
 * Resolves with `promise`, or fails naming `label` once the awake-time hang guard elapses: the wait
 * ends on the result, never on a count of milliseconds a loaded host can overrun.
 */
async function resolveWithin<T>(promise: Promise<T>, options: { label: string }): Promise<T> {
  let cancel = (): void => undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        cancel = afterAwakeTime(HANG_GUARD_MILLISECONDS, () =>
          reject(new Error(`${options.label} did not resolve before the hang guard elapsed`)),
        );
      }),
    ]);
  } finally {
    cancel();
  }
}

function countingDefinitionSchema<TInput = unknown>(
  onInputConversion: () => void,
): DefinitionSchema<unknown, TInput> {
  return {
    '~standard': {
      version: 1,
      vendor: 'counting-test',
      jsonSchema: {
        input: () => {
          onInputConversion();
          return {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          };
        },
        output: () => ({ type: 'object' }),
      },
    },
  };
}

describe('MCP Streamable HTTP transport', () => {
  let server: WeftServer | undefined;
  const endpointsToDispose: McpEndpoint[] = [];

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    for (const endpoint of endpointsToDispose.splice(0)) {
      await endpoint[Symbol.asyncDispose]();
    }
    for (const engine of enginesToDispose.splice(0)) {
      engine[Symbol.dispose]();
    }
  });

  function trackEndpoint(endpoint: McpEndpoint): McpEndpoint {
    endpointsToDispose.push(endpoint);
    return endpoint;
  }

  it('initializes, lists tools, calls a registered workflow tool, and hides activities', async () => {
    const engine = createEngine();
    server = serve({ engine, port: 0 });
    await initialize(server);

    const tools = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'tools',
      method: 'tools/list',
      params: {},
    });

    const names = ((tools.result as { tools: Array<{ name: string }> }).tools ?? []).map(
      (tool) => tool.name,
    );
    expect(names).toContain('greet_customer');
    expect(names).toContain('start_workflow');
    expect(names).toContain('signal_workflow');
    expect(names).toContain('query_workflow');
    expect(names).toContain('cancel_workflow');
    expect(names).toContain('get_workflow_state');
    expect(names).not.toContain('internal_only_activity');
    expect(names).not.toContain('hidden_no_schema');

    const greetTool = (
      tools.result as { tools: Array<{ name: string; inputSchema: unknown }> }
    ).tools.find((tool) => tool.name === 'greet_customer');
    expect(greetTool?.inputSchema).toMatchObject({
      type: 'object',
      required: ['input'],
      properties: expect.objectContaining({
        input: expect.objectContaining({
          properties: expect.objectContaining({ name: expect.any(Object) }),
        }),
      }),
    });

    const called = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'call',
      method: 'tools/call',
      params: { name: 'greet_customer', arguments: { input: { name: 'Ada' } } },
    });

    expect(parseToolText(called.result)).toMatchObject({
      result: { message: 'Hello, Ada!' },
      workflowId: expect.any(String),
    });

    const started = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'start-control',
      method: 'tools/call',
      params: {
        name: 'start_workflow',
        arguments: {
          type: 'hold-for-cancel',
          id: 'mcp-control-workflow',
          input: { label: 'initial-label' },
        },
      },
    });
    expect(parseToolText(started.result)).toEqual({ workflowId: 'mcp-control-workflow' });
    await waitForStatus(engine, 'mcp-control-workflow', 'running');

    const queried = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'query-control',
      method: 'tools/call',
      params: {
        name: 'query_workflow',
        arguments: { workflowId: 'mcp-control-workflow', queryName: 'label' },
      },
    });
    expect(parseToolText(queried.result)).toEqual({ result: 'initial-label' });

    const updated = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'update-control',
      method: 'tools/call',
      params: {
        name: 'update_workflow',
        arguments: {
          workflowId: 'mcp-control-workflow',
          updateName: 'setLabel',
          payload: 'updated-label',
        },
      },
    });
    expect(parseToolText(updated.result)).toEqual({ result: 'updated-label' });

    const signalled = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'signal-control',
      method: 'tools/call',
      params: {
        name: 'signal_workflow',
        arguments: { workflowId: 'mcp-control-workflow', signalName: 'release', payload: 'done' },
      },
    });
    expect(parseToolText(signalled.result)).toEqual({ ok: true });
    await waitForStatus(engine, 'mcp-control-workflow', 'completed');

    const state = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'get-control',
      method: 'tools/call',
      params: { name: 'get_workflow_state', arguments: { workflowId: 'mcp-control-workflow' } },
    });
    expect(parseToolText(state.result)).toMatchObject({
      id: 'mcp-control-workflow',
      status: 'completed',
    });

    const failedToolCall = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'bad-tool-call',
      method: 'tools/call',
      params: { name: 'get_workflow_state', arguments: {} },
    });
    expect(failedToolCall.error).toBeUndefined();
    expect((failedToolCall.result as ToolCallResult).isError).toBe(true);
  });

  it('reuses the converted tool registry until workflow definitions change', async () => {
    const engine = trackEngine(new Engine({ storage: new MemoryStorage() }));
    let inputConversions = 0;
    const countedTool = workflow({
      name: 'counted-tool',
      inputSchema: countingDefinitionSchema<{ name?: string }>(() => {
        inputConversions += 1;
      }),
    }).execute(async function* (_context: WorkflowContext, input: { name?: string }) {
      return { message: `Hello, ${input.name ?? 'there'}!` };
    });
    engine.register(countedTool);
    server = serve({ engine, port: 0 });
    await initialize(server);

    await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'first-list',
      method: 'tools/list',
      params: {},
    });
    await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'second-list',
      method: 'tools/list',
      params: {},
    });
    expect(inputConversions).toBe(1);

    const called = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'call-counted-tool',
      method: 'tools/call',
      params: { name: 'counted_tool', arguments: { input: { name: 'Ada' } } },
    });
    expect(parseToolText(called.result)).toMatchObject({
      result: { message: 'Hello, Ada!' },
    });
    // `engine.start()` is the first `await` boundary reached for
    // 'counted-tool' since registration, so it also drains the workflow
    // catalog (WFT-9/WFT-10) — building the workflow's manifest once, which
    // converts its inputSchema once more, independent of the MCP tool
    // registry's own conversion cache above.
    expect(inputConversions).toBe(2);

    const lateTool = workflow({
      name: 'late-tool',
      inputSchema: countingDefinitionSchema(() => {
        inputConversions += 1;
      }),
    }).execute(async function* () {
      return { ok: true };
    });
    engine.register(lateTool);

    const afterRegistration = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'after-registration',
      method: 'tools/list',
      params: {},
    });
    const names = (
      (afterRegistration.result as { tools: Array<{ name: string }> }).tools ?? []
    ).map((tool) => tool.name);
    expect(names).toContain('late_tool');
    // +1 more than the pre-catalog baseline of 3 (the +2 definitions-changed
    // rebuild reconverting both tools, on top of the +2 already reached
    // above) — see the comment at the `tools/call` assertion above.
    expect(inputConversions).toBe(4);
  });

  it('does not let broken activity schemas break MCP workflow tools', async () => {
    const engine = createEngine();
    engine.register(
      activity({
        name: 'broken-activity',
        execute: async () => undefined,
        inputSchema: makeBrokenSchema('activity'),
      }),
    );
    server = serve({ engine, port: 0 });
    await initialize(server);

    const tools = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'tools-with-broken-activity',
      method: 'tools/list',
      params: {},
    });

    const names = ((tools.result as { tools: Array<{ name: string }> }).tools ?? []).map(
      (tool) => tool.name,
    );
    expect(names).toContain('greet_customer');
    expect(names).not.toContain('broken_activity');
  });

  it('masks unexpected workflow tool failures while preserving domain errors', async () => {
    const engine = createEngine();
    const explodeSecretly = workflow({
      name: 'explode-secretly',
      inputSchema: z.object({}),
    }).execute(async function* () {
      throw new Error('secret implementation detail');
    });
    engine.register(explodeSecretly);

    const result = await callMcpTool(
      'explode_secretly',
      {},
      { engine, principal: anonymousPrincipal(), authRequired: false },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('Tool execution failed');
  });

  it('shapes unknown and malformed workflow-tool arguments as tool errors', async () => {
    const engine = createEngine();
    const context = { engine, principal: anonymousPrincipal(), authRequired: false };

    expect(await callMcpTool('missing_tool', {}, context)).toMatchObject({
      isError: true,
      content: [{ text: 'Unknown tool: missing_tool' }],
    });
    expect(await callMcpTool('start_workflow', [], context)).toMatchObject({
      isError: true,
      content: [{ text: 'Tool arguments must be a JSON object' }],
    });
    expect(await callMcpTool('greet_customer', [], context)).toMatchObject({
      isError: true,
      content: [{ text: 'Tool arguments must be a JSON object' }],
    });
    // The SDK validates arguments against the tool's schema before a call
    // reaches Weft; Weft's own checks still answer a direct call.
    expect(await callMcpTool('get_workflow_state', {}, context)).toMatchObject({
      isError: true,
      content: [{ text: 'Tool argument "workflowId" must be a non-empty string' }],
    });
    expect(
      await callMcpTool('greet_customer', { input: { name: 'Ada' }, timeoutMs: 0 }, context),
    ).toMatchObject({
      isError: true,
      content: [{ text: 'Tool argument "timeoutMs" must be an integer from 1 to 2147483647' }],
    });
  });

  it('cancels a workflow when the request is cancelled after start', async () => {
    const engine = createEngine();
    const request = new AbortController();
    const originalStart = engine.start.bind(engine);
    let startedId = '';
    engine.start = async (...argumentsValue: Parameters<Engine['start']>) => {
      const handle = await originalStart(...argumentsValue);
      startedId = handle.id;
      request.abort();
      return handle;
    };

    const result = await callMcpTool(
      'hold_for_cancel',
      { input: { label: 'cancel-after-start' } },
      { engine, principal: anonymousPrincipal(), authRequired: false, signal: request.signal },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Workflow cancelled' }],
    });
    await waitForStatus(engine, startedId, 'cancelled');
  });

  it('shapes a workflow result cancellation error as a tool error', async () => {
    const engine = createEngine();
    const originalStart = engine.start.bind(engine);
    engine.start = async (...argumentsValue: Parameters<Engine['start']>) => {
      const handle = await originalStart(...argumentsValue);
      handle.result = async () => {
        throw new Error('Workflow cancelled');
      };
      return handle;
    };

    const result = await callMcpTool(
      'greet_customer',
      { input: { name: 'Ada' } },
      { engine, principal: anonymousPrincipal(), authRequired: false },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Workflow cancelled' }],
    });
  });

  it('lists and cancels workflows through the built-in tools', async () => {
    const engine = createEngine();
    server = serve({ engine, port: 0 });
    await initialize(server);
    const handle = await engine.start('hold-for-cancel', { label: 'built-in-tools' });
    await waitForStatus(engine, handle.id, 'running');

    const listed = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'list-workflows',
      method: 'tools/call',
      params: { name: 'list_workflows', arguments: { status: 'running' } },
    });
    expect(parseToolText(listed.result)).toMatchObject({
      items: [expect.objectContaining({ id: handle.id, status: 'running' })],
    });

    const invalidList = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'invalid-list-workflows',
      method: 'tools/call',
      params: { name: 'list_workflows', arguments: { limit: -1 } },
    });
    expect(invalidList.result).toMatchObject({
      isError: true,
      content: [{ text: 'List filter limit must be a non-negative integer' }],
    });

    const cancelled = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'cancel-workflow',
      method: 'tools/call',
      params: { name: 'cancel_workflow', arguments: { workflowId: handle.id } },
    });
    expect(parseToolText(cancelled.result)).toEqual({ ok: true });
    await waitForStatus(engine, handle.id, 'cancelled');
  });

  it('uses fallback names and reports workflow schema conversion failures', async () => {
    const engine = trackEngine(new Engine({ storage: new MemoryStorage() }));
    engine.register(
      workflow({ name: '_', inputSchema: z.object({}) }).execute(async function* () {
        return { ok: true };
      }),
    );
    expect(listMcpTools(engine).map((tool) => tool.name)).toContain('workflow_unnamed');

    const brokenEngine = trackEngine(new Engine({ storage: new MemoryStorage() }));
    brokenEngine.register(
      workflow({
        name: 'broken-workflow-schema',
        inputSchema: makeBrokenSchema('workflow'),
      }).execute(async function* () {
        return { ok: true };
      }),
    );
    expect(() => listMcpTools(brokenEngine)).toThrow();
  });

  it('reads workflow resources and emits resource update notifications for subscriptions', async () => {
    const engine = createEngine();
    server = serve({ engine, port: 0 });
    await initialize(server);

    const handle = await engine.start('hold-for-cancel', { label: 'resource-test' });
    const encodedHandle = await engine.start(
      'hold-for-cancel',
      { label: 'encoded-resource-test' },
      { id: 'workflow with spaces' },
    );
    await waitForStatus(engine, handle.id, 'running');
    await waitForStatus(engine, encodedHandle.id, 'running');
    const uri = `weft://workflows/${handle.id}/state`;
    const encodedUri = `weft://workflows/${encodeURIComponent(encodedHandle.id)}/state`;

    const resources = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'resources-list',
      method: 'resources/list',
      params: {},
    });
    const resourceUris = (
      (resources.result as { resources: Array<{ uri: string }> }).resources ?? []
    ).map((resource) => resource.uri);
    expect(resourceUris).toContain(encodedUri);
    expect(resourceUris).not.toContain(`weft://workflows/${encodedHandle.id}/state`);

    const read = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'read',
      method: 'resources/read',
      params: { uri },
    });

    const contents = (read.result as { contents: Array<{ uri: string; text: string }> }).contents;
    expect(contents[0]?.uri).toBe(uri);
    expect(JSON.parse(contents[0]!.text)).toMatchObject({
      id: handle.id,
      status: 'running',
    });

    const encodedRead = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'read-encoded',
      method: 'resources/read',
      params: { uri: encodedUri },
    });
    const encodedContents = (encodedRead.result as { contents: Array<{ text: string }> }).contents;
    expect(JSON.parse(encodedContents[0]!.text)).toMatchObject({
      id: encodedHandle.id,
      status: 'running',
    });

    const events = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'events',
      method: 'resources/read',
      params: { uri: `weft://workflows/${handle.id}/events` },
    });
    const eventContents = (events.result as { contents: Array<{ text: string }> }).contents;
    expect(JSON.parse(eventContents[0]!.text)).toMatchObject({ events: expect.any(Array) });

    const checkpoints = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'checkpoints',
      method: 'resources/read',
      params: { uri: `weft://workflows/${handle.id}/checkpoints` },
    });
    const checkpointContents = (checkpoints.result as { contents: Array<{ text: string }> })
      .contents;
    expect(JSON.parse(checkpointContents[0]!.text)).toMatchObject({
      checkpoints: expect.any(Array),
    });

    const search = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'search',
      method: 'resources/read',
      params: { uri: 'weft://workflows/search?status=running&type=hold-for-cancel' },
    });
    const searchContents = (search.result as { contents: Array<{ text: string }> }).contents;
    expect(JSON.parse(searchContents[0]!.text)).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: handle.id })]),
    });

    // The stateless 2025-era lane keeps no stream to push updates on, so it
    // does not offer subscriptions; a 2026-07-28 client subscribes through
    // `subscriptions/listen`.
    const legacySubscribe = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'subscribe',
      method: 'resources/subscribe',
      params: { uri },
    });
    expect(legacySubscribe.error).toBeDefined();

    const client = await connectModernClient(server);
    try {
      const updated = waitForResourceUpdate(client, uri);
      await client.listen({ resourceSubscriptions: [uri] });

      await engine.signal(handle.id, 'release', 'done');
      await waitForStatus(engine, handle.id, 'completed');
      expect(await updated).toBe(uri);
    } finally {
      await client.close();
    }
  });

  it('notifies subscribed search resources when workflow visibility changes', async () => {
    const engine = createEngine();
    server = serve({ engine, port: 0 });
    const handle = await engine.start(
      'hold-for-cancel',
      { label: 'search-subscription' },
      { id: 'search-subscription-workflow' },
    );
    const searchUri = 'weft://workflows/search?status=running&type=hold-for-cancel';

    const client = await connectModernClient(server);
    try {
      const updated = waitForResourceUpdate(client, searchUri);
      await client.listen({ resourceSubscriptions: [searchUri] });

      await engine.signal(handle.id, 'release', 'done');
      await waitForStatus(engine, handle.id, 'completed');
      expect(await updated).toBe(searchUri);
    } finally {
      await client.close();
    }
  });

  it('notifies search resource subscribers when the changed workflow no longer loads', async () => {
    const engine = createEngine();
    const endpoint = trackEndpoint(createMcpEndpoint(engine));
    const searchUri = 'weft://workflows/search?status=completed&type=hold-for-cancel';
    const { client } = await connectInProcessClient(endpoint, { pin: MCP_PROTOCOL_VERSION });
    try {
      const updated = waitForResourceUpdate(client, searchUri);
      await client.listen({ resourceSubscriptions: [searchUri] });

      const originalGet = engine.get.bind(engine);
      engine.get = async (workflowId: string) => {
        if (workflowId === 'deleted-workflow') return null;
        return originalGet(workflowId);
      };

      engine.dispatchEvent(
        Object.assign(new Event('workflow:completed'), { workflowId: 'deleted-workflow' }),
      );

      expect(await updated).toBe(searchUri);
    } finally {
      await client.close();
    }
  });

  it('honors workflow tool cancellation observed before engine.start writes state', async () => {
    const engine = createEngine();
    const request = new AbortController();
    request.abort();

    const result = await callMcpTool(
      'hold_for_cancel',
      { input: { label: 'cancel-before-start' } },
      { engine, principal: anonymousPrincipal(), authRequired: false, signal: request.signal },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('cancelled');
    expect(await engine.list({ type: 'hold-for-cancel' })).toMatchObject({
      total: 0,
      items: [],
    });
  });

  it('returns a running result when a per-workflow MCP tool call reaches timeoutMs', async () => {
    const engine = createEngine();
    server = serve({ engine, port: 0 });
    await initialize(server);
    let workflowId = '';
    const pendingCall = mcpJson(server, {
      jsonrpc: '2.0',
      id: 'timeout-tool-call',
      method: 'tools/call',
      params: {
        name: 'hold_for_cancel',
        arguments: { input: { label: 'timeout-me' }, timeoutMs: 5 },
      },
    });

    try {
      const response = await resolveWithin(pendingCall, {
        label: 'timed-out MCP workflow tool call',
      });
      const toolResult = response.result as ToolCallResult;
      expect(toolResult.isError).toBe(false);
      const payload = parseToolText(response.result) as {
        workflowId: string;
        status: string;
        timedOut: boolean;
        message: string;
        followUp: { tool: string; arguments: { workflowId: string } };
      };
      workflowId = payload.workflowId;
      expect(payload).toMatchObject({
        workflowId: expect.any(String),
        status: 'running',
        timedOut: true,
        message: expect.stringContaining('get_workflow_state'),
        followUp: {
          tool: 'get_workflow_state',
          arguments: { workflowId },
        },
      });
      await waitForStatus(engine, workflowId, 'running');
    } finally {
      if (workflowId.length === 0) {
        const list = await engine.list({ type: 'hold-for-cancel' });
        workflowId = list.items.find((item) => item.status === 'running')?.id ?? '';
      }
      if (workflowId.length > 0) {
        await engine.cancel(workflowId).catch(() => {});
      }
      pendingCall.catch(() => {});
    }
  });

  it('keeps workflow input timeoutMs separate from MCP tool timeoutMs', async () => {
    const engine = createEngine();
    server = serve({ engine, port: 0 });
    await initialize(server);

    const completed = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'timeout-input-completed',
      method: 'tools/call',
      params: {
        name: 'timeout_ms_input',
        arguments: {
          input: { timeoutMs: 123, label: 'workflow-input' },
          timeoutMs: 10_000,
        },
      },
    });

    expect(parseToolText(completed.result)).toMatchObject({
      result: { timeoutMs: 123, label: 'workflow-input' },
      workflowId: expect.any(String),
    });

    const pendingCall = mcpJson(server, {
      jsonrpc: '2.0',
      id: 'timeout-input-running',
      method: 'tools/call',
      params: {
        name: 'timeout_ms_input',
        arguments: {
          input: { timeoutMs: 456, label: 'parked', wait: true },
          timeoutMs: 5,
        },
      },
    });

    const response = await resolveWithin(pendingCall, {
      label: 'timed-out MCP workflow tool call with timeoutMs input',
    });
    const payload = parseToolText(response.result) as { workflowId: string; timedOut: boolean };
    expect(payload.timedOut).toBe(true);
    await waitForStatus(engine, payload.workflowId, 'running');
    expect(await engine.query(payload.workflowId, 'input')).toEqual({
      timeoutMs: 456,
      label: 'parked',
      wait: true,
    });
    await engine.signal(payload.workflowId, 'release', 'done');
  });

  it('cancels the workflow when a 2026-07-28 client cancels an in-flight workflow tool call', async () => {
    const engine = createEngine();
    server = serve({ engine, port: 0 });
    const client = await connectModernClient(server);
    const request = new AbortController();

    const pendingCall = client.callTool(
      { name: 'hold_for_cancel', arguments: { input: { label: 'cancel-me' } } },
      { signal: request.signal },
    );
    pendingCall.catch(() => {});

    try {
      const workflowId = await runningHoldForCancel(engine);
      // 2026-07-28 cancellation closes the request's own response stream; the
      // SDK aborts the handler, and the tool cancels the workflow it started.
      request.abort();
      await waitForStatus(engine, workflowId, 'cancelled');
    } finally {
      await client.close();
    }
  });

  it('stops awaiting the workflow result when the request is cancelled', async () => {
    const engine = createEngine();
    const originalCancel = engine.cancel.bind(engine);
    const cancelledWorkflowIds: string[] = [];
    engine.cancel = async (workflowId: string) => {
      cancelledWorkflowIds.push(workflowId);
      return { workflowId, status: 'cancel-requested' };
    };
    const request = new AbortController();
    let workflowId = '';

    const pendingCall = callMcpTool(
      'hold_for_cancel',
      { input: { label: 'abort-me' }, timeoutMs: 30_000 },
      { engine, principal: anonymousPrincipal(), authRequired: false, signal: request.signal },
    );

    try {
      workflowId = await runningHoldForCancel(engine);
      request.abort();

      const toolResult = await resolveWithin(pendingCall, {
        label: 'cancelled MCP workflow tool call',
      });
      expect(toolResult.isError).toBe(true);
      expect(toolResult.content[0]?.text).toContain('cancelled');
      expect(cancelledWorkflowIds).toEqual([workflowId]);
      await waitForStatus(engine, workflowId, 'running');
    } finally {
      engine.cancel = originalCancel;
      if (workflowId.length > 0) {
        await originalCancel(workflowId).catch(() => {});
      }
      pendingCall.catch(() => {});
    }
  });

  it('reports a failed workflow cancellation without failing the cancelled call', async () => {
    const engine = createEngine();
    const originalCancel = engine.cancel.bind(engine);
    engine.cancel = async () => {
      throw new Error('cancel refused');
    };
    const warnings: unknown[][] = [];
    const warnSpy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args);
    });
    const request = new AbortController();
    let workflowId = '';
    try {
      const pendingCall = callMcpTool(
        'hold_for_cancel',
        { input: { label: 'cancel-refused' } },
        { engine, principal: anonymousPrincipal(), authRequired: false, signal: request.signal },
      );
      workflowId = await runningHoldForCancel(engine);
      request.abort();
      const toolResult = await pendingCall;
      expect(toolResult).toMatchObject({
        isError: true,
        content: [{ text: 'Workflow cancelled' }],
      });
      await waitForCondition(() => warnings.length > 0, {
        intervalMs: 10,
        label: 'cancellation failure warning',
      });
      expect(warnings[0]?.[0]).toBe('MCP workflow tool cancellation failed:');
    } finally {
      warnSpy.mockRestore();
      engine.cancel = originalCancel;
      if (workflowId.length > 0) await originalCancel(workflowId).catch(() => {});
    }
  });

  it('accepts cancellation notifications on the stateless 2025-era lane and keeps serving', async () => {
    const engine = createEngine();
    server = serve({ engine, port: 0 });
    await initialize(server);

    // A well-formed cancellation for a request this lane is not running is
    // acknowledged; a malformed one is refused by the SDK's message validation.
    const notInFlight = await mcpPost(server, {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'not-in-flight', reason: 'stateless' },
    });
    expect(notInFlight.status).toBe(202);
    const malformed = await mcpPost(server, {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: [],
    });
    expect(malformed.status).toBe(400);

    const tools = await mcpJson(server, {
      jsonrpc: '2.0',
      id: 'tools-after-invalid-notification',
      method: 'tools/list',
      params: {},
    });
    expect((tools.result as { tools: Array<{ name: string }> }).tools.length).toBeGreaterThan(0);
  });

  it('denies anonymous direct-handler requests when authentication is required', async () => {
    const engine = createEngine();
    const endpoint = trackEndpoint(createMcpEndpoint(engine));

    for (const message of [
      {
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: {
          protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'weft-test-client', version: '1.0.0' },
        },
      },
      { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} },
    ]) {
      const response = await handleMcpHttpRequest({
        request: jsonRequest(message),
        endpoint,
        authRequired: true,
      });
      expect(response.status).toBe(401);
      const refused = await readJsonRpcResponse(response);
      expect(refused.error).toMatchObject({
        code: -32011,
        message: 'MCP request requires authentication',
      });
    }

    const authenticated = await handleMcpHttpRequest({
      request: jsonRequest({ jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} }),
      endpoint,
      principal: principalFromJwtClaims(
        { sub: 'reader', scope: 'workflows:read' },
        { scopeVocabulary: WEFT_SCOPE_VOCABULARY },
      ),
      authRequired: true,
    });
    expect(authenticated.status).toBe(200);
    const authenticatedBody = await readJsonRpcResponse(authenticated);
    expect(authenticatedBody.error).toBeUndefined();
  });

  it('refuses a further subscriptions/listen stream past the configured maxSubscriptions', async () => {
    const engine = createEngine();
    const endpoint = trackEndpoint(createMcpEndpoint(engine, { maxSubscriptions: 1 }));
    const uri = 'weft://workflows/limit/state';
    const first = await connectInProcessClient(endpoint, { pin: MCP_PROTOCOL_VERSION });
    const second = await connectInProcessClient(endpoint, { pin: MCP_PROTOCOL_VERSION });
    try {
      await first.client.listen({ resourceSubscriptions: [uri] });

      expect(
        await throwingRejectionOf(second.client.listen({ resourceSubscriptions: [uri] })),
      ).toThrow('Subscription limit reached');
    } finally {
      await first.client.close();
      await second.client.close();
    }
  });

  it('answers a resource read that fails for a reason other than access as an error', async () => {
    const engine = createEngine();
    const endpoint = trackEndpoint(createMcpEndpoint(engine));
    spyOn(engine, 'get').mockRejectedValue(new Error('storage offline'));
    const { client } = await connectInProcessClient(endpoint, { pin: MCP_PROTOCOL_VERSION });
    try {
      const failure = await rejectionOf(client.readResource({ uri: 'weft://workflows/w-1/state' }));

      expect(failure).toBeInstanceOf(Error);
      expect((failure as { code?: number }).code).not.toBe(-32011);
    } finally {
      await client.close();
    }
  });

  it('refuses a subscriptions/listen stream for resources the principal cannot read', async () => {
    const engine = createEngine();
    const endpoint = trackEndpoint(createMcpEndpoint(engine));
    const listen = (uris: string[]) =>
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-method': 'subscriptions/listen',
          'mcp-protocol-version': '2026-07-28',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'listen',
          method: 'subscriptions/listen',
          params: { notifications: { resourceSubscriptions: uris } },
        }),
      });
    const search = 'weft://workflows/search?status=running';
    const unscoped = principalFromJwtClaims(
      { sub: 'signaller', scope: 'signals:write' },
      { scopeVocabulary: WEFT_SCOPE_VOCABULARY },
    );
    const refused = await handleMcpHttpRequest({
      request: listen([search]),
      endpoint,
      principal: unscoped,
      authRequired: true,
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      id: 'listen',
      error: { code: -32011, message: 'Subscribing to workflow resources requires workflows:read' },
    });

    const reader = principalFromJwtClaims(
      { sub: 'reader', scope: 'workflows:read' },
      { scopeVocabulary: WEFT_SCOPE_VOCABULARY },
    );
    const events = await handleMcpHttpRequest({
      request: listen(['weft://workflows/w-1/events']),
      endpoint,
      principal: reader,
      authRequired: true,
    });
    expect(events.status).toBe(403);
    expect(await events.json()).toMatchObject({
      error: { message: 'Subscribing to workflow events requires events:read' },
    });
  });

  it('refuses tool calls and resource reads the principal has no scope for', async () => {
    const engine = createEngine();
    const endpoint = trackEndpoint(createMcpEndpoint(engine));
    const reader = principalFromJwtClaims(
      { sub: 'reader', scope: 'workflows:read' },
      { scopeVocabulary: WEFT_SCOPE_VOCABULARY },
    );
    const handle = await engine.start('hold-for-cancel', { label: 'scoped' });

    const started = await readJsonRpcResponse(
      await handleMcpHttpRequest({
        request: jsonRequest({
          jsonrpc: '2.0',
          id: 'start',
          method: 'tools/call',
          params: { name: 'start_workflow', arguments: { type: 'hold-for-cancel' } },
        }),
        endpoint,
        principal: reader,
        authRequired: true,
      }),
    );
    expect(started.result).toMatchObject({
      isError: true,
      content: [{ text: 'Starting workflows requires workflows:write' }],
    });

    const events = await readJsonRpcResponse(
      await handleMcpHttpRequest({
        request: jsonRequest({
          jsonrpc: '2.0',
          id: 'events',
          method: 'resources/read',
          params: { uri: `weft://workflows/${handle.id}/events` },
        }),
        endpoint,
        principal: reader,
        authRequired: true,
      }),
    );
    expect(events.error).toMatchObject({
      code: -32011,
      message: 'Reading workflow events requires events:read',
    });

    const missing = await readJsonRpcResponse(
      await handleMcpHttpRequest({
        request: jsonRequest({
          jsonrpc: '2.0',
          id: 'missing',
          method: 'resources/read',
          params: { uri: 'weft://workflows/missing-workflow/state' },
        }),
        endpoint,
        principal: reader,
        authRequired: true,
      }),
    );
    // The SDK's resource-not-found convention: -32602 with the URI as data.
    expect(missing.error).toMatchObject({
      code: -32602,
      data: { uri: 'weft://workflows/missing-workflow/state' },
    });
    await engine.cancel(handle.id);
  });

  it('returns HTTP negotiation errors for invalid MCP transport requests', async () => {
    const engine = createEngine();
    const endpoint = trackEndpoint(createMcpEndpoint(engine));
    const small = trackEndpoint(createMcpEndpoint(engine, { maxBodyBytes: 5 }));
    const statusOf = async (request: Request, target = endpoint): Promise<number> => {
      const response = await handleMcpHttpRequest({
        request,
        endpoint: target,
        authRequired: false,
      });
      return response.status;
    };

    expect(await statusOf(new Request('http://localhost/mcp', { method: 'PUT' }))).toBe(405);
    // Both eras are served one POST at a time: there is no session to stream or end.
    for (const method of ['GET', 'DELETE']) {
      const status = await statusOf(
        new Request('http://localhost/mcp', {
          method,
          headers: { accept: 'text/event-stream', 'Mcp-Protocol-Version': MCP_PROTOCOL_VERSION },
        }),
      );
      expect(status).toBe(405);
    }

    const listTools = { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} };
    expect(await statusOf(jsonRequest(listTools, { accept: 'text/plain' }))).toBe(406);
    expect(await statusOf(jsonRequest(listTools, { 'content-type': 'text/plain' }))).toBe(415);
    expect(await statusOf(jsonRequest(listTools), small)).toBe(413);
    expect(await statusOf(jsonRequest(listTools, { 'Mcp-Protocol-Version': '1999-01-01' }))).toBe(
      400,
    );
  });

  it('answers a 2025-03-26 initialize in that revision', async () => {
    const engine = createEngine();
    const endpoint = trackEndpoint(createMcpEndpoint(engine));

    const response = await handleMcpHttpRequest({
      request: new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'weft-ui', version: '0.1.0' },
          },
        }),
      }),
      endpoint,
      authRequired: false,
    });

    expect(response.status).toBe(200);
    const initialized = await readJsonRpcResponse(response);
    expect(initialized.result).toMatchObject({
      protocolVersion: '2025-03-26',
      serverInfo: { name: 'weft' },
    });
  });

  it('rejects cross-origin /mcp requests without explicit origin configuration', async () => {
    const engine = createEngine();
    const endpoint = trackEndpoint(createMcpEndpoint(engine));

    const rejected = await handleMcpHttpRequest({
      request: new Request('https://attacker.example/mcp', {
        method: 'PUT',
        headers: { origin: 'https://attacker.example' },
      }),
      endpoint,
      authRequired: false,
    });
    expect(rejected.status).toBe(403);
    expect(await rejected.text()).toBe('Forbidden');

    for (const options of [
      { publicOrigin: 'https://app.example' },
      { trustedHosts: ['app.example'] },
    ]) {
      const admitted = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} },
          { origin: 'https://app.example' },
        ),
        endpoint,
        authRequired: false,
        ...options,
      });
      expect(admitted.status).toBe(200);
    }
    const malformed = await handleMcpHttpRequest({
      request: jsonRequest(
        { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} },
        { origin: 'not a url' },
      ),
      endpoint,
      authRequired: false,
    });
    expect(malformed.status).toBe(403);
  });
});

async function runningHoldForCancel(engine: Engine): Promise<string> {
  let workflowId = '';
  await waitForCondition(
    async () => {
      const list = await engine.list({ type: 'hold-for-cancel' });
      workflowId = list.items.find((item) => item.status === 'running')?.id ?? '';
      return workflowId.length > 0;
    },
    { intervalMs: 10, label: 'running MCP workflow tool call' },
  );
  return workflowId;
}

function jsonRequest(message: Record<string, unknown>, headers?: HeadersInit): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: legacyHeaders(headers),
    body: JSON.stringify(message),
  });
}

function makeBrokenSchema(label: string): DefinitionSchema {
  return {
    '~standard': {
      version: 1,
      vendor: `unknown-${label}`,
      validate: (value: unknown) => ({ value }),
    },
  };
}
