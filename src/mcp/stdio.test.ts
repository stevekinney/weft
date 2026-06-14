import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types/workflow-function.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { waitForCondition } from '../testing/fake-timers.test-support.ts';
import { MCP_TOOLS_LIST_CHANGED_NOTIFICATION } from './protocol.ts';
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
    { timeoutMs: 2_000, intervalMs: 10, label: 'MCP stdio line' },
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

  const options = {
    input: input.stream,
    output: output.stream,
    engine: createEngine(),
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
}

describe('runMcpStdioSession', () => {
  it('rejects empty startup-token admission before reading frames', async () => {
    const result = await runMcpStdioSession({
      input: controllableInput().stream,
      output: collectingOutput().stream,
      engine: createEngine(),
      admission: { kind: 'startup-token', token: '   ' },
    });

    expect(result).toEqual({
      exitCode: 2,
      reason: 'MCP stdio startup token must be non-empty',
    });
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
      params: { protocolVersion: '2025-11-25', capabilities: {} },
    });
    await waitForLine(output, (line) => line.id === 'init' && line.result !== undefined);

    input.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    input.send({ jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} });
    await waitForLine(output, (line) => line.id === 'tools' && line.result !== undefined);

    input.close();
    expect(await session).toEqual({ exitCode: 0 });
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
      params: { protocolVersion: '2025-11-25', capabilities: {} },
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
      (line) => line.method === MCP_TOOLS_LIST_CHANGED_NOTIFICATION,
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
  });

  it('rejects regular MCP traffic until initialize and notifications/initialized complete', async () => {
    const engine = createEngine();
    const input = controllableInput();
    const output = collectingOutput();

    const session = runMcpStdioSession({
      input: input.stream,
      output: output.stream,
      engine,
      admission: { kind: 'allow-unauthenticated-local-admin' },
    });

    input.send({ jsonrpc: '2.0', id: 'before-init', method: 'tools/list', params: {} });
    const beforeInit = await waitForLine(output, (line) => line.id === 'before-init');
    expect(beforeInit.error).toMatchObject({
      code: -32000,
      message: 'MCP session must be initialized before requests',
    });

    input.send({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {} },
    });
    await waitForLine(output, (line) => line.id === 'init' && line.result !== undefined);

    input.send({ jsonrpc: '2.0', id: 'before-ready', method: 'tools/list', params: {} });
    const beforeReady = await waitForLine(output, (line) => line.id === 'before-ready');
    expect(beforeReady.error).toMatchObject({
      code: -32000,
      message: 'MCP session must receive notifications/initialized before requests',
    });

    input.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    input.send({ jsonrpc: '2.0', id: 'after-ready', method: 'tools/list', params: {} });
    const afterReady = await waitForLine(output, (line) => line.id === 'after-ready');
    expect(afterReady.error).toBeUndefined();
    expect(afterReady.result).toMatchObject({ tools: expect.any(Array) });

    input.close();
    expect(await session).toEqual({ exitCode: 0 });
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
  });

  it('keeps resource subscriptions alive after the idle timeout when stdio is active', async () => {
    const engine = createEngine();
    const input = controllableInput();
    const output = collectingOutput();
    let now = 0;

    const session = runMcpStdioSession({
      input: input.stream,
      output: output.stream,
      engine,
      admission: { kind: 'allow-unauthenticated-local-admin' },
      sessionManagerOptions: {
        maximumSessions: 1,
        sessionIdleTimeoutMilliseconds: 100,
        currentTimeMilliseconds: () => now,
      },
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

    now = 150;
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

    input.close();
    const result = await session;
    expect(result.exitCode).toBe(0);
  });

  it('processes cancellation notifications while a workflow tool call is in flight', async () => {
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
      { timeoutMs: 2_000, intervalMs: 10, label: 'running stdio workflow' },
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
      { timeoutMs: 2_000, intervalMs: 10, label: 'stdio workflow cancellation' },
    );

    const cancelledLine = await waitForLine(output, (line) => line.id === 'pending');
    expect((cancelledLine.result as { isError?: boolean }).isError).toBe(true);

    input.close();
    const result = await session;
    expect(result.exitCode).toBe(0);
  });

  it('ignores invalid cancellation notifications and keeps the stdio session alive', async () => {
    const input = controllableInput();
    const output = collectingOutput();

    const session = runMcpStdioSession({
      input: input.stream,
      output: output.stream,
      engine: createEngine(),
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
  });
});
