import { describe, expect, it } from 'bun:test';

import { McpSession } from './session.ts';

describe('MCP session', () => {
  it('returns the tracked workflow for a request id', () => {
    const session = new McpSession('session-id', { method: 'unauthenticated' });

    session.trackRequest('request-1', 'workflow-123');

    expect(session.workflowForRequest('request-1')).toBe('workflow-123');
    expect(session.workflowForRequest(Symbol('invalid-id'))).toBeUndefined();
  });
});
