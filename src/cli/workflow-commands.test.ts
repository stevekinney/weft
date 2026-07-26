import { describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { serve } from '../server/index.ts';
import type { WorkflowCommand } from './types.ts';
import { executeWorkflow } from './workflow-commands.ts';

function createJsonRpcFixtureServer(resultFor: (method: string) => unknown) {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { id: string; method: string };
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: resultFor(body.method),
      });
    },
  });
  return { url: server.url.toString(), stop: () => server.stop() };
}

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function createServedEngine(): { engine: Engine; url: string; stop: () => Promise<void> } {
  const engine = new Engine();
  engine.register(echoWorkflow);
  const server = serve({ engine, port: 0 });
  return {
    engine,
    url: server.url.toString(),
    stop: async () => {
      await server.stop();
      engine[Symbol.dispose]();
    },
  };
}

const base = {
  command: 'workflow' as const,
  help: false,
  json: false,
  quiet: false,
};

describe('weft workflow start/get/events', () => {
  it('filters malformed workflow summaries and handles a missing items collection', async () => {
    let listCalls = 0;
    const server = createJsonRpcFixtureServer((method) =>
      method === 'weft.workflows.list'
        ? ++listCalls === 1
          ? { items: [{ id: 'only-id' }] }
          : {}
        : {},
    );
    try {
      const malformed = await executeWorkflow({
        ...base,
        action: 'ls',
        server: server.url,
      } satisfies WorkflowCommand);
      expect(malformed).toEqual({ stdout: 'No workflows found.', exitCode: 0 });

      const missingItems = await executeWorkflow({
        ...base,
        action: 'ls',
        server: server.url,
      } satisfies WorkflowCommand);
      expect(missingItems).toEqual({ stdout: 'No workflows found.', exitCode: 0 });
    } finally {
      await server.stop();
    }
  });

  it('formats human-readable event lines and non-record events', async () => {
    const server = createJsonRpcFixtureServer((method) =>
      method === 'weft.workflows.events.list'
        ? [null, { type: 'started', timestamp: 0 }, { timestamp: 'unknown' }]
        : {},
    );
    try {
      const result = await executeWorkflow({
        ...base,
        action: 'events',
        server: server.url,
        workflowId: 'wf-events',
      } satisfies WorkflowCommand);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('null');
      expect(result.stdout).toContain('started');
      expect(result.stdout).toContain('event');
    } finally {
      await server.stop();
    }
  });

  it('starts a workflow, then get and events surface it', async () => {
    const served = createServedEngine();
    try {
      const start = await executeWorkflow({
        ...base,
        action: 'start',
        server: served.url,
        workflowType: 'echo',
        input: '{"hello":"world"}',
        id: 'wf-cli-1',
      } satisfies WorkflowCommand);
      expect(start.exitCode).toBe(0);
      expect(start.stdout).toContain('wf-cli-1');

      const get = await executeWorkflow({
        ...base,
        action: 'get',
        server: served.url,
        workflowId: 'wf-cli-1',
        json: true,
      } satisfies WorkflowCommand);
      expect(get.exitCode).toBe(0);
      expect(JSON.parse(get.stdout)).toMatchObject({ id: 'wf-cli-1', type: 'echo' });

      const events = await executeWorkflow({
        ...base,
        action: 'events',
        server: served.url,
        workflowId: 'wf-cli-1',
        json: true,
      } satisfies WorkflowCommand);
      expect(events.exitCode).toBe(0);
      // Every emitted line is valid NDJSON (echo records no lifecycle events,
      // so the list may be empty — the command must still exit 0).
      const lines = events.stdout.split('\n').filter((line) => line.length > 0);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();

      const humanEvents = await executeWorkflow({
        ...base,
        action: 'events',
        server: served.url,
        workflowId: 'wf-cli-1',
      } satisfies WorkflowCommand);
      expect(humanEvents.exitCode).toBe(0);
    } finally {
      await served.stop();
    }
  });

  it('lists workflows as a table and as NDJSON', async () => {
    const served = createServedEngine();
    try {
      await executeWorkflow({
        ...base,
        action: 'start',
        server: served.url,
        workflowType: 'echo',
        id: 'wf-ls-1',
      } satisfies WorkflowCommand);

      const table = await executeWorkflow({
        ...base,
        action: 'ls',
        server: served.url,
      } satisfies WorkflowCommand);
      expect(table.exitCode).toBe(0);
      expect(table.stdout).toContain('wf-ls-1');
      // Verify header is padded to match data columns (ID=36, TYPE=20, STATUS=12).
      const firstLine = table.stdout.split('\n')[0]!;
      expect(firstLine.startsWith('ID' + ' '.repeat(34))).toBe(true);

      const json = await executeWorkflow({
        ...base,
        action: 'ls',
        server: served.url,
        json: true,
      } satisfies WorkflowCommand);
      expect(json.exitCode).toBe(0);
      const lines = json.stdout.split('\n').filter((line) => line.length > 0);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();

      const quiet = await executeWorkflow({
        ...base,
        action: 'ls',
        server: served.url,
        quiet: true,
      } satisfies WorkflowCommand);
      expect(quiet.exitCode).toBe(0);
      expect(quiet.stdout).toBe('wf-ls-1');
    } finally {
      await served.stop();
    }
  });
});

describe('weft workflow cancel (destructive gate)', () => {
  it('cancels when --yes bypasses the prompt', async () => {
    const served = createServedEngine();
    try {
      await executeWorkflow({
        ...base,
        action: 'start',
        server: served.url,
        workflowType: 'echo',
        id: 'wf-cancel-1',
      } satisfies WorkflowCommand);

      const result = await executeWorkflow({
        ...base,
        action: 'cancel',
        server: served.url,
        workflowId: 'wf-cancel-1',
        yes: true,
        dryRun: false,
      } satisfies WorkflowCommand);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Cancelled workflow wf-cancel-1');
    } finally {
      await served.stop();
    }
  });

  it('refuses on a non-TTY without --yes and takes no action', async () => {
    const served = createServedEngine();
    const priorIsTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await executeWorkflow({
        ...base,
        action: 'start',
        server: served.url,
        workflowType: 'echo',
        id: 'wf-cancel-guard',
      } satisfies WorkflowCommand);

      const result = await executeWorkflow({
        ...base,
        action: 'cancel',
        server: served.url,
        workflowId: 'wf-cancel-guard',
        yes: false,
        dryRun: false,
      } satisfies WorkflowCommand);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('without confirmation');

      // The workflow must still exist (not cancelled).
      const state = await served.engine.get('wf-cancel-guard');
      expect(state?.status).not.toBe('cancelled');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: priorIsTty,
        configurable: true,
      });
      await served.stop();
    }
  });

  it('returns a denied result when an interactive confirmation is declined', async () => {
    const server = createJsonRpcFixtureServer(() => ({ ok: true }));
    const priorIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const priorStream = Bun.stdin.stream;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Bun.stdin.stream = (() =>
      new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
          const input = new Uint8Array(new ArrayBuffer(2));
          input.set([110, 10]);
          controller.enqueue(input);
          controller.close();
        },
      })) as unknown as typeof Bun.stdin.stream;
    try {
      const result = await executeWorkflow({
        ...base,
        action: 'cancel',
        server: server.url,
        workflowId: 'wf-denied',
        yes: false,
        dryRun: false,
      } satisfies WorkflowCommand);
      expect(result).toEqual({ stdout: 'Cancelled (no action taken).', exitCode: 1 });
    } finally {
      Bun.stdin.stream = priorStream;
      if (priorIsTtyDescriptor === undefined) {
        Reflect.deleteProperty(process.stdin, 'isTTY');
      } else {
        Object.defineProperty(process.stdin, 'isTTY', priorIsTtyDescriptor);
      }
      await server.stop();
    }
  });

  it('--dry-run prints the affected count without cancelling', async () => {
    const served = createServedEngine();
    try {
      const result = await executeWorkflow({
        ...base,
        action: 'cancel',
        server: served.url,
        workflowId: 'wf-dry',
        yes: false,
        dryRun: true,
      } satisfies WorkflowCommand);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Would cancel 1 workflow');
    } finally {
      await served.stop();
    }
  });
});

describe('weft workflow signal', () => {
  it('signals a running workflow', async () => {
    const served = createServedEngine();
    try {
      await executeWorkflow({
        ...base,
        action: 'start',
        server: served.url,
        workflowType: 'echo',
        id: 'wf-signal-1',
      } satisfies WorkflowCommand);

      const result = await executeWorkflow({
        ...base,
        action: 'signal',
        server: served.url,
        workflowId: 'wf-signal-1',
        signalName: 'wake',
        input: '"payload"',
      } satisfies WorkflowCommand);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Signalled wake');
    } finally {
      await served.stop();
    }
  });

  it('surfaces local input errors for start and signal before calling the server', async () => {
    const served = createServedEngine();
    try {
      const start = await executeWorkflow({
        ...base,
        action: 'start',
        server: served.url,
        workflowType: 'echo',
        input: '{',
      } satisfies WorkflowCommand);
      expect(start.exitCode).toBe(3);
      expect(start.stderr).toContain('invalid JSON input');

      const signal = await executeWorkflow({
        ...base,
        action: 'signal',
        server: served.url,
        workflowId: 'wf-signal-1',
        signalName: 'wake',
        inputFile: '/definitely/missing.json',
      } satisfies WorkflowCommand);
      expect(signal.exitCode).toBe(3);
      expect(signal.stderr).toContain('input file not found');
    } finally {
      await served.stop();
    }
  });
});

describe('connection failures', () => {
  it('reports a connection error with exit code 2', async () => {
    const result = await executeWorkflow({
      ...base,
      action: 'get',
      server: 'http://127.0.0.1:1/',
      workflowId: 'wf-1',
    } satisfies WorkflowCommand);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('connection failed');
  });

  it('reports configuration errors before attempting a request', async () => {
    const result = await executeWorkflow({
      ...base,
      action: 'get',
      server: 'not-a-url',
      workflowId: 'wf-1',
    } satisfies WorkflowCommand);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('connection failed');
  });
});
