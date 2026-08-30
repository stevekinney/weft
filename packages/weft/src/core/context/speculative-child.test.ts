import { describe, expect, it } from 'bun:test';

import { Context } from './index.ts';

describe('speculative child context', () => {
  it('inherits the parent workflow execution token', () => {
    const parent = new Context({
      workflowId: 'workflow-speculative-token',
      workflowExecutionToken: 'workflow-token-speculative',
      workflowType: 'speculative-token',
      startedAt: 1_700_000_000_000,
      abortController: new AbortController(),
    });

    const child = parent.createSpeculativeChild();

    expect(child.workflowExecutionToken).toBe('workflow-token-speculative');
  });
});
