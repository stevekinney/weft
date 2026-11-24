/**
 * Dual-era conformance: the official SDK client, pinned to 2026-07-28 or
 * speaking the 2025-11-25 `initialize` handshake, against one Weft MCP
 * endpoint served through the SDK's HTTP entry. Every behavior below is
 * asserted in both eras.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { waitForCondition } from "../../test-support/embedded/testing/src/fake-timers.ts";
import { throwingRejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types/workflow-function.ts';
import { createMcpEndpoint, type McpEndpoint, type McpEndpointOptions } from './http.ts';
import { connectInProcessClient, type NegotiationMode } from './mcp-client.test-support.ts';
import { MCP_LEGACY_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION } from './protocol.ts';
import { listMcpResourceTemplates } from './resources.ts';
import { listMcpTools } from './tools.ts';

const eras: Array<{ era: 'modern' | 'legacy'; mode: NegotiationMode; version: string }> = [
  { era: 'modern', mode: { pin: MCP_PROTOCOL_VERSION }, version: MCP_PROTOCOL_VERSION },
  { era: 'legacy', mode: 'legacy', version: MCP_LEGACY_PROTOCOL_VERSION },
];

let engines: Engine[] = [];
let endpoints: McpEndpoint[] = [];
afterEach(async () => {
  await Promise.all(endpoints.map((endpoint) => endpoint[Symbol.asyncDispose]()));
  for (const engine of engines) engine[Symbol.dispose]();
  endpoints = [];
  engines = [];
});

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engines.push(engine);
  engine.register(
    workflow({
      name: 'greet-customer',
      description: 'Greet a customer by name.',
      inputSchema: z.object({ name: z.string() }),
    }).execute(async function* (_context: WorkflowContext, input: { name: string }) {
      return { message: `Hello, ${input.name}!` };
    }),
  );
  engine.register(
    workflow({
      name: 'hold',
      description: 'Wait for a release signal.',
      inputSchema: z.object({}),
    }).execute(async function* (context: WorkflowContext) {
      return yield* context.waitForSignal<string>('release');
    }),
  );
  return engine;
}

function createEndpoint(engine: Engine, options?: McpEndpointOptions): McpEndpoint {
  const endpoint = createMcpEndpoint(engine, options);
  endpoints.push(endpoint);
  return endpoint;
}

function toolJson(result: unknown): unknown {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]!.text);
}

async function runningWorkflowOf(engine: Engine, type: string): Promise<string> {
  let workflowId = '';
  await waitForCondition(
    async () => {
      const list = await engine.list({ type });
      workflowId = list.items.find((item) => item.status === 'running')?.id ?? '';
      return workflowId.length > 0;
    },
    { intervalMs: 10, label: `running ${type} workflow` },
  );
  return workflowId;
}

describe.each(eras)('MCP conformance ($era era)', ({ era, mode, version }) => {
  it('negotiates the era and lists the operation-catalog tool projection', async () => {
    const engine = createEngine();
    const { client } = await connectInProcessClient(createEndpoint(engine), mode);
    try {
      expect(client.getProtocolEra()).toBe(era);
      expect(client.getNegotiatedProtocolVersion()).toBe(version);
      const { tools } = await client.listTools();
      const projection = listMcpTools(engine);
      expect(tools.map((tool) => tool.name)).toEqual(projection.map((tool) => tool.name));
      for (const definition of projection) {
        const listed = tools.find((tool) => tool.name === definition.name);
        expect(listed?.description).toBe(definition.description);
        expect(listed?.inputSchema as unknown).toEqual(definition.inputSchema);
      }
    } finally {
      await client.close();
    }
  });

  it('runs workflow tools and built-in tools, and validates arguments', async () => {
    const engine = createEngine();
    const { client } = await connectInProcessClient(createEndpoint(engine), mode);
    try {
      const greeted = await client.callTool({
        name: 'greet_customer',
        arguments: { input: { name: 'Ada' } },
      });
      expect(greeted.isError).toBe(false);
      const { workflowId } = toolJson(greeted) as { workflowId: string };
      expect(toolJson(greeted)).toEqual({ workflowId, result: { message: 'Hello, Ada!' } });

      const listed = await client.callTool({ name: 'list_workflows', arguments: {} });
      expect(toolJson(listed)).toMatchObject({
        items: [expect.objectContaining({ id: workflowId, status: 'completed' })],
      });

      const invalid = await client.callTool({
        name: 'greet_customer',
        arguments: { input: { name: 42 } },
      });
      expect(invalid.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('lists resource templates and reads workflow resources', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', {}, { id: `resource-${era}` });
    const { client } = await connectInProcessClient(createEndpoint(engine), mode);
    try {
      const { resourceTemplates } = await client.listResourceTemplates();
      expect(resourceTemplates).toEqual(listMcpResourceTemplates());

      const { resources } = await client.listResources();
      expect(resources.map((resource) => resource.uri)).toContain(
        `weft://workflows/${handle.id}/state`,
      );

      const state = await client.readResource({ uri: `weft://workflows/${handle.id}/state` });
      expect(JSON.parse((state.contents[0] as { text: string }).text)).toMatchObject({
        id: handle.id,
        type: 'hold',
      });

      const search = await client.readResource({ uri: 'weft://workflows/search?type=hold' });
      expect(JSON.parse((search.contents[0] as { text: string }).text)).toMatchObject({
        items: [expect.objectContaining({ id: handle.id })],
      });
    } finally {
      await client.close();
      await engine.cancel(handle.id);
    }
  });

  it('cancels the workflow a tool started as far as the era allows', async () => {
    const engine = createEngine();
    const { client } = await connectInProcessClient(createEndpoint(engine), mode);
    try {
      const request = new AbortController();
      const call = client.callTool(
        { name: 'hold', arguments: { input: {} } },
        { signal: request.signal },
      );
      call.catch(() => {});
      const workflowId = await runningWorkflowOf(engine, 'hold');
      request.abort(new Error('user pressed stop'));
      expect(await throwingRejectionOf(call)).toThrow();
      if (era === 'modern') {
        // 2026-07-28: closing the request's response stream aborts the call,
        // and the tool cancels the workflow it started.
        await waitForCondition(
          async () => {
            const state = await engine.get(workflowId);
            return state?.status === 'cancelled';
          },
          { intervalMs: 10, label: 'cancelled workflow' },
        );
      } else {
        // The stateless 2025 lane answers `notifications/cancelled` on a fresh
        // per-request instance that does not own the running call, so the
        // workflow keeps running. Sessionful 2025 transports (stdio) cancel.
        const state = await engine.get(workflowId);
        expect(state?.status).toBe('running');
        await engine.cancel(workflowId);
      }
    } finally {
      await client.close();
    }
  });

  it('serves the tools a registrar adds next to the projection', async () => {
    const engine = createEngine();
    const endpoint = createEndpoint(engine, {
      registrars: (server, context) => {
        server.registerTool('describe_context', { description: 'Report the era.' }, async () => ({
          content: [{ type: 'text', text: JSON.stringify({ era: context.era }) }],
        }));
      },
    });
    const { client } = await connectInProcessClient(endpoint, mode);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain('describe_context');
      expect(tools.map((tool) => tool.name)).toContain('greet_customer');
      const described = await client.callTool({ name: 'describe_context', arguments: {} });
      expect(toolJson(described)).toEqual({ era });
    } finally {
      await client.close();
    }
  });
});

describe('MCP conformance (transport behavior owned by the SDK)', () => {
  it('sends Mcp-Method and Mcp-Name on 2026-07-28 requests', async () => {
    const engine = createEngine();
    const { client, exchanges } = await connectInProcessClient(createEndpoint(engine), {
      pin: MCP_PROTOCOL_VERSION,
    });
    try {
      await client.callTool({ name: 'greet_customer', arguments: { input: { name: 'Ada' } } });
      const call = exchanges.find((exchange) => exchange.method === 'tools/call');
      expect(call?.headers['mcp-method']).toBe('tools/call');
      expect(call?.headers['mcp-name']).toBe('greet_customer');
      expect(call?.headers['mcp-protocol-version']).toBe(MCP_PROTOCOL_VERSION);
    } finally {
      await client.close();
    }
  });

  it('lands an auto-negotiating client on 2026-07-28', async () => {
    const engine = createEngine();
    const { client } = await connectInProcessClient(createEndpoint(engine), 'auto');
    try {
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getNegotiatedProtocolVersion()).toBe(MCP_PROTOCOL_VERSION);
    } finally {
      await client.close();
    }
  });

  it('announces a tool-list change to a 2026-07-28 listener', async () => {
    const engine = createEngine();
    const { client } = await connectInProcessClient(createEndpoint(engine), {
      pin: MCP_PROTOCOL_VERSION,
    });
    try {
      const changed = new Promise<void>((resolve) => {
        client.setNotificationHandler('notifications/tools/list_changed', () => {
          resolve();
        });
      });
      await client.listen({ toolsListChanged: true });
      engine.register(
        workflow({ name: 'late-arrival', inputSchema: z.object({}) }).execute(async function* () {
          return { ok: true };
        }),
      );
      await changed;
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain('late_arrival');
    } finally {
      await client.close();
    }
  });
});
