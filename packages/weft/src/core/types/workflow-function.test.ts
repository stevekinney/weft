import { describe, expect, it } from 'bun:test';

import { workflow } from './workflow-function.ts';

describe('workflow()', () => {
  it('builds a workflow definition via the chained builder', () => {
    const checkout = workflow({ name: 'checkout' }).execute(async function* (_ctx, input: string) {
      return input.toUpperCase();
    });

    expect(checkout.name).toBe('checkout');
    expect(checkout.handler).toBeDefined();
  });

  it('rejects empty-name options', () => {
    expect(() => workflow({ name: '' })).toThrow();
  });
});
