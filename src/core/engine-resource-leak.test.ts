import { describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';

import { Engine } from './engine.ts';
import type { WorkflowContext } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await Bun.sleep(10);
}

/**
 * Count open file descriptors for the current process.
 * Uses /dev/fd on macOS and /proc/self/fd on Linux.
 */
function countFileDescriptors(): number {
  try {
    return readdirSync('/dev/fd').length;
  } catch {
    try {
      return readdirSync('/proc/self/fd').length;
    } catch {
      return -1;
    }
  }
}

/**
 * Force garbage collection and return heap usage in bytes.
 * Runs two GC passes — the first collects most garbage, the second
 * sweeps weak references and FinalizationRegistry callbacks.
 */
function measureHeap(): number {
  Bun.gc(true);
  Bun.gc(true);
  return process.memoryUsage().heapUsed;
}

// A trivial workflow for testing engine start cycles.
async function* trivialWorkflow(_context: WorkflowContext, input: unknown) {
  return input;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Engine resource leaks', () => {
  it('no file descriptor growth after 1000 create/dispose cycles', () => {
    // Warm-up: create and dispose a few engines to stabilize baseline
    for (let i = 0; i < 5; i++) {
      const engine = new Engine();
      engine.register('noop', trivialWorkflow);
      engine[Symbol.dispose]();
    }

    const baselineFds = countFileDescriptors();
    if (baselineFds === -1) {
      console.warn('Cannot measure file descriptors on this platform — skipping fd assertion');
      return;
    }

    for (let i = 0; i < 1000; i++) {
      const engine = new Engine();
      engine.register('noop', trivialWorkflow);
      engine[Symbol.dispose]();
    }

    const finalFds = countFileDescriptors();
    // Allow a small margin (2) for transient OS-level fd fluctuations
    expect(finalFds).toBeLessThanOrEqual(baselineFds + 2);
  });

  it('no memory growth after 1000 create/dispose cycles', () => {
    // Warm-up: let the runtime stabilize JIT and internal structures
    for (let i = 0; i < 50; i++) {
      const engine = new Engine();
      engine.register('noop', trivialWorkflow);
      engine[Symbol.dispose]();
    }

    const baselineHeap = measureHeap();

    for (let i = 0; i < 1000; i++) {
      const engine = new Engine();
      engine.register('noop', trivialWorkflow);
      engine[Symbol.dispose]();
    }

    const finalHeap = measureHeap();

    // Memory should not grow by more than 5 MB over the baseline.
    // A well-cleaned-up engine cycle should leave no lasting allocations.
    const growthMb = (finalHeap - baselineHeap) / (1024 * 1024);
    expect(growthMb).toBeLessThan(5);
  });

  it('no resource leaks when starting and disposing workflows', async () => {
    // Generous warm-up: async workflow execution triggers JIT compilation
    // and internal caching that must stabilize before the baseline sample.
    for (let i = 0; i < 100; i++) {
      const engine = new Engine();
      engine.register('noop', trivialWorkflow);
      const handle = await engine.start('noop', `warmup-${i}`);
      await handle.result();
      engine[Symbol.dispose]();
    }
    await flush();

    const baselineFds = countFileDescriptors();
    const baselineHeap = measureHeap();

    for (let i = 0; i < 1000; i++) {
      const engine = new Engine();
      engine.register('noop', trivialWorkflow);
      const handle = await engine.start('noop', `run-${i}`);
      await handle.result();
      engine[Symbol.dispose]();
    }
    await flush();

    const finalFds = countFileDescriptors();
    const finalHeap = measureHeap();

    // File descriptor check
    if (baselineFds !== -1) {
      expect(finalFds).toBeLessThanOrEqual(baselineFds + 2);
    }

    // Memory check — allow up to 10 MB headroom. Async workflows generate
    // more transient allocations (promises, generators, codec buffers) than
    // plain create/dispose cycles. The key assertion is bounded growth, not
    // zero growth: a genuine leak would show O(n) memory scaling.
    const growthMb = (finalHeap - baselineHeap) / (1024 * 1024);
    expect(growthMb).toBeLessThan(10);
  });
});
