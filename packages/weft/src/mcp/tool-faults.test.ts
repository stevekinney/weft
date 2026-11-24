/**
 * A failed MCP tool call reports a structured fault (`code`, `message`, `retryable`,
 * `remediation?`) beside its text, for each of the seven built-in tools and for a workflow tool.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { anonymousPrincipal, principalFromApiKey } from "../embedded/backchannel/src/index.ts";
import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types/workflow-function.ts';
import { createMcpEndpoint, type McpEndpoint } from './http.ts';
import { connectInProcessClient } from './mcp-client.test-support.ts';
import { MCP_PROTOCOL_VERSION } from './protocol.ts';
import { callMcpTool, type McpToolResult } from './tools.ts';

type McpToolFault = NonNullable<McpToolResult['structuredContent']>;

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
    workflow({ name: 'echo', inputSchema: z.object({}) }).execute(async function* (
      _context: WorkflowContext,
      input: unknown,
    ) {
      yield* [];
      return input;
    }),
  );
  return engine;
}

const open = (engine: Engine) => ({
  engine,
  principal: anonymousPrincipal(),
  authRequired: false,
});

function faultOf(result: McpToolResult): McpToolFault {
  expect(result.isError).toBe(true);
  const fault = result.structuredContent;
  if (fault === undefined) throw new Error('expected structuredContent');
  // The text content stays the message, for a host that ignores structuredContent.
  expect(result.content).toEqual([{ type: 'text', text: fault.message }]);
  return fault;
}

describe('MCP tool faults', () => {
  it('reports a missing workflow as NotFound with a next step, for each tool that reads one', async () => {
    const context = open(createEngine());
    const calls: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['signal_workflow', { workflowId: 'missing', signalName: 'go' }],
      ['update_workflow', { workflowId: 'missing', updateName: 'change' }],
      ['query_workflow', { workflowId: 'missing', queryName: 'state' }],
      ['cancel_workflow', { workflowId: 'missing' }],
      ['get_workflow_state', { workflowId: 'missing' }],
    ];
    for (const [name, argumentsValue] of calls) {
      expect(faultOf(await callMcpTool(name, argumentsValue, context))).toEqual({
        code: 'NotFound',
        message: 'Workflow "missing" not found',
        retryable: false,
        remediation: 'Call list_workflows to find a workflow id that exists',
      });
    }
  });

  it('reports a refused argument as InvalidParams, for start_workflow and list_workflows', async () => {
    const context = open(createEngine());
    expect(faultOf(await callMcpTool('start_workflow', {}, context))).toMatchObject({
      code: 'InvalidParams',
      message: 'Tool argument "type" must be a non-empty string',
      retryable: false,
    });
    expect(faultOf(await callMcpTool('list_workflows', { limit: -1 }, context))).toMatchObject({
      code: 'InvalidParams',
      message: 'List filter limit must be a non-negative integer',
      retryable: false,
    });
  });

  it('reports an unregistered workflow type and a taken id from the engine, not a masked failure', async () => {
    const context = open(createEngine());
    expect(
      faultOf(await callMcpTool('start_workflow', { type: 'nothing-registered' }, context)),
    ).toMatchObject({
      code: 'InvalidParams',
      remediation: 'Use a workflow type that is registered on this engine',
    });

    const started = await callMcpTool('start_workflow', { type: 'echo', id: 'taken' }, context);
    expect(started.isError).toBe(false);
    expect(
      faultOf(await callMcpTool('start_workflow', { type: 'echo', id: 'taken' }, context)),
    ).toMatchObject({
      code: 'Conflict',
      retryable: false,
      remediation: 'Choose a different id, or omit id to let the engine generate one',
    });
  });

  it('reports a caller without authentication as Unauthorized and one without the scope as Forbidden', async () => {
    const engine = createEngine();
    expect(
      faultOf(
        await callMcpTool(
          'list_workflows',
          {},
          { engine, principal: anonymousPrincipal(), authRequired: true },
        ),
      ),
    ).toMatchObject({
      code: 'Unauthorized',
      message: 'Listing workflows requires authentication',
      retryable: false,
      remediation: 'Authenticate the MCP connection, then call the tool again',
    });

    const reader = principalFromApiKey({ subject: 'reader', scopes: ['workflows:read'] });
    expect(
      faultOf(
        await callMcpTool(
          'cancel_workflow',
          { workflowId: 'any' },
          { engine, principal: reader, authRequired: true },
        ),
      ),
    ).toMatchObject({
      code: 'Forbidden',
      message: 'Cancelling workflows requires workflows:write',
      retryable: false,
      remediation: 'Connect with a credential that has the workflows:write scope',
    });
  });

  it('reports an unknown tool as MethodNotFound, and masks an unexpected failure as EngineFailure', async () => {
    const engine = createEngine();
    expect(faultOf(await callMcpTool('missing_tool', {}, open(engine)))).toEqual({
      code: 'MethodNotFound',
      message: 'Unknown tool: missing_tool',
      retryable: false,
      remediation: 'Call tools/list for the tools this server offers',
    });

    engine.register(
      workflow({ name: 'explode', inputSchema: z.object({}) }).execute(async function* () {
        yield* [];
        throw new Error('secret implementation detail');
      }),
    );
    expect(faultOf(await callMcpTool('explode', { input: {} }, open(engine)))).toEqual({
      code: 'EngineFailure',
      message: 'Tool execution failed',
      retryable: false,
    });
  });

  it('delivers structuredContent through the SDK server alongside the text', async () => {
    const engine = createEngine();
    const endpoint = createMcpEndpoint(engine);
    endpoints.push(endpoint);
    const { client } = await connectInProcessClient(endpoint, { pin: MCP_PROTOCOL_VERSION });
    try {
      const result = await client.callTool({
        name: 'get_workflow_state',
        arguments: { workflowId: 'missing' },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        code: 'NotFound',
        message: 'Workflow "missing" not found',
        retryable: false,
        remediation: 'Call list_workflows to find a workflow id that exists',
      });
      expect(result.content).toEqual([{ type: 'text', text: 'Workflow "missing" not found' }]);
    } finally {
      await client.close();
    }
  });
});
