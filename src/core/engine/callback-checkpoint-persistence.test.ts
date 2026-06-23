import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { workflow } from '../types.ts';
import { persistCheckpointForDataOperation } from './callback-checkpoint-persistence.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';

describe('persistCheckpointForDataOperation', () => {
  it('routes checkpoint persistence through engine callbacks and enforces the history circuit breaker', async () => {
    const storage = new MemoryStorage();
    const definition = workflow({ name: 'park-for-checkpoint' }).execute(async function* (ctx) {
      yield* ctx.waitForSignal('never');
      return 'done';
    });

    await using engine = new Engine({ storage });
    engine.register(definition);
    const handle = await engine.start('park-for-checkpoint', null, { id: 'park-for-checkpoint-1' });

    getInternals(engine).options.historyPolicy = { maxEvents: 0, retentionWindow: null };

    await persistCheckpointForDataOperation(engine, handle.id, {
      type: 'archive',
      operationId: 'archive-op',
      key: 'snapshot',
      data: { hello: 'world' },
    });

    await expect(handle.result()).rejects.toThrow('exceeded execution timeout');
  });
});
