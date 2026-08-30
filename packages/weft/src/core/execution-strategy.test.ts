import { describe, expect, it } from 'bun:test';

import type { ExecutionStrategy } from './execution-strategy.ts';
import { InlineExecutionStrategy } from './inline-execution-strategy.ts';

describe('ExecutionStrategy interface', () => {
  it('InlineExecutionStrategy satisfies the ExecutionStrategy interface', () => {
    const strategy: ExecutionStrategy = new InlineExecutionStrategy({
      getRegistration: () => undefined,
      getNow: Date.now,
      maxNestingDepth: 10,
    });

    // Verify all interface methods exist
    expect(typeof strategy.startWorkflow).toBe('function');
    expect(typeof strategy.resumeWorkflow).toBe('function');
    expect(typeof strategy.cancelWorkflow).toBe('function');
    expect(typeof strategy.onMessage).toBe('function');
    expect(typeof strategy[Symbol.dispose]).toBe('function');
    expect(typeof strategy[Symbol.asyncDispose]).toBe('function');

    strategy[Symbol.dispose]();
  });
});
