import { describe, expect, it } from 'bun:test';

import type { WorkflowContext } from '../index.ts';
import { Engine, serve, workflow } from '../index.ts';
import type { WorkflowCommand } from './types.ts';
import { executeWorkflow } from './workflow-commands.ts';

function createJsonRpcFixtureServer(resultFor: (method: string) => unknown) {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json();
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return Response.json({ jsonrpc: '2.0', id: null, result: resultFor('') });
      }
      const id = 'id' in body && typeof body.id === 'string' ? body.id : '';
      const method = 'method' in body && typeof body.method === 'string' ? body.method : '';
      return Response.json({
        jsonrpc: '2.0',
        id,
        result: resultFor(method),
      });
    },
  });
  return { url: server.url.toString(), stop: () => server.stop() };
}

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  yield* [];
  return input;
});

function createServedEngine(): { engine: Engine; url: string; stop: () => Promise<void> } {
  const engine = new Engine();
  engine.register(echoWorkflow);
  const server = serve({ engine, port: 0 });
  return {
    engine,
    url: server.url,
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
