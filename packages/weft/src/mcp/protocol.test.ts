import { describe, expect, test } from 'bun:test';

import { principalFromApiKey } from "../embedded/backchannel/src/index.ts";
import type { Engine } from '../core/engine.ts';
import { assertScope } from './access.ts';
import { MCP_LEGACY_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION } from './protocol.ts';
import { isWorkflowSearchResourceUri, listMcpResourceTemplates } from './resources.ts';

describe('MCP protocol revisions', () => {
  test('serves 2026-07-28 first and 2025-11-25 as the legacy revision', () => {
    expect(MCP_PROTOCOL_VERSION).toBe('2026-07-28');
    expect(MCP_LEGACY_PROTOCOL_VERSION).toBe('2025-11-25');
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

  test('rejects anonymous and insufficiently scoped resource access', () => {
    expect(() =>
      assertScope(
        { engine: {} as Engine, principal: { method: 'unauthenticated' }, authRequired: true },
        'workflows:read',
        'Reading workflow resources',
      ),
    ).toThrow('Reading workflow resources requires authentication');

    expect(() =>
      assertScope(
        {
          engine: {} as Engine,
          principal: principalFromApiKey({ subject: 'operator', scopes: ['events:read'] }),
          authRequired: true,
        },
        'workflows:read',
        'Reading workflow resources',
      ),
    ).toThrow('Reading workflow resources requires workflows:read');
  });
});
