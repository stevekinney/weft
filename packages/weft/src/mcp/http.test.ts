import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { Engine } from '../core/engine.ts';
import { activity, type DefinitionSchema, type WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types/workflow-function.ts';
import { serve, type WeftServer } from '../server/index.ts';
import { anonymousPrincipal, principalFromJwtClaims } from '../server/principal.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { waitForCondition } from '../testing/fake-timers.test-support.ts';
import { handleMcpHttpRequest } from './http.ts';
import { createMcpSessionManager, McpSession, type McpSessionManager } from './session.ts';
import { callMcpTool, listMcpTools } from './tools.ts';

const MCP_PROTOCOL_VERSION = '2025-11-25';
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
    { timeoutMs: 2_000, intervalMs: 10, label: `workflow ${workflowId} to reach ${status}` },
  );
}

// Continuation tokens minted at `initialize` (#525). Anonymous sessions require the
// token on every follow-up request; `mcpPost` / `jsonRequest` attach the one captured
// for a session id so the existing helpers keep threading a bare `sessionId` string.
const sessionTokens = new Map<string, string>();

// Record the continuation token a raw `initialize` response disclosed, so later
// direct-handler requests for that session id pick it up via `jsonRequest`.
function rememberSessionToken(response: Response, sessionId: string | null): void {
  if (sessionId === null) return;
  const token = response.headers.get('Mcp-Session-Token');
  if (token !== null) sessionTokens.set(sessionId, token);
}

async function initialize(server: WeftServer, headers?: HeadersInit): Promise<string> {
  const requestHeaders = new Headers(headers);
  requestHeaders.set('accept', 'application/json, text/event-stream');
  requestHeaders.set('content-type', 'application/json');
  const response = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'weft-test-client', version: '1.0.0' },
      },
    }),
  });

  expect(response.status).toBe(200);
  const sessionId = response.headers.get('Mcp-Session-Id');
  expect(sessionId).toBeTruthy();
  // The continuation token is disclosed on the initialize response (and nowhere else).
  const sessionToken = response.headers.get('Mcp-Session-Token');
  expect(sessionToken).toBeTruthy();
  sessionTokens.set(sessionId!, sessionToken!);

  const body = (await response.json()) as JsonRpcEnvelope;
  expect(body.error).toBeUndefined();
  expect(body.result).toMatchObject({
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      tools: expect.any(Object),
      resources: expect.objectContaining({ subscribe: true }),
      logging: expect.any(Object),
      prompts: expect.any(Object),
    },
    serverInfo: { name: 'weft' },
  });

  const initialized = await mcpPost(
    server,
    sessionId!,
    {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    },
    headers,
  );
  expect(initialized.status).toBe(202);

  return sessionId!;
}

async function mcpPost(
  server: WeftServer,
  sessionId: string,
  message: Record<string, unknown>,
  headers?: HeadersInit,
): Promise<Response> {
  const requestHeaders = new Headers(headers);
  requestHeaders.set('accept', 'application/json, text/event-stream');
  requestHeaders.set('content-type', 'application/json');
  requestHeaders.set('Mcp-Session-Id', sessionId);
  requestHeaders.set('Mcp-Protocol-Version', MCP_PROTOCOL_VERSION);
  const token = sessionTokens.get(sessionId);
  if (token !== undefined && !requestHeaders.has('Mcp-Session-Token')) {
    requestHeaders.set('Mcp-Session-Token', token);
  }
  return fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(message),
  });
}

async function mcpJson(
  server: WeftServer,
  sessionId: string,
  message: Record<string, unknown>,
  headers?: HeadersInit,
): Promise<JsonRpcEnvelope> {
  const response = await mcpPost(server, sessionId, message, headers);
  expect(response.status).toBe(200);
  return (await response.json()) as JsonRpcEnvelope;
}

function parseToolText(result: unknown): unknown {
  const toolResult = result as ToolCallResult;
  expect(toolResult.isError).not.toBe(true);
  expect(toolResult.content[0]?.type).toBe('text');
  return JSON.parse(toolResult.content[0]!.text);
}

async function resolveWithin<T>(
  promise: Promise<T>,
  options: { timeoutMs: number; label: string },
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${options.label} did not resolve within ${options.timeoutMs}ms`)),
          options.timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
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

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    for (const engine of enginesToDispose.splice(0)) {
      engine[Symbol.dispose]();
    }
  });

  it('initializes a session, lists tools, calls a registered workflow tool, and hides activities', async () => {
    const engine = createEngine();
    server = serve({ engine, port: 0 });
    const sessionId = await initialize(server);

    const tools = await mcpJson(server, sessionId, {
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

    const called = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'call',
      method: 'tools/call',
      params: { name: 'greet_customer', arguments: { input: { name: 'Ada' } } },
    });

    expect(parseToolText(called.result)).toMatchObject({
      result: { message: 'Hello, Ada!' },
      workflowId: expect.any(String),
    });

    const started = await mcpJson(server, sessionId, {
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

    const queried = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'query-control',
      method: 'tools/call',
      params: {
        name: 'query_workflow',
        arguments: { workflowId: 'mcp-control-workflow', queryName: 'label' },
      },
    });
    expect(parseToolText(queried.result)).toEqual({ result: 'initial-label' });

    const updated = await mcpJson(server, sessionId, {
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

    const signalled = await mcpJson(server, sessionId, {
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

    const state = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'get-control',
      method: 'tools/call',
      params: { name: 'get_workflow_state', arguments: { workflowId: 'mcp-control-workflow' } },
    });
    expect(parseToolText(state.result)).toMatchObject({
      id: 'mcp-control-workflow',
      status: 'completed',
    });

    const failedToolCall = await mcpJson(server, sessionId, {
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
    const sessionId = await initialize(server);

    await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'first-list',
      method: 'tools/list',
      params: {},
    });
    await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'second-list',
      method: 'tools/list',
      params: {},
    });
    expect(inputConversions).toBe(1);

    const called = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'call-counted-tool',
      method: 'tools/call',
      params: { name: 'counted_tool', arguments: { input: { name: 'Ada' } } },
    });
    expect(parseToolText(called.result)).toMatchObject({
      result: { message: 'Hello, Ada!' },
    });
    expect(inputConversions).toBe(1);

    const lateTool = workflow({
      name: 'late-tool',
      inputSchema: countingDefinitionSchema(() => {
        inputConversions += 1;
      }),
    }).execute(async function* () {
      return { ok: true };
    });
    engine.register(lateTool);

    const afterRegistration = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'after-registration',
      method: 'tools/list',
      params: {},
    });
    const names = (
      (afterRegistration.result as { tools: Array<{ name: string }> }).tools ?? []
    ).map((tool) => tool.name);
    expect(names).toContain('late_tool');
    expect(inputConversions).toBe(3);
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
    const sessionId = await initialize(server);

    const tools = await mcpJson(server, sessionId, {
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
    const session = new McpSession('mask-errors-session', anonymousPrincipal());

    const result = await callMcpTool(
      'explode_secretly',
      {},
      {
        engine,
        session,
        principal: anonymousPrincipal(),
        authRequired: false,
        requestId: 'mask-errors',
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('Tool execution failed');
  });

  it('shapes unknown and malformed workflow-tool arguments as tool errors', async () => {
    const engine = createEngine();
    const session = new McpSession('argument-errors-session', anonymousPrincipal());
    const context = {
      engine,
      session,
      principal: anonymousPrincipal(),
      authRequired: false,
      requestId: 'argument-errors',
    };

    await expect(callMcpTool('missing_tool', {}, context)).resolves.toMatchObject({
      isError: true,
      content: [{ text: 'Unknown tool: missing_tool' }],
    });
    await expect(callMcpTool('start_workflow', [], context)).resolves.toMatchObject({
      isError: true,
      content: [{ text: 'Tool arguments must be a JSON object' }],
    });
    await expect(callMcpTool('greet_customer', [], context)).resolves.toMatchObject({
      isError: true,
      content: [{ text: 'Tool arguments must be a JSON object' }],
    });
    await expect(
      callMcpTool('greet_customer', { input: { name: 'Ada' }, timeoutMs: 0 }, context),
    ).resolves.toMatchObject({
      isError: true,
      content: [{ text: 'Tool argument "timeoutMs" must be an integer from 1 to 2147483647' }],
    });
  });

  it('cancels a workflow when the request is cancelled after start', async () => {
    const engine = createEngine();
    const session = new McpSession('post-start-cancellation-session', anonymousPrincipal());
    const originalStart = engine.start.bind(engine);
    engine.start = async (...argumentsValue: Parameters<Engine['start']>) => {
      const handle = await originalStart(...argumentsValue);
      session.cancelRequest('post-start-cancellation');
      return handle;
    };

    const result = await callMcpTool(
      'hold_for_cancel',
      { input: { label: 'cancel-after-start' } },
      {
        engine,
        session,
        principal: anonymousPrincipal(),
        authRequired: false,
        requestId: 'post-start-cancellation',
      },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Workflow cancelled' }],
    });
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
      {
        engine,
        session: new McpSession('result-cancellation-session', anonymousPrincipal()),
        principal: anonymousPrincipal(),
        authRequired: false,
        requestId: 'result-cancellation',
      },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Workflow cancelled' }],
    });
  });

  it('lists and cancels workflows through the built-in tools', async () => {
    const engine = createEngine();
    server = serve({ engine, port: 0 });
    const sessionId = await initialize(server);
    const handle = await engine.start('hold-for-cancel', { label: 'built-in-tools' });
    await waitForStatus(engine, handle.id, 'running');

    const listed = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'list-workflows',
      method: 'tools/call',
      params: { name: 'list_workflows', arguments: { status: 'running' } },
    });
    expect(parseToolText(listed.result)).toMatchObject({
      items: [expect.objectContaining({ id: handle.id, status: 'running' })],
    });

    const invalidList = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'invalid-list-workflows',
      method: 'tools/call',
      params: { name: 'list_workflows', arguments: { limit: -1 } },
    });
    expect(invalidList.result).toMatchObject({
      isError: true,
      content: [{ text: 'List filter limit must be a non-negative integer' }],
    });

    const cancelled = await mcpJson(server, sessionId, {
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
    const sessionId = await initialize(server);

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

    const resources = await mcpJson(server, sessionId, {
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

    const read = await mcpJson(server, sessionId, {
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

    const encodedRead = await mcpJson(server, sessionId, {
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

    const events = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'events',
      method: 'resources/read',
      params: { uri: `weft://workflows/${handle.id}/events` },
    });
    const eventContents = (events.result as { contents: Array<{ text: string }> }).contents;
    expect(JSON.parse(eventContents[0]!.text)).toMatchObject({ events: expect.any(Array) });

    const checkpoints = await mcpJson(server, sessionId, {
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

    const search = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'search',
      method: 'resources/read',
      params: { uri: 'weft://workflows/search?status=running&type=hold-for-cancel' },
    });
    const searchContents = (search.result as { contents: Array<{ text: string }> }).contents;
    expect(JSON.parse(searchContents[0]!.text)).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: handle.id })]),
    });

    const controller = new AbortController();
    const streamResponse = await fetch(`${server.url}/mcp`, {
      headers: {
        accept: 'text/event-stream',
        'Mcp-Session-Id': sessionId,
        'Mcp-Session-Token': sessionTokens.get(sessionId) ?? '',
        'Mcp-Protocol-Version': MCP_PROTOCOL_VERSION,
      },
      signal: controller.signal,
    });
    expect(streamResponse.status).toBe(200);

    const subscribed = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'subscribe',
      method: 'resources/subscribe',
      params: { uri },
    });
    expect(subscribed.result).toEqual({});

    await engine.signal(handle.id, 'release', 'done');
    await waitForStatus(engine, handle.id, 'completed');

    const notificationText = await readUntil(streamResponse, 'notifications/resources/updated');
    controller.abort();
    expect(notificationText).toContain(uri);
  });

  it('notifies subscribed search resources when workflow visibility changes', async () => {
    const engine = createEngine();
    server = serve({ engine, port: 0 });
    const sessionId = await initialize(server);
    const handle = await engine.start(
      'hold-for-cancel',
      { label: 'search-subscription' },
      { id: 'search-subscription-workflow' },
    );
    const searchUri = 'weft://workflows/search?status=running&type=hold-for-cancel';

    const controller = new AbortController();
    const streamResponse = await fetch(`${server.url}/mcp`, {
      headers: {
        accept: 'text/event-stream',
        'Mcp-Session-Id': sessionId,
        'Mcp-Session-Token': sessionTokens.get(sessionId) ?? '',
        'Mcp-Protocol-Version': MCP_PROTOCOL_VERSION,
      },
      signal: controller.signal,
    });
    expect(streamResponse.status).toBe(200);

    const subscribed = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'subscribe-search',
      method: 'resources/subscribe',
      params: { uri: searchUri },
    });
    expect(subscribed.result).toEqual({});

    await engine.signal(handle.id, 'release', 'done');
    await waitForStatus(engine, handle.id, 'completed');

    const notificationText = await readUntil(streamResponse, searchUri);
    controller.abort();
    expect(notificationText).toContain('notifications/resources/updated');
    expect(notificationText).toContain(searchUri);
  });

  it('notifies search resource subscribers when the changed workflow no longer loads', async () => {
    const engine = createEngine();
    await using manager = createMcpSessionManager(engine);
    const session = manager.create(anonymousPrincipal());
    const searchUri = 'weft://workflows/search?status=completed&type=hold-for-cancel';
    const messages: unknown[] = [];
    session.subscriptions.add(searchUri);
    session.addTarget((message) => messages.push(message));

    const originalGet = engine.get.bind(engine);
    engine.get = async (workflowId: string) => {
      if (workflowId === 'deleted-workflow') return null;
      return originalGet(workflowId);
    };

    engine.dispatchEvent(
      Object.assign(new Event('workflow:completed'), { workflowId: 'deleted-workflow' }),
    );

    await waitForCondition(
      () => messages.some((message) => JSON.stringify(message).includes(`"uri":"${searchUri}"`)),
      {
        timeoutMs: 2_000,
        intervalMs: 10,
        label: 'search subscription notification for deleted workflow',
      },
    );
  });

  it('honors workflow tool cancellation observed before engine.start writes state', async () => {
    const engine = createEngine();
    const session = new McpSession('race-session', anonymousPrincipal());
    const originalTrackRequest = session.trackRequest.bind(session);
    session.trackRequest = (requestId, workflowId) => {
      originalTrackRequest(requestId, workflowId);
      session.cancelRequest(requestId);
    };

    const result = await callMcpTool(
      'hold_for_cancel',
      { label: 'cancel-before-start' },
      {
        engine,
        session,
        principal: anonymousPrincipal(),
        authRequired: false,
        requestId: 'cancel-before-start',
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('cancelled');
    await expect(engine.list({ type: 'hold-for-cancel' })).resolves.toMatchObject({
      total: 0,
      items: [],
    });
  });

  it('returns a running result when a per-workflow MCP tool call reaches timeoutMs', async () => {
    const engine = createEngine();
    server = serve({ engine, port: 0 });
    const sessionId = await initialize(server);
    let workflowId = '';
    const pendingCall = mcpJson(server, sessionId, {
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
        timeoutMs: 500,
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
    const sessionId = await initialize(server);

    const completed = await mcpJson(server, sessionId, {
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

    const pendingCall = mcpJson(server, sessionId, {
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
      timeoutMs: 500,
      label: 'timed-out MCP workflow tool call with timeoutMs input',
    });
    const payload = parseToolText(response.result) as { workflowId: string; timedOut: boolean };
    expect(payload.timedOut).toBe(true);
    await waitForStatus(engine, payload.workflowId, 'running');
    await expect(engine.query(payload.workflowId, 'input')).resolves.toEqual({
      timeoutMs: 456,
      label: 'parked',
      wait: true,
    });
    await engine.signal(payload.workflowId, 'release', 'done');
  });

  it('maps MCP cancellation notifications to engine.cancel for an in-flight workflow tool call', async () => {
    const engine = createEngine();
    server = serve({ engine, port: 0 });
    const sessionId = await initialize(server);

    const pendingCall = mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'pending-tool-call',
      method: 'tools/call',
      params: { name: 'hold_for_cancel', arguments: { input: { label: 'cancel-me' } } },
    });

    let workflowId = '';
    await waitForCondition(
      async () => {
        const list = await engine.list({ type: 'hold-for-cancel' });
        workflowId = list.items.find((item) => item.status === 'running')?.id ?? '';
        return workflowId.length > 0;
      },
      { timeoutMs: 2_000, intervalMs: 10, label: 'running MCP workflow tool call' },
    );

    const cancellation = await mcpPost(server, sessionId, {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'pending-tool-call', reason: 'test cancellation' },
    });
    expect(cancellation.status).toBe(202);
    await waitForStatus(engine, workflowId, 'cancelled');

    const response = await pendingCall;
    const toolResult = response.result as ToolCallResult;
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content[0]?.text).toContain('cancelled');
  });

  it('aborts the pending workflow result await when a cancellation notification arrives', async () => {
    const engine = createEngine();
    server = serve({ engine, port: 0 });
    const sessionId = await initialize(server);
    const originalCancel = engine.cancel.bind(engine);
    const cancelledWorkflowIds: string[] = [];
    engine.cancel = async (workflowId: string) => {
      cancelledWorkflowIds.push(workflowId);
    };
    let workflowId = '';

    const pendingCall = mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'abort-pending-tool-call',
      method: 'tools/call',
      params: {
        name: 'hold_for_cancel',
        arguments: { input: { label: 'abort-me' }, timeoutMs: 30_000 },
      },
    });

    try {
      await waitForCondition(
        async () => {
          const list = await engine.list({ type: 'hold-for-cancel' });
          workflowId = list.items.find((item) => item.status === 'running')?.id ?? '';
          return workflowId.length > 0;
        },
        { timeoutMs: 2_000, intervalMs: 10, label: 'running MCP workflow tool call' },
      );

      const cancellation = await mcpPost(server, sessionId, {
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 'abort-pending-tool-call', reason: 'test cancellation' },
      });
      expect(cancellation.status).toBe(202);

      const response = await resolveWithin(pendingCall, {
        timeoutMs: 500,
        label: 'cancelled MCP workflow tool call',
      });
      const toolResult = response.result as ToolCallResult;
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

  it('accepts invalid cancellation notifications without failing the session', async () => {
    const engine = createEngine();
    server = serve({ engine, port: 0 });
    const sessionId = await initialize(server);

    const notification = await mcpPost(server, sessionId, {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: [],
    });
    expect(notification.status).toBe(202);

    const tools = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'tools-after-invalid-notification',
      method: 'tools/list',
      params: {},
    });
    expect((tools.result as { tools: Array<{ name: string }> }).tools.length).toBeGreaterThan(0);
  });

  it('denies anonymous direct-handler requests when authentication is required', async () => {
    const engine = createEngine();
    const sessionManager = createMcpSessionManager(engine);

    try {
      const initialized = await handleMcpHttpRequest({
        request: jsonRequest({
          jsonrpc: '2.0',
          id: 'init',
          method: 'initialize',
          params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
        }),
        engine,
        sessionManager,
        authRequired: true,
      });
      expect(initialized.status).toBe(200);
      const sessionId = initialized.headers.get('Mcp-Session-Id');
      expect(sessionId).toBeTruthy();
      rememberSessionToken(initialized, sessionId);

      const ready = await sendDirectInitializedNotification(engine, sessionManager, sessionId!);
      expect(ready.status).toBe(202);

      const tools = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} },
          sessionId!,
        ),
        engine,
        sessionManager,
        authRequired: true,
      });

      expect(tools.status).toBe(200);
      const envelope = (await tools.json()) as JsonRpcEnvelope;
      expect(envelope.error).toMatchObject({
        code: -32011,
        message: 'MCP request requires authentication',
      });
    } finally {
      await sessionManager[Symbol.asyncDispose]();
    }
  });

  it('requires initialize and initialized notification before normal requests', async () => {
    const engine = createEngine();
    const sessionManager = createMcpSessionManager(engine);

    try {
      const initialized = await initializeDirectHandlerSession(engine, sessionManager);
      expect(initialized.status).toBe(200);
      const sessionId = initialized.headers.get('Mcp-Session-Id');
      expect(sessionId).toBeTruthy();
      rememberSessionToken(initialized, sessionId);

      const beforeReady = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} },
          sessionId!,
        ),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(beforeReady.status).toBe(200);
      expect((await beforeReady.json()) as JsonRpcEnvelope).toMatchObject({
        error: {
          code: -32000,
          message: 'MCP session must receive notifications/initialized before requests',
        },
      });

      const ready = await sendDirectInitializedNotification(engine, sessionManager, sessionId!);
      expect(ready.status).toBe(202);

      const afterReady = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'tools-ready', method: 'tools/list', params: {} },
          sessionId!,
        ),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(afterReady.status).toBe(200);
      const envelope = (await afterReady.json()) as JsonRpcEnvelope;
      expect(envelope.error).toBeUndefined();
    } finally {
      await sessionManager[Symbol.asyncDispose]();
    }
  });

  it('does not create a remote session for initialize notifications', async () => {
    const engine = createEngine();
    const sessionManager = createMcpSessionManager(engine, { maximumSessions: 1 });

    try {
      const initializeNotification = await handleMcpHttpRequest({
        request: jsonRequest({
          jsonrpc: '2.0',
          method: 'initialize',
          params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
        }),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(initializeNotification.status).toBe(400);
      expect(await initializeNotification.text()).toBe('Missing Mcp-Session-Id');

      const initialized = await initializeDirectHandlerSession(engine, sessionManager);
      expect(initialized.status).toBe(200);
      expect(initialized.headers.get('Mcp-Session-Id')).toBeTruthy();

      const rejected = await initializeDirectHandlerSession(engine, sessionManager);
      expect(rejected.status).toBe(429);
      expect(await rejected.text()).toBe('Too many MCP sessions');
    } finally {
      await sessionManager[Symbol.asyncDispose]();
    }
  });

  it('returns HTTP negotiation and session errors for invalid MCP transport requests', async () => {
    const engine = createEngine();
    const sessionManager = createMcpSessionManager(engine);

    try {
      const methodNotAllowed = await handleMcpHttpRequest({
        request: new Request('http://localhost/mcp', { method: 'PUT' }),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(methodNotAllowed.status).toBe(405);

      const badAccept = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'bad-accept', method: 'initialize', params: {} },
          undefined,
          { accept: 'text/plain' },
        ),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(badAccept.status).toBe(406);

      const badContentType = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'bad-content', method: 'initialize', params: {} },
          undefined,
          { 'content-type': 'text/plain' },
        ),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(badContentType.status).toBe(415);

      const missingSession = await handleMcpHttpRequest({
        request: jsonRequest({ jsonrpc: '2.0', id: 'missing', method: 'tools/list', params: {} }),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(missingSession.status).toBe(400);

      const unknownSession = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'unknown', method: 'tools/list', params: {} },
          'missing-session',
        ),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(unknownSession.status).toBe(404);

      const oversize = await handleMcpHttpRequest({
        request: jsonRequest({ jsonrpc: '2.0', id: 'oversize', method: 'initialize', params: {} }),
        engine,
        sessionManager,
        authRequired: false,
        maxBodyBytes: 5,
      });
      expect(oversize.status).toBe(413);

      const wrongInitialVersion = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'wrong-initial-version', method: 'initialize', params: {} },
          undefined,
          { 'Mcp-Protocol-Version': '1999-01-01' },
        ),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(wrongInitialVersion.status).toBe(400);

      const initialized = await initializeDirectHandlerSession(engine, sessionManager);
      const sessionId = initialized.headers.get('Mcp-Session-Id');
      expect(sessionId).toBeTruthy();
      rememberSessionToken(initialized, sessionId);

      const wrongVersion = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'wrong-version', method: 'tools/list', params: {} },
          sessionId!,
          { 'Mcp-Protocol-Version': '1999-01-01' },
        ),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(wrongVersion.status).toBe(400);

      const deleted = await handleMcpHttpRequest({
        request: new Request('http://localhost/mcp', {
          method: 'DELETE',
          headers: {
            'Mcp-Session-Id': sessionId!,
            'Mcp-Session-Token': sessionTokens.get(sessionId!) ?? '',
          },
        }),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(deleted.status).toBe(204);

      const afterDelete = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'after-delete', method: 'tools/list', params: {} },
          sessionId!,
        ),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(afterDelete.status).toBe(404);

      const getAfterDelete = await handleMcpHttpRequest({
        request: new Request('http://localhost/mcp', {
          headers: { accept: 'text/event-stream', 'Mcp-Session-Id': sessionId! },
        }),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(getAfterDelete.status).toBe(404);
    } finally {
      await sessionManager[Symbol.asyncDispose]();
    }
  });

  it('rejects cross-origin /mcp requests without explicit origin configuration', async () => {
    const engine = createEngine();
    const sessionManager = createMcpSessionManager(engine);

    try {
      const rejected = await handleMcpHttpRequest({
        request: new Request('https://attacker.example/mcp', {
          method: 'PUT',
          headers: { origin: 'https://attacker.example' },
        }),
        engine,
        sessionManager,
        authRequired: false,
      });

      expect(rejected.status).toBe(403);
      expect(await rejected.text()).toBe('Forbidden');
    } finally {
      await sessionManager[Symbol.asyncDispose]();
    }
  });

  it('does not treat authenticated principals with missing subjects as the same session owner', async () => {
    const engine = createEngine();
    const sessionManager = createMcpSessionManager(engine);
    const originalPrincipal = principalFromJwtClaims({ scope: 'workflows:read' });
    const otherPrincipal = principalFromJwtClaims({ scope: 'workflows:read' });

    try {
      const initialized = await handleMcpHttpRequest({
        request: jsonRequest({
          jsonrpc: '2.0',
          id: 'init',
          method: 'initialize',
          params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
        }),
        engine,
        sessionManager,
        principal: originalPrincipal,
        authRequired: true,
      });
      expect(initialized.status).toBe(200);
      const sessionId = initialized.headers.get('Mcp-Session-Id');
      expect(sessionId).toBeTruthy();
      rememberSessionToken(initialized, sessionId);

      const ready = await handleMcpHttpRequest({
        request: jsonRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId!),
        engine,
        sessionManager,
        principal: originalPrincipal,
        authRequired: true,
      });
      expect(ready.status).toBe(202);

      const otherOwner = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'other-owner', method: 'tools/list', params: {} },
          sessionId!,
        ),
        engine,
        sessionManager,
        principal: otherPrincipal,
        authRequired: true,
      });
      expect(otherOwner.status).toBe(403);
    } finally {
      await sessionManager[Symbol.asyncDispose]();
    }
  });

  it('rejects excess live sessions and purges idle sessions before accepting new initialization', async () => {
    const engine = createEngine();
    let now = 1_000;
    const sessionManager = createMcpSessionManager(engine, {
      maximumSessions: 1,
      sessionIdleTimeoutMilliseconds: 10,
      currentTimeMilliseconds: () => now,
    });

    try {
      const first = await initializeDirectHandlerSession(engine, sessionManager);
      expect(first.status).toBe(200);
      const firstSessionId = first.headers.get('Mcp-Session-Id');
      expect(firstSessionId).toBeTruthy();

      const rejected = await initializeDirectHandlerSession(engine, sessionManager);
      expect(rejected.status).toBe(429);
      expect(await rejected.text()).toBe('Too many MCP sessions');
      expect(rejected.headers.get('Mcp-Session-Id')).toBeNull();

      now += 11;

      const acceptedAfterExpiry = await initializeDirectHandlerSession(engine, sessionManager);
      expect(acceptedAfterExpiry.status).toBe(200);
      const nextSessionId = acceptedAfterExpiry.headers.get('Mcp-Session-Id');
      expect(nextSessionId).toBeTruthy();
      expect(nextSessionId).not.toBe(firstSessionId);

      const staleSessionLookup = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} },
          firstSessionId!,
        ),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(staleSessionLookup.status).toBe(404);
    } finally {
      await sessionManager[Symbol.asyncDispose]();
    }
  });
});

describe('MCP anonymous session continuation token (#525)', () => {
  // Initialize an anonymous session via the direct handler and return its id + token.
  async function initAnonymous(
    engine: Engine,
    sessionManager: McpSessionManager,
  ): Promise<{ sessionId: string; token: string }> {
    const initialized = await handleMcpHttpRequest({
      request: jsonRequest({
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
      }),
      engine,
      sessionManager,
      authRequired: false,
    });
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers.get('Mcp-Session-Id');
    const token = initialized.headers.get('Mcp-Session-Token');
    expect(sessionId).toBeTruthy();
    expect(token).toBeTruthy();
    return { sessionId: sessionId!, token: token! };
  }

  function postWith(
    engine: Engine,
    sessionManager: McpSessionManager,
    sessionId: string,
    token: string | null,
  ): Promise<Response> {
    const headers = new Headers({
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'Mcp-Session-Id': sessionId,
      'Mcp-Protocol-Version': MCP_PROTOCOL_VERSION,
    });
    if (token !== null) headers.set('Mcp-Session-Token', token);
    return handleMcpHttpRequest({
      request: new Request('http://localhost/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} }),
      }),
      engine,
      sessionManager,
      authRequired: false,
    });
  }

  function getWith(
    engine: Engine,
    sessionManager: McpSessionManager,
    sessionId: string,
    token: string | null,
  ): Response | Promise<Response> {
    const headers = new Headers({
      accept: 'text/event-stream',
      'Mcp-Session-Id': sessionId,
      'Mcp-Protocol-Version': MCP_PROTOCOL_VERSION,
    });
    if (token !== null) headers.set('Mcp-Session-Token', token);
    return handleMcpHttpRequest({
      request: new Request('http://localhost/mcp', {
        method: 'GET',
        headers,
        signal: AbortSignal.abort(),
      }),
      engine,
      sessionManager,
      authRequired: false,
    });
  }

  function deleteWith(
    engine: Engine,
    sessionManager: McpSessionManager,
    sessionId: string,
    token: string | null,
  ): Promise<Response> {
    const headers = new Headers({ 'Mcp-Session-Id': sessionId });
    if (token !== null) headers.set('Mcp-Session-Token', token);
    return handleMcpHttpRequest({
      request: new Request('http://localhost/mcp', { method: 'DELETE', headers }),
      engine,
      sessionManager,
      authRequired: false,
    });
  }

  it('discloses the continuation token only on the initialize response, never on continuation', async () => {
    const engine = createEngine();
    const sessionManager = createMcpSessionManager(engine);
    try {
      const { sessionId, token } = await initAnonymous(engine, sessionManager);
      // A legitimate continuation POST succeeds but does NOT re-disclose the token —
      // that exposure asymmetry (id leaks on every response, token does not) is the
      // whole security gain.
      const continuation = await postWith(engine, sessionManager, sessionId, token);
      expect(continuation.status).toBe(200);
      expect(continuation.headers.get('Mcp-Session-Token')).toBeNull();
    } finally {
      await sessionManager[Symbol.asyncDispose]();
    }
  });

  it('rejects a second anonymous caller that knows the session id but lacks the token (POST/GET/DELETE)', async () => {
    const engine = createEngine();
    const sessionManager = createMcpSessionManager(engine);
    try {
      const { sessionId } = await initAnonymous(engine, sessionManager);

      // No token at all.
      const postNoToken = await postWith(engine, sessionManager, sessionId, null);
      const getNoToken = await getWith(engine, sessionManager, sessionId, null);
      const deleteNoToken = await deleteWith(engine, sessionManager, sessionId, null);
      expect(postNoToken.status).toBe(403);
      expect(getNoToken.status).toBe(403);
      expect(deleteNoToken.status).toBe(403);

      // A wrong token.
      const postWrong = await postWith(engine, sessionManager, sessionId, 'not-the-token');
      const getWrong = await getWith(engine, sessionManager, sessionId, 'not-the-token');
      const deleteWrong = await deleteWith(engine, sessionManager, sessionId, 'not-the-token');
      expect(postWrong.status).toBe(403);
      expect(getWrong.status).toBe(403);
      expect(deleteWrong.status).toBe(403);

      // The session was never terminated by the unauthorized DELETEs.
      expect(sessionManager.get(sessionId)).toBeDefined();
    } finally {
      await sessionManager[Symbol.asyncDispose]();
    }
  });

  it('admits the legitimate anonymous caller with the token on POST, GET, and DELETE', async () => {
    const engine = createEngine();
    const sessionManager = createMcpSessionManager(engine);
    try {
      const { sessionId, token } = await initAnonymous(engine, sessionManager);
      const posted = await postWith(engine, sessionManager, sessionId, token);
      const got = await getWith(engine, sessionManager, sessionId, token);
      expect(posted.status).toBe(200);
      expect(got.status).toBe(200);
      // DELETE is last — it terminates the session.
      const deleted = await deleteWith(engine, sessionManager, sessionId, token);
      expect(deleted.status).toBe(204);
      expect(sessionManager.get(sessionId)).toBeUndefined();
    } finally {
      await sessionManager[Symbol.asyncDispose]();
    }
  });

  it('continues an authenticated session without requiring the continuation token', async () => {
    const engine = createEngine();
    const sessionManager = createMcpSessionManager(engine);
    const principal = principalFromJwtClaims({ sub: 'alice', scope: 'workflows:read' });
    try {
      const initialized = await handleMcpHttpRequest({
        request: jsonRequest({
          jsonrpc: '2.0',
          id: 'init',
          method: 'initialize',
          params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
        }),
        engine,
        sessionManager,
        principal,
        authRequired: true,
      });
      expect(initialized.status).toBe(200);
      const sessionId = initialized.headers.get('Mcp-Session-Id')!;

      const ready = await handleMcpHttpRequest({
        request: jsonRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId),
        engine,
        sessionManager,
        principal,
        authRequired: true,
      });
      expect(ready.status).toBe(202);

      // Same authenticated principal, NO Mcp-Session-Token header — still admitted,
      // because the credential that rebuilds the principal already isolates the session.
      const continuation = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} },
          sessionId,
        ),
        engine,
        sessionManager,
        principal,
        authRequired: true,
      });
      expect(continuation.status).toBe(200);
    } finally {
      await sessionManager[Symbol.asyncDispose]();
    }
  });
});

async function readUntil(response: Response, expectedText: string): Promise<string> {
  const body = response.body;
  if (body === null) throw new Error('SSE response had no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await reader.read();
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
    if (text.includes(expectedText)) {
      await reader.cancel();
      return text;
    }
  }
  await reader.cancel();
  throw new Error(`did not receive ${expectedText}`);
}

function jsonRequest(
  message: Record<string, unknown>,
  sessionId?: string,
  headers?: HeadersInit,
): Request {
  const baseHeaders = new Headers({
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'Mcp-Protocol-Version': MCP_PROTOCOL_VERSION,
  });
  const requestHeaders = new Headers(baseHeaders);
  for (const [key, value] of new Headers(headers ?? {})) {
    requestHeaders.set(key, value);
  }
  if (sessionId !== undefined) {
    requestHeaders.set('Mcp-Session-Id', sessionId);
    const token = sessionTokens.get(sessionId);
    if (token !== undefined && !requestHeaders.has('Mcp-Session-Token')) {
      requestHeaders.set('Mcp-Session-Token', token);
    }
  }
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(message),
  });
}

function initializeDirectHandlerSession(
  engine: Engine,
  sessionManager: McpSessionManager,
): Promise<Response> {
  return handleMcpHttpRequest({
    request: jsonRequest({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
    }),
    engine,
    sessionManager,
    authRequired: false,
  });
}

function sendDirectInitializedNotification(
  engine: Engine,
  sessionManager: McpSessionManager,
  sessionId: string,
): Promise<Response> {
  return handleMcpHttpRequest({
    request: jsonRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId),
    engine,
    sessionManager,
    authRequired: false,
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
