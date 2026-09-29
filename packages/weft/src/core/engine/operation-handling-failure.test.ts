import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { throwingRejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { Engine } from '../engine.ts';
import { workflow } from '../types.ts';

type Nested = { child?: Nested };

function nestedDeeperThanTheCodecAllows(): Nested {
  let value: Nested = {};
  for (let depth = 0; depth < 150; depth += 1) value = { child: value };
  return value;
}

describe('a workflow whose operation cannot be handled', () => {
  it('fails with the handling error instead of staying running forever', async () => {
    // The memo result is kept in the workflow's checkpoint, which the next
    // operation persists; msgpack rejects anything nested past 100 levels.
    const deep = workflow({ name: 'deep' }).execute(async function* (ctx) {
      const nested = yield* ctx.memo('nested', async () => nestedDeeperThanTheCodecAllows());
      yield* ctx.memo('after', async () => 'unreachable');
      return nested;
    });
    await using engine = await Engine.create({
      storage: new MemoryStorage(),
      recover: false,
      workflows: { deep },
    });

    const handle = await engine.start('deep', null, { id: 'deep-1' });

    expect(await throwingRejectionOf(handle.result())).toThrow(
      'checkpoint cannot be encoded: Too deep objects',
    );
    const snapshot = await handle.snapshot();
    expect(snapshot?.status).toBe('failed');
  });
});
