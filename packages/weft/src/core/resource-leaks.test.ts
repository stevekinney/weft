import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory.ts';
import { Engine } from './engine.ts';
import { workflow } from './types/workflow-function.ts';

// ---------------------------------------------------------------------------
// A6: Zero resource leaks test
//
// Create and complete 1000 workflows, verifying no meaningful heap growth
// occurs across iterations. This catches leaked handles, uncollected
// WeakRefs, lingering closures from result resolvers, or timers that
// hold engine references.
// ---------------------------------------------------------------------------

describe('Resource leaks', () => {
  it('1000 create/run/dispose cycles keep heap growth under 2MB', async () => {
    const ITERATIONS = 1000;
    const WARMUP = 100;
    const SNAPSHOT_INTERVAL = 100;

    const heapSnapshots: number[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const storage = new MemoryStorage();
      const engine = new Engine({ storage });

      const trivial = workflow({ name: 'trivial' }).execute(async function* () {
        return 'done';
      });
      engine.register(trivial);

      const handle = await engine.start('trivial', i);
      await handle.result();

      engine[Symbol.dispose]();
      storage[Symbol.dispose]();

      // Snapshot heap after warmup, at regular intervals
      if (i >= WARMUP && (i - WARMUP) % SNAPSHOT_INTERVAL === 0) {
        // Force GC if available (Bun exposes it)
        if (typeof Bun.gc === 'function') {
          Bun.gc(true);
        }
        const usage = process.memoryUsage();
        heapSnapshots.push(usage.heapUsed);
      }
    }

    // Verify we got enough snapshots
    expect(heapSnapshots.length).toBeGreaterThanOrEqual(2);

    // Check that the heap did not grow by more than 2MB between first and last snapshot
    const firstSnapshot = heapSnapshots[0]!;
    const lastSnapshot = heapSnapshots[heapSnapshots.length - 1]!;
    const growth = lastSnapshot - firstSnapshot;

    // Observed growth in steady state is < 500KB; 2MB gives a ~4x safety margin.
    const MAX_GROWTH_BYTES = 2 * 1024 * 1024;

    expect(growth).toBeLessThan(MAX_GROWTH_BYTES);
  }, 30_000); // generous timeout for 1000 iterations
});
