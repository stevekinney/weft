import { describe, expect, it } from 'bun:test';

import { CompressedStorage } from '../../storage/compressed-storage.ts';
import type { Storage } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { Engine } from '../engine.ts';
import type { WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';
import { StartOrSignalConflictError } from './errors.ts';

const waitForRelease = workflow({ name: 'wait-for-release' }).execute(async function* (
  ctx: WorkflowContext,
) {
  return yield* ctx.waitForSignal<string>('release');
});

const completesImmediately = workflow({ name: 'completes-immediately' }).execute(
  async function* () {
    return 'done';
  },
);

function createEngine(storage: Storage = new MemoryStorage()): Engine {
  const engine = new Engine({ storage });
  engine.register(waitForRelease);
  engine.register(completesImmediately);
  return engine;
}

/**
 * Count durable workflow records currently in storage. The record key is exactly
 * `wf:<encoded-id>` (one structural colon); sub-keys like the checkpoint
 * `wf:<id>:ckpt` carry a second colon and are excluded, since a raw `:` in a key
 * always denotes a separator (ids encode their own colons as `%3A`).
 */
async function countWorkflowRecords(engine: Engine): Promise<number> {
  let count = 0;
  for await (const [key] of engine.storage.scan('wf:')) {
    if (key.indexOf(':', 'wf:'.length) === -1) {
      count += 1;
    }
  }
  return count;
}

/**
 * Load-bearing precondition for atomic startOrSignal: a workflow consumes a
 * signal that was durably present BEFORE it first ran. `processWaitSignalOperation`
 * is scan-then-park — it calls `consumeSignal` (a durable storage scan) before
 * registering any in-memory waiter — so a signal sitting in storage at launch is
 * found on first drive rather than orphaned.
 */
describe('signal buffered before a workflow starts', () => {
  it('is consumed on the first drive when present in storage at launch', async () => {
    const engine = createEngine();
    try {
      const workflowId = 'buffered-before-start';
      await engine.signal(workflowId, 'release', 'unblocked', { signalId: 'sig-1' });
      const handle = await engine.start('wait-for-release', null, { id: workflowId });
      expect(await handle.result()).toBe('unblocked');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('dedupes a duplicate signalId so a second identical signal is a no-op', async () => {
    const engine = createEngine();
    try {
      const workflowId = 'dedupe-before-start';
      await engine.signal(workflowId, 'release', 'first', { signalId: 'dup' });
      await engine.signal(workflowId, 'release', 'second', { signalId: 'dup' });
      const handle = await engine.start('wait-for-release', null, { id: workflowId });
      expect(await handle.result()).toBe('first');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});

describe('engine.start idempotency', () => {
  it('returns the same handle for a duplicate idempotency key', async () => {
    const engine = createEngine();
    try {
      const first = await engine.start('wait-for-release', null, { idempotencyKey: 'key-1' });
      const second = await engine.start('wait-for-release', null, { idempotencyKey: 'key-1' });
      expect(second.id).toBe(first.id);
      expect(await countWorkflowRecords(engine)).toBe(1);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('returns the existing handle for a duplicate key even after the run is terminal', async () => {
    const engine = createEngine();
    try {
      const first = await engine.start('completes-immediately', null, { idempotencyKey: 'term-1' });
      expect(await first.result()).toBe('done');

      const second = await engine.start('completes-immediately', null, {
        idempotencyKey: 'term-1',
      });
      expect(second.id).toBe(first.id);
      // Dedup never restarts: the terminal handle is returned, not a fresh run.
      expect(await second.result()).toBe('done');
      expect(await countWorkflowRecords(engine)).toBe(1);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('creates distinct workflows for distinct idempotency keys', async () => {
    const engine = createEngine();
    try {
      const first = await engine.start('wait-for-release', null, { idempotencyKey: 'a' });
      const second = await engine.start('wait-for-release', null, { idempotencyKey: 'b' });
      expect(second.id).not.toBe(first.id);
      expect(await countWorkflowRecords(engine)).toBe(2);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('throws when the storage backend lacks conditionalBatch', async () => {
    const engine = createEngine(new CompressedStorage(new MemoryStorage()));
    try {
      await expect(
        engine.start('wait-for-release', null, { idempotencyKey: 'no-cas' }),
      ).rejects.toThrow(/conditionalBatch/);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('converges concurrent same-key starts to one workflow and one shared handle id', async () => {
    const engine = createEngine();
    try {
      const [a, b, c] = await Promise.all([
        engine.start('wait-for-release', null, { idempotencyKey: 'race' }),
        engine.start('wait-for-release', null, { idempotencyKey: 'race' }),
        engine.start('wait-for-release', null, { idempotencyKey: 'race' }),
      ]);
      expect(b.id).toBe(a.id);
      expect(c.id).toBe(a.id);
      expect(await countWorkflowRecords(engine)).toBe(1);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});

describe('engine.startOrSignal', () => {
  it('creates the workflow and delivers the signal when the target is absent', async () => {
    const engine = createEngine();
    try {
      const handle = await engine.startOrSignal(
        'wait-for-release',
        null,
        { name: 'release', payload: 'go', signalId: 'sig-create' },
        { id: 'sos-create' },
      );
      expect(handle.id).toBe('sos-create');
      expect(await handle.result()).toBe('go');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('signals an existing running workflow without starting a second run', async () => {
    const engine = createEngine();
    try {
      const started = await engine.start('wait-for-release', null, { id: 'sos-existing' });

      const handle = await engine.startOrSignal(
        'wait-for-release',
        null,
        { name: 'release', payload: 'late', signalId: 'sig-existing' },
        { id: 'sos-existing' },
      );
      expect(handle.id).toBe(started.id);
      expect(await started.result()).toBe('late');
      expect(await countWorkflowRecords(engine)).toBe(1);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('signals a suspended workflow, which delivers on resume (non-terminal target)', async () => {
    const engine = createEngine();
    try {
      const started = await engine.start('wait-for-release', null, { id: 'sos-suspended' });
      await engine.suspend('sos-suspended');

      await engine.startOrSignal(
        'wait-for-release',
        null,
        { name: 'release', payload: 'after-suspend', signalId: 'sig-suspended' },
        { id: 'sos-suspended' },
      );

      await engine.resume('sos-suspended');
      expect(await started.result()).toBe('after-suspend');
      expect(await countWorkflowRecords(engine)).toBe(1);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('throws StartOrSignalConflictError when the target is terminal', async () => {
    const engine = createEngine();
    try {
      const completed = await engine.start('completes-immediately', null, { id: 'sos-terminal' });
      expect(await completed.result()).toBe('done');

      await expect(
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release', payload: 'too-late', signalId: 'sig-terminal' },
          { id: 'sos-terminal' },
        ),
      ).rejects.toBeInstanceOf(StartOrSignalConflictError);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('requires a signalId or idempotencyKey for convergence', async () => {
    const engine = createEngine();
    try {
      await expect(
        engine.startOrSignal('wait-for-release', null, { name: 'release', payload: 'x' }, {}),
      ).rejects.toThrow(/signalId or options\.idempotencyKey/);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('derives the signalId from the idempotency key so different caller ids still converge', async () => {
    // Two concurrent callers, SAME idempotencyKey, DIFFERENT caller-supplied
    // signalIds. Convergence must rely on the key-derived id, not the caller's
    // signalId — so exactly one signal is delivered to one workflow.
    const engine = createEngine();
    try {
      const [a, b] = await Promise.all([
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release', payload: 'from-a' },
          { idempotencyKey: 'converge' },
        ),
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release', payload: 'from-b' },
          { idempotencyKey: 'converge' },
        ),
      ]);
      expect(b.id).toBe(a.id);
      expect(await countWorkflowRecords(engine)).toBe(1);

      // Exactly one signal landed: the workflow resolves to one of the two
      // payloads and there is no buffered second signal left in storage.
      const result = (await a.result()) as string;
      expect(['from-a', 'from-b']).toContain(result);

      let remainingSignals = 0;
      for await (const _entry of engine.storage.scan(`sig:${a.id}:release:`)) {
        remainingSignals += 1;
      }
      expect(remainingSignals).toBe(0);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('converges concurrent absent-target callers to one workflow and one signal', async () => {
    const engine = createEngine();
    try {
      const [a, b, c] = await Promise.all([
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release', payload: 'go', signalId: 'same-id' },
          { id: 'sos-concurrent' },
        ),
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release', payload: 'go', signalId: 'same-id' },
          { id: 'sos-concurrent' },
        ),
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release', payload: 'go', signalId: 'same-id' },
          { id: 'sos-concurrent' },
        ),
      ]);
      expect(b.id).toBe(a.id);
      expect(c.id).toBe(a.id);
      expect(await countWorkflowRecords(engine)).toBe(1);
      expect(await a.result()).toBe('go');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('throws when the storage backend lacks conditionalBatch', async () => {
    const engine = createEngine(new CompressedStorage(new MemoryStorage()));
    try {
      await expect(
        engine.startOrSignal(
          'wait-for-release',
          null,
          { name: 'release', payload: 'x', signalId: 'no-cas' },
          { id: 'sos-no-cas' },
        ),
      ).rejects.toThrow(/conditionalBatch/);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('persists a key→id mapping so startOrSignal can dedup by idempotency key', async () => {
    const engine = createEngine();
    try {
      const created = await engine.startOrSignal(
        'wait-for-release',
        null,
        { name: 'release', payload: 'first' },
        { idempotencyKey: 'sos-key' },
      );
      const mapping = await engine.storage.get(KEYS.startIdempotency('sos-key'));
      expect(mapping).not.toBeNull();

      // A second startOrSignal with the same key resolves the mapping and
      // signals the existing run instead of creating a new one.
      const again = await engine.startOrSignal(
        'wait-for-release',
        null,
        { name: 'release', payload: 'second' },
        { idempotencyKey: 'sos-key' },
      );
      expect(again.id).toBe(created.id);
      expect(await countWorkflowRecords(engine)).toBe(1);
      expect(await created.result()).toBe('first');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});
