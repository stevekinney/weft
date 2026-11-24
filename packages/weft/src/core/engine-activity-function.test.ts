import { describe, expect, it } from 'bun:test';

import { Engine } from './engine.ts';
import { activity } from './types.ts';

describe('Engine.getActivityFunction', () => {
  it('returns the function registered under a name, and undefined for an unknown one', async () => {
    const greet = activity({ name: 'greet', execute: async (name: string) => `hello ${name}` });
    const engine = await Engine.create({ activities: { greet } });

    try {
      const resolved = engine.getActivityFunction('greet');
      expect(await resolved?.('world')).toBe('hello world');
      expect(engine.getActivityFunction('missing')).toBeUndefined();
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
