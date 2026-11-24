import { Client } from '@modelcontextprotocol/client';
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/server';
import { describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { waitForCondition } from "../../test-support/embedded/testing/src/fake-timers.ts";
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types/workflow-function.ts';
import { runMcpStdioSession } from './stdio.ts';

type ParsedLine = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  const echoWorkflow = workflow({
    name: 'echo-workflow',
    description: 'Echo input through a durable workflow.',
    inputSchema: z.object({ value: z.string() }),
  }).execute(async function* (_context: WorkflowContext, input: { value: string }) {
    return { echoed: input.value };
  });
  const holdForStdioCancel = workflow({
    name: 'hold-for-stdio-cancel',
    description: 'Wait for cancellation or release.',
    inputSchema: z.object({ value: z.string().optional() }),
  }).execute(async function* (context: WorkflowContext) {
    return yield* context.waitForSignal<string>('release');
  });
  engine.register(echoWorkflow);
  engine.register(holdForStdioCancel);
  return engine;
}

function controllableInput(): {
  stream: ReadableStream<Uint8Array>;
  send(message: Record<string, unknown>): void;
  sendRaw(text: string): void;
  close(): void;
} {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
    },
  });
  return {
    stream,
    send(message) {
      controller.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
    },
    sendRaw(text) {
      controller.enqueue(encoder.encode(text));
    },
    close() {
      controller.close();
    },
  };
}

function collectingOutput(): {
  stream: WritableStream<Uint8Array>;
  lines(): ParsedLine[];
} {
  const decoder = new TextDecoder();
  let buffer = '';
  const lines: ParsedLine[] = [];
  return {
    stream: new WritableStream({
      write(chunk) {
        buffer += decoder.decode(chunk, { stream: true });
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.length > 0) lines.push(JSON.parse(line) as ParsedLine);
          newlineIndex = buffer.indexOf('\n');
        }
      },
    }),
    lines() {
      return [...lines];
    },
  };
}

/** An SDK client transport wired to a stdio session's input and output streams. */
function streamClientTransport(): {
  transport: Transport;
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
} {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let buffer = '';
  const transport: Transport = {
    async start() {},
    async send(message: JSONRPCMessage) {
      controller.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
    },
    async close() {
      controller.close();
      transport.onclose?.();
    },
  };
  return {
    transport,
    input: new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
    }),
    output: new WritableStream<Uint8Array>({
      write(chunk) {
        buffer += decoder.decode(chunk, { stream: true });
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          transport.onmessage?.(JSON.parse(line) as JSONRPCMessage);
          newlineIndex = buffer.indexOf('\n');
        }
      },
    }),
  };
}

async function waitForLine(
  output: { lines(): ParsedLine[] },
  predicate: (line: ParsedLine) => boolean,
): Promise<ParsedLine> {
  let found: ParsedLine | undefined;
  await waitForCondition(
    () => {
      found = output.lines().find(predicate);
      return found !== undefined;
    },
    { intervalMs: 10, label: 'MCP stdio line' },
  );
  return found!;
}

function toolText(result: unknown): unknown {
  const content = (result as { content: Array<{ type: 'text'; text: string }> }).content;
  return JSON.parse(content[0]!.text);
}

async function expectRejectedStartupTokenAdmission({
  frame,
  rawFrame,
  maxFrameBytes,
  expectedLine,
  expectedReason,
}: {
  frame?: Record<string, unknown>;
  rawFrame?: string;
  maxFrameBytes?: number;
  expectedLine: Pick<ParsedLine, 'id' | 'error'>;
  expectedReason: string;
}): Promise<void> {
  const input = controllableInput();
  const output = collectingOutput();
  const engine = createEngine();

  const options = {
    input: input.stream,
    output: output.stream,
    engine,
    admission: { kind: 'startup-token', token: 'secret-token' },
  } as const;
  const session = runMcpStdioSession(
    maxFrameBytes === undefined ? options : { ...options, maxFrameBytes },
  );

  if (rawFrame !== undefined) {
    input.sendRaw(rawFrame.endsWith('\n') ? rawFrame : `${rawFrame}\n`);
  } else if (frame !== undefined) {
    input.send(frame);
  }

  const line = await waitForLine(output, (candidate) => candidate.error !== undefined);
  expect(line).toMatchObject(expectedLine);
  expect(await session).toEqual({ exitCode: 2, reason: expectedReason });
  engine[Symbol.dispose]();
}

describe('runMcpStdioSession', () => {
  it('rejects empty startup-token admission before reading frames', async () => {
    const engine = createEngine();
    const result = await runMcpStdioSession({
      input: controllableInput().stream,
      output: collectingOutput().stream,
      engine,
      admission: { kind: 'startup-token', token: '   ' },
    });

    expect(result).toEqual({
      exitCode: 2,
      reason: 'MCP stdio startup token must be non-empty',
    });
    engine[Symbol.dispose]();
  });

  it('serves a 2026-07-28 client and ends while its subscription is still open', async () => {
    const engine = createEngine();
    const { transport, input, output } = streamClientTransport();
    const session = runMcpStdioSession({
      input,
      output,
      engine,
      admission: { kind: 'allow-unauthenticated-local-admin' },
    });
    const client = new Client(
      { name: 'stdio-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');

    const handle = await engine.start('hold-for-stdio-cancel', {}, { id: 'modern-stdio' });
    const uri = `weft://workflows/${handle.id}/state`;
    const updated = new Promise<string>((resolve) => {
      client.setNotificationHandler('notifications/resources/updated', (notification) => {
        resolve(notification.params.uri);
      });
    });
    await client.listen({ resourceSubscriptions: [uri] });
    await engine.signal(handle.id, 'release', 'done');
    expect(await updated).toBe(uri);

    // The open `subscriptions/listen` request never completes on its own, so
    // the session must not wait for it once the input ends.
    await client.close();
    expect(await session).toEqual({ exitCode: 0 });
    engine[Symbol.dispose]();
  });

  it('refuses to start without an admission mode', async () => {
    const engine = createEngine();
    const result = await runMcpStdioSession({
      input: controllableInput().stream,
      output: collectingOutput().stream,
      engine,
      admission: { kind: 'require-one' },
    });

    expect(result.exitCode).toBe(2);
    expect(result.reason).toContain('--startup-token');
    engine[Symbol.dispose]();
  });

  it('exits with the failure when the output cannot be written', async () => {
    const engine = createEngine();
    const input = controllableInput();
    const session = runMcpStdioSession({
      input: input.stream,
      output: new WritableStream<Uint8Array>({
        write() {
          throw new Error('stdout closed');
        },
      }),
      engine,
      admission: { kind: 'startup-token', token: 'secret-token' },
    });
    input.send({
      jsonrpc: '2.0',
      id: 'auth',
      method: 'weft.authenticate',
      params: { token: 'secret-token' },
    });

    expect(await session).toEqual({ exitCode: 1, reason: 'stdout closed' });
    engine[Symbol.dispose]();
  });

  it('ends the session when the input closes before the authenticate frame', async () => {
    const engine = createEngine();
    const input = controllableInput();
    const session = runMcpStdioSession({
      input: input.stream,
      output: collectingOutput().stream,
      engine,
      admission: { kind: 'startup-token', token: 'secret-token' },
    });
    input.close();

    expect(await session).toEqual({
      exitCode: 2,
      reason: 'stdio session closed before authenticate frame',
    });
    engine[Symbol.dispose]();
  });

  it('answers unparseable and oversize frames and keeps serving', async () => {
    const engine = createEngine();
    const input = controllableInput();
    const output = collectingOutput();
    const session = runMcpStdioSession({
      input: input.stream,
      output: output.stream,
      engine,
      admission: { kind: 'allow-unauthenticated-local-admin' },
      maxFrameBytes: 512,
    });

    input.sendRaw('{not-json}\n');
    const parseError = await waitForLine(output, (line) => line.error?.code === -32700);
    expect(parseError).toMatchObject({ id: null, error: { message: 'Parse error' } });

    input.sendRaw('{"jsonrpc":"2.0","id":7}\n');
    const invalid = await waitForLine(output, (line) => line.id === 7);
    expect(invalid).toMatchObject({ id: 7, error: { code: -32600, message: 'Invalid Request' } });

    input.sendRaw('x'.repeat(600));
    const oversize = await waitForLine(
      output,
      (line) => line.error?.message === 'frame exceeds maxFrameBytes',
    );
    expect(oversize).toMatchObject({ id: null, error: { message: 'frame exceeds maxFrameBytes' } });

    input.send({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'stdio-test', version: '1.0.0' },
      },
    });
    await waitForLine(output, (line) => line.id === 'init' && line.result !== undefined);

    input.close();
    expect(await session).toEqual({ exitCode: 0 });
    engine[Symbol.dispose]();
  });

  it('lets a request read before the input ends finish before the session ends', async () => {
    const engine = createEngine();
    const input = controllableInput();
    const output = collectingOutput();
    const session = runMcpStdioSession({
      input: input.stream,
      output: output.stream,
      engine,
      admission: { kind: 'allow-unauthenticated-local-admin' },
    });

    input.send({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'stdio-test', version: '1.0.0' },
      },
    });
    await waitForLine(output, (line) => line.id === 'init' && line.result !== undefined);
    input.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    // The last frame carries no trailing newline and arrives just before the input ends.
    input.sendRaw(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'last-call',
        method: 'tools/call',
        params: { name: 'echo_workflow', arguments: { input: { value: 'drained' } } },
      }),
    );
    input.close();

    expect(await session).toEqual({ exitCode: 0 });
    const callLine = output.lines().find((line) => line.id === 'last-call');
    expect(toolText(callLine?.result)).toMatchObject({ result: { echoed: 'drained' } });
    engine[Symbol.dispose]();
  });

  it('accepts startup-token admission and then runs the MCP initialize handshake', async () => {
    const engine = createEngine();
    const input = controllableInput();
    const output = collectingOutput();

    const session = runMcpStdioSession({
      input: input.stream,
      output: output.stream,
      engine,
      admission: { kind: 'startup-token', token: 'secret-token' },
    });

    input.send({
      jsonrpc: '2.0',
      id: 'auth',
      method: 'weft.authenticate',
      params: { token: 'secret-token' },
    });
    await waitForLine(output, (line) => line.id === 'auth' && line.result !== undefined);

    input.send({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'stdio-test', version: '1.0.0' },
      },
    });
    await waitForLine(output, (line) => line.id === 'init' && line.result !== undefined);

    input.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    input.send({ jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} });
    await waitForLine(output, (line) => line.id === 'tools' && line.result !== undefined);

    input.close();
    expect(await session).toEqual({ exitCode: 0 });
    engine[Symbol.dispose]();
  });

  it('emits tools/list_changed and lists dynamically registered workflow tools after session start', async () => {
    const engine = createEngine();
    const input = controllableInput();
    const output = collectingOutput();

    const session = runMcpStdioSession({
      input: input.stream,
      output: output.stream,
      engine,
      admission: { kind: 'allow-unauthenticated-local-admin' },
    });

    input.send({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'stdio-test', version: '1.0.0' },
      },
    });
    const initializeLine = await waitForLine(
      output,
      (line) => line.id === 'init' && line.result !== undefined,
    );
    expect(initializeLine.result).toMatchObject({
      capabilities: { tools: { listChanged: true } },
    });

    input.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    input.send({ jsonrpc: '2.0', id: 'ready', method: 'ping', params: {} });
    await waitForLine(output, (line) => line.id === 'ready' && line.result !== undefined);

    const dynamicWorkflow = workflow({
      name: 'dynamic-workflow',
      description: 'Workflow registered after MCP session startup.',
      inputSchema: z.object({ value: z.string() }),
    }).execute(async function* (_context: WorkflowContext, workflowInput: { value: string }) {
      return { echoed: workflowInput.value };
    });

    engine.register(dynamicWorkflow);

    const notificationLine = await waitForLine(
      output,
      (line) => line.method === 'notifications/tools/list_changed',
    );
    expect(notificationLine.params).toBeUndefined();

    input.send({ jsonrpc: '2.0', id: 'tools-after-register', method: 'tools/list', params: {} });
    const toolsLine = await waitForLine(output, (line) => line.id === 'tools-after-register');
    const toolNames = (toolsLine.result as { tools: Array<{ name: string }> }).tools.map(
      (tool) => tool.name,
    );
    expect(toolNames).toContain('dynamic_workflow');

    input.close();
    expect(await session).toEqual({ exitCode: 0 });
    engine[Symbol.dispose]();
  });

  it('re-registers a projected tool when a later workflow takes over its name', async () => {
    const engine = createEngine();
    const input = controllableInput();
    const output = collectingOutput();
    const session = runMcpStdioSession({
      input: input.stream,
      output: output.stream,
      engine,
      admission: { kind: 'allow-unauthenticated-local-admin' },
    });
    input.send({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'stdio-test', version: '1.0.0' },
      },
    });
    await waitForLine(output, (line) => line.id === 'init' && line.result !== undefined);
    input.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const register = (type: string) =>
      engine.register(
        workflow({
          name: type,
          description: `Workflow ${type}.`,
          inputSchema: z.object({ value: z.string() }),
        }).execute(async function* (_context: WorkflowContext, workflowInput: { value: string }) {
          return { echoed: workflowInput.value };
        }),
      );
    const toolTitles = async (id: string): Promise<Record<string, string | undefined>> => {
      input.send({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
      const line = await waitForLine(output, (candidate) => candidate.id === id);
      const tools = (line.result as { tools: Array<{ name: string; title?: string }> }).tools;
      return Object.fromEntries(tools.map((tool) => [tool.name, tool.title]));
    };

    // `foo_bar` owns the tool name `foo_bar` until `foo-bar`, which sorts first and maps to the
    // same name, takes it over; the original workflow's tool is renamed.
    register('foo_bar');
    await waitForLine(output, (line) => line.method === 'notifications/tools/list_changed');
    const before = await toolTitles('before');
    expect(before['foo_bar']).toBe('foo_bar');

    register('foo-bar');
    // Registering announces the change synchronously, before the next request is answered.
    const titles = await toolTitles('after');
    expect(titles['foo_bar']).toBe('foo-bar');
    expect(Object.values(titles)).toContain('foo_bar');

    input.close();
    expect(await session).toEqual({ exitCode: 0 });
    engine[Symbol.dispose]();
  });

  it('rejects startup-token admission for mismatch, malformed JSON, missing token, and oversize frames', async () => {
    await expectRejectedStartupTokenAdmission({
      frame: {
        jsonrpc: '2.0',
        id: 'wrong-token',
        method: 'weft.authenticate',
        params: { token: 'wrong' },
      },
      expectedLine: {
        id: 'wrong-token',
        error: { code: -32010, message: 'startup token mismatch' },
      },
      expectedReason: 'startup token mismatch',
    });

    await expectRejectedStartupTokenAdmission({
      rawFrame: '{not-json}\n',
      expectedLine: {
        id: null,
        error: { code: -32010, message: 'first frame was not valid JSON' },
      },
      expectedReason: 'first frame was not valid JSON',
    });

    await expectRejectedStartupTokenAdmission({
      frame: {
        jsonrpc: '2.0',
        id: 'string-params',
        method: 'weft.authenticate',
        params: 'secret-token',
      },
      expectedLine: {
        id: 'string-params',
        error: { code: -32010, message: 'startup token mismatch' },
      },
      expectedReason: 'startup token mismatch',
    });

    await expectRejectedStartupTokenAdmission({
      frame: {
        jsonrpc: '2.0',
        id: 'missing-token',
        method: 'weft.authenticate',
        params: {},
      },
      expectedLine: {
        id: 'missing-token',
        error: { code: -32010, message: 'startup token mismatch' },
      },
      expectedReason: 'startup token mismatch',
    });

    await expectRejectedStartupTokenAdmission({
      rawFrame: JSON.stringify({
        jsonrpc: '2.0',
        id: 'oversize-auth',
        method: 'weft.authenticate',
        params: { token: 'secret-token' },
      }),
      maxFrameBytes: 10,
      expectedLine: {
        id: null,
        error: { code: -32010, message: 'authenticate frame exceeds maxFrameBytes' },
      },
      expectedReason: 'authenticate frame exceeds maxFrameBytes',
    });
  });

  it('accepts startup-token authenticate frames split across chunks', async () => {
    const engine = createEngine();
    const input = controllableInput();
    const output = collectingOutput();

    const session = runMcpStdioSession({
      input: input.stream,
      output: output.stream,
      engine,
      admission: { kind: 'startup-token', token: 'secret-token' },
    });

    const frame = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 'chunked-auth',
      method: 'weft.authenticate',
      params: { token: 'secret-token' },
    })}\n`;
    input.sendRaw(frame.slice(0, 10));
    input.sendRaw(frame.slice(10));
    await waitForLine(output, (line) => line.id === 'chunked-auth' && line.result !== undefined);

    input.close();
    expect(await session).toEqual({ exitCode: 0 });
    engine[Symbol.dispose]();
  });

  it('initializes, lists tools, calls workflow tools, and exits cleanly', async () => {
    const engine = createEngine();
    const input = controllableInput();
    const output = collectingOutput();

    const session = runMcpStdioSession({
      input: input.stream,
      output: output.stream,
      engine,
      admission: { kind: 'allow-unauthenticated-local-admin' },
    });

    input.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'stdio-test', version: '1.0.0' },
      },
    });
    await waitForLine(output, (line) => line.id === 1 && line.result !== undefined);

    input.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    input.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const toolsLine = await waitForLine(output, (line) => line.id === 2);
    const toolNames = (toolsLine.result as { tools: Array<{ name: string }> }).tools.map(
      (tool) => tool.name,
    );
    expect(toolNames).toContain('echo_workflow');

    input.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo_workflow', arguments: { input: { value: 'stdio' } } },
    });
    const callLine = await waitForLine(output, (line) => line.id === 3);
    expect(toolText(callLine.result)).toMatchObject({
      result: { echoed: 'stdio' },
      workflowId: expect.any(String),
    });

    input.close();
    const result = await session;
    expect(result.exitCode).toBe(0);
    engine[Symbol.dispose]();
  });

  it('notifies a 2025-era stdio connection about the resources it subscribed to', async () => {
    const engine = createEngine();
    const input = controllableInput();
    const output = collectingOutput();

    const session = runMcpStdioSession({
      input: input.stream,
      output: output.stream,
      engine,
      admission: { kind: 'allow-unauthenticated-local-admin' },
    });

    input.send({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'stdio-test', version: '1.0.0' },
      },
    });
    await waitForLine(output, (line) => line.id === 'init' && line.result !== undefined);
    input.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const handle = await engine.start(
      'hold-for-stdio-cancel',
      { value: 'subscription' },
      { id: 'stdio-idle-subscription' },
    );
    const resourceUri = `weft://workflows/${handle.id}/state`;
    input.send({
      jsonrpc: '2.0',
      id: 'subscribe',
      method: 'resources/subscribe',
      params: { uri: resourceUri },
    });
    await waitForLine(output, (line) => line.id === 'subscribe' && line.result !== undefined);

    await engine.signal(handle.id, 'release', 'done');

    const notification = await waitForLine(
      output,
      (line) =>
        line.method === 'notifications/resources/updated' && line.params?.['uri'] === resourceUri,
    );
    expect(notification).toMatchObject({
      method: 'notifications/resources/updated',
      params: { uri: resourceUri },
    });

    input.send({
      jsonrpc: '2.0',
      id: 'unsubscribe',
      method: 'resources/unsubscribe',
      params: { uri: resourceUri },
    });
    const unsubscribed = await waitForLine(output, (line) => line.id === 'unsubscribe');
    expect(unsubscribed.result).toEqual({});

    input.close();
    const result = await session;
    expect(result.exitCode).toBe(0);
    engine[Symbol.dispose]();
  });

  it('warns and keeps serving when a resource update cannot be sent', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const engine = createEngine();
    const input = controllableInput();
    const output = collectingOutput();
    const session = runMcpStdioSession({
      input: input.stream,
      output: output.stream,
      engine,
      admission: { kind: 'allow-unauthenticated-local-admin' },
      registrars: [
        (server) => {
          server.server.sendResourceUpdated = async () => {
            throw new Error('send failed');
          };
        },
      ],
    });
    try {
      input.send({
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'stdio-test', version: '1.0.0' },
        },
      });
      await waitForLine(output, (line) => line.id === 'init' && line.result !== undefined);
      input.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const handle = await engine.start(
        'hold-for-stdio-cancel',
        { value: 'unsendable' },
        { id: 'stdio-unsendable-update' },
      );
      input.send({
        jsonrpc: '2.0',
        id: 'subscribe',
        method: 'resources/subscribe',
        params: { uri: `weft://workflows/${handle.id}/state` },
      });
      await waitForLine(output, (line) => line.id === 'subscribe' && line.result !== undefined);

      await engine.signal(handle.id, 'release', 'done');
      await waitForCondition(() => warn.mock.calls.length > 0, {
        label: 'the send failure warning',
      });

      expect(warn.mock.calls[0]?.[0]).toBe(
        '[weft.mcp] Failed to send a resource update notification:',
      );
      expect(String(warn.mock.calls[0]?.[1])).toContain('send failed');
      input.send({ jsonrpc: '2.0', id: 'still-serving', method: 'ping', params: {} });
      await waitForLine(output, (line) => line.id === 'still-serving' && line.result !== undefined);
    } finally {
      warn.mockRestore();
      input.close();
      await session;
      engine[Symbol.dispose]();
    }
  });

  it('cancels the workflow of an in-flight tool call when the client cancels the request', async () => {
    const engine = createEngine();
    const input = controllableInput();
    const output = collectingOutput();

    const session = runMcpStdioSession({
      input: input.stream,
      output: output.stream,
      engine,
      admission: { kind: 'allow-unauthenticated-local-admin' },
    });

    input.send({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'stdio-test', version: '1.0.0' },
      },
    });
    await waitForLine(output, (line) => line.id === 'init');
    input.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    input.send({
      jsonrpc: '2.0',
      id: 'pending',
      method: 'tools/call',
      params: { name: 'hold_for_stdio_cancel', arguments: { input: { value: 'cancel' } } },
    });

    let workflowId = '';
    await waitForCondition(
      async () => {
        const workflows = await engine.list({ type: 'hold-for-stdio-cancel' });
        workflowId = workflows.items.find((entry) => entry.status === 'running')?.id ?? '';
        return workflowId.length > 0;
      },
      { intervalMs: 10, label: 'running stdio workflow' },
    );

    input.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'pending', reason: 'stdio test cancellation' },
    });

    await waitForCondition(
      async () => {
        const state = await engine.get(workflowId);
        return state?.status === 'cancelled';
      },
      { intervalMs: 10, label: 'stdio workflow cancellation' },
    );

    // The SDK follows the MCP rule that a cancelled request gets no response,
    // and the session still ends cleanly instead of waiting for one.
    input.close();
    const result = await session;
    expect(result.exitCode).toBe(0);
    expect(output.lines().some((line) => line.id === 'pending')).toBe(false);
    engine[Symbol.dispose]();
  });

  it('finishes cancelling the workflow of a cancelled call before the session ends', async () => {
    const engine = createEngine();
    const input = controllableInput();
    const output = collectingOutput();

    const session = runMcpStdioSession({
      input: input.stream,
      output: output.stream,
      engine,
      admission: { kind: 'allow-unauthenticated-local-admin' },
    });

    input.send({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'stdio-test', version: '1.0.0' },
      },
    });
    await waitForLine(output, (line) => line.id === 'init');
    input.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    input.send({
      jsonrpc: '2.0',
      id: 'pending',
      method: 'tools/call',
      params: { name: 'hold_for_stdio_cancel', arguments: { input: { value: 'cancel' } } },
    });

    let workflowId = '';
    await waitForCondition(
      async () => {
        const workflows = await engine.list({ type: 'hold-for-stdio-cancel' });
        workflowId = workflows.items.find((entry) => entry.status === 'running')?.id ?? '';
        return workflowId.length > 0;
      },
      { intervalMs: 10, label: 'running stdio workflow' },
    );

    let cancellations = 0;
    const cancel = engine.cancel.bind(engine);
    engine.cancel = async (...parameters: Parameters<typeof engine.cancel>) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      cancellations += 1;
      return cancel(...parameters);
    };
    input.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'pending', reason: 'stdio test cancellation' },
    });

    // Close input at once: the session must still finish the (slowed) cancellation first.
    input.close();
    const result = await session;
    expect(result.exitCode).toBe(0);
    expect(cancellations).toBe(1);
    const cancelled = await engine.get(workflowId);
    expect(cancelled?.status).toBe('cancelled');
    engine[Symbol.dispose]();
  });

  it('ignores invalid cancellation notifications and keeps the stdio session alive', async () => {
    const input = controllableInput();
    const output = collectingOutput();
    const engine = createEngine();

    const session = runMcpStdioSession({
      input: input.stream,
      output: output.stream,
      engine,
      admission: { kind: 'allow-unauthenticated-local-admin' },
    });

    input.send({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'stdio-test', version: '1.0.0' },
      },
    });
    await waitForLine(output, (line) => line.id === 'init');
    input.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    input.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: [],
    });
    input.send({ jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} });

    const toolsLine = await waitForLine(output, (line) => line.id === 'tools');
    expect(toolsLine.result).toBeDefined();

    input.close();
    expect(await session).toEqual({ exitCode: 0 });
    engine[Symbol.dispose]();
  });
});
