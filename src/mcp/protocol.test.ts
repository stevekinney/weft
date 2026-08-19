import { describe, expect, test } from 'bun:test';

import type { Engine } from '../core/engine.ts';
import { dispatchMcpMessage, type McpDispatchContext } from './dispatcher.ts';
import { internalError, invalidParams, methodNotFound, resourceNotFound } from './protocol.ts';
import { isWorkflowSearchResourceUri, listMcpResourceTemplates } from './resources.ts';
import { McpSession } from './session.ts';

describe('MCP protocol error responses', () => {
  test('builds each public error response with its canonical code and data shape', () => {
    expect(invalidParams(1, 'Invalid cursor', { cursor: 'bad' })).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'Invalid cursor', data: { cursor: 'bad' } },
    });
    expect(methodNotFound('request-2', 'unknown/method')).toEqual({
      jsonrpc: '2.0',
      id: 'request-2',
      error: {
        code: -32601,
        message: 'Unknown MCP method: unknown/method',
        data: { method: 'unknown/method' },
      },
    });
    expect(internalError(3)).toEqual({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32603, message: 'Internal error' },
    });
    expect(resourceNotFound('request-4', 'file:///missing')).toEqual({
      jsonrpc: '2.0',
      id: 'request-4',
      error: {
        code: -32002,
        message: 'Resource not found',
        data: { uri: 'file:///missing' },
      },
    });
  });
});

describe('MCP resource contracts', () => {
  test('lists every public workflow resource template', () => {
    expect(listMcpResourceTemplates()).toEqual([
      {
        uriTemplate: 'weft://workflows/{workflowId}/state',
        name: 'workflow_state',
        title: 'Workflow state',
        description: 'Read the current state for a Weft workflow.',
        mimeType: 'application/json',
      },
      {
        uriTemplate: 'weft://workflows/{workflowId}/events',
        name: 'workflow_events',
        title: 'Workflow events',
        description: 'Read the event log for a Weft workflow.',
        mimeType: 'application/json',
      },
      {
        uriTemplate: 'weft://workflows/{workflowId}/checkpoints',
        name: 'workflow_checkpoints',
        title: 'Workflow checkpoints',
        description: 'Read checkpoint history summaries for a Weft workflow.',
        mimeType: 'application/json',
      },
      {
        uriTemplate: 'weft://workflows/search{?status,type,tag,limit,offset}',
        name: 'workflow_search',
        title: 'Workflow search',
        description: 'List visible Weft workflows using query filters.',
        mimeType: 'application/json',
      },
    ]);
  });

  test('rejects malformed and non-search workflow resource URIs', () => {
    expect(isWorkflowSearchResourceUri('not a URL')).toBeFalse();
    expect(isWorkflowSearchResourceUri('weft://workflows/%E0%A4%A/state')).toBeFalse();
    expect(isWorkflowSearchResourceUri('weft://workflows/workflow-1/state')).toBeFalse();
  });
});

describe('MCP dispatcher resource responses', () => {
  const createContext = (): McpDispatchContext => {
    const session = new McpSession('session-id', { method: 'unauthenticated' });
    session.phase = 'ready';
    return {
      engine: {} as Engine,
      session,
      principal: session.principal,
      authRequired: false,
    };
  };

  test('dispatches resource templates and prompt-not-found responses', async () => {
    const context = createContext();

    expect(
      await dispatchMcpMessage(
        { jsonrpc: '2.0', id: 1, method: 'resources/templates/list' },
        context,
      ),
    ).toEqual({
      kind: 'response',
      response: {
        jsonrpc: '2.0',
        id: 1,
        result: { resourceTemplates: listMcpResourceTemplates() },
      },
    });
    expect(
      await dispatchMcpMessage({ jsonrpc: '2.0', id: 2, method: 'prompts/get' }, context),
    ).toEqual({
      kind: 'response',
      response: {
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32002, message: 'Prompt not found' },
      },
    });
  });

  test('unsubscribes resources and preserves canonical response errors', async () => {
    const context = createContext();
    const uri = 'weft://workflows/workflow-1/state';
    context.session.subscriptions.add(uri);

    expect(
      await dispatchMcpMessage(
        {
          jsonrpc: '2.0',
          id: 'unsubscribe',
          method: 'resources/unsubscribe',
          params: { uri },
        },
        context,
      ),
    ).toEqual({
      kind: 'response',
      response: { jsonrpc: '2.0', id: 'unsubscribe', result: {} },
    });
    expect(context.session.subscriptions.has(uri)).toBeFalse();

    expect(
      await dispatchMcpMessage(
        { jsonrpc: '2.0', id: 'unknown', method: 'unknown/method' },
        context,
      ),
    ).toEqual({
      kind: 'response',
      response: {
        jsonrpc: '2.0',
        id: 'unknown',
        error: {
          code: -32601,
          message: 'Unknown MCP method: unknown/method',
          data: { method: 'unknown/method' },
        },
      },
    });
  });
});
