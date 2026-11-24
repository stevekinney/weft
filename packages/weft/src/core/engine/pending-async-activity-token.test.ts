import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { Engine } from '../engine.ts';
import { getInternals } from './internals.ts';
import { isPendingAsyncActivityToken } from './pending-async-activity-token.ts';

describe('isPendingAsyncActivityToken', () => {
  it('is false for an object that never went through new Engine()', () => {
    expect(isPendingAsyncActivityToken({}, 'token')).toBe(false);
  });

  it('reports only tokens the engine currently holds as pending', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    expect(isPendingAsyncActivityToken(engine, 'token')).toBe(false);

    const pending = getInternals(engine).pendingAsyncActivities;
    pending.set('token', {} as never);
    expect(isPendingAsyncActivityToken(engine, 'token')).toBe(true);

    pending.delete('token');
    expect(isPendingAsyncActivityToken(engine, 'token')).toBe(false);
  });
});
