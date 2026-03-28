/**
 * Benchmark: Memory per idle workflow ≤ 2KB.
 *
 * Verifies that idle workflows (checkpointed and waiting on a timer, signal,
 * or update) consume no more than 2KB each—both as serialized checkpoint blobs
 * and as live objects held in memory. Runs at 100K concurrent workflows to
 * prove the bound holds at scale.
 *
 * @module idle-workflow-memory.bench
 */

import { describe, expect, it } from 'bun:test';

import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { checkpointSizeBytes, serializeCheckpoint } from './checkpoint.ts';
import type { Checkpoint } from './types.ts';

const MAX_BYTES_PER_WORKFLOW = 2048; // 2KB
const WORKFLOW_COUNT = 100_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a realistic idle-workflow checkpoint: a workflow that has executed
 * one activity step and is now waiting (sleep / signal / update). This
 * represents the common case—not a bare-minimum checkpoint but one with
 * typical small locals and a single accumulated result.
 */
function createIdleCheckpoint(workflowId: string): Checkpoint {
  return {
    workflowId,
    step: 1,
    locals: {
      orderId: 'ord-a1b2c3d4',
      amount: 99.5,
      status: 'awaiting-approval',
    },
    accumulatedResults: [[0, { id: 'pay-xyz789' }]],
    pendingSignals: ['approval'],
    searchAttributes: {
      region: 'us-east-1',
      priority: 'normal',
    },
    version: '1.0.0',
    createdAt: 1711500000000,
  };
}

/**
 * Build a minimal idle checkpoint: a workflow that yielded immediately
 * with no locals and no accumulated results (e.g., `yield* ctx.sleep("1h")`
 * as the first operation).
 */
function createMinimalIdleCheckpoint(workflowId: string): Checkpoint {
  return {
    workflowId,
    step: 0,
    locals: {},
    accumulatedResults: [],
    pendingSignals: [],
    searchAttributes: {},
    version: '1.0.0',
    createdAt: 1711500000000,
  };
}

// ---------------------------------------------------------------------------
// Per-workflow serialized size
// ---------------------------------------------------------------------------

describe('idle workflow checkpoint size', () => {
  it('realistic idle checkpoint serializes to ≤ 2KB', () => {
    const checkpoint = createIdleCheckpoint('wf-benchmark-single');
    const size = checkpointSizeBytes(checkpoint);

    expect(size).toBeLessThanOrEqual(MAX_BYTES_PER_WORKFLOW);
  });

  it('minimal idle checkpoint serializes to ≤ 2KB', () => {
    const checkpoint = createMinimalIdleCheckpoint('wf-benchmark-minimal');
    const size = checkpointSizeBytes(checkpoint);

    expect(size).toBeLessThanOrEqual(MAX_BYTES_PER_WORKFLOW);
  });

  it('checkpoint with longer workflow ID still ≤ 2KB', () => {
    const longId = `wf-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const checkpoint = createIdleCheckpoint(longId);
    const size = checkpointSizeBytes(checkpoint);

    expect(size).toBeLessThanOrEqual(MAX_BYTES_PER_WORKFLOW);
  });

  it('checkpoint with several accumulated results still ≤ 2KB', () => {
    const checkpoint = createIdleCheckpoint('wf-multi-result');
    // Simulate a workflow that completed 5 small activities before going idle
    checkpoint.step = 5;
    checkpoint.accumulatedResults = [
      [0, { id: 'r-1' }],
      [1, { id: 'r-2' }],
      [2, { id: 'r-3' }],
      [3, { id: 'r-4' }],
      [4, { id: 'r-5' }],
    ];
    const size = checkpointSizeBytes(checkpoint);

    expect(size).toBeLessThanOrEqual(MAX_BYTES_PER_WORKFLOW);
  });
});

// ---------------------------------------------------------------------------
// 100K concurrent workflows — serialized (storage) memory
// ---------------------------------------------------------------------------

describe('100K concurrent idle workflows — serialized storage size', () => {
  it('average serialized size per workflow ≤ 2KB', () => {
    let totalBytes = 0;
    let maxBytes = 0;

    for (let i = 0; i < WORKFLOW_COUNT; i++) {
      const checkpoint = createIdleCheckpoint(`wf-${i}`);
      const bytes = serializeCheckpoint(checkpoint);
      totalBytes += bytes.byteLength;
      if (bytes.byteLength > maxBytes) {
        maxBytes = bytes.byteLength;
      }
    }

    const averageBytes = totalBytes / WORKFLOW_COUNT;

    expect(averageBytes).toBeLessThanOrEqual(MAX_BYTES_PER_WORKFLOW);
    expect(maxBytes).toBeLessThanOrEqual(MAX_BYTES_PER_WORKFLOW);
  });
});

// ---------------------------------------------------------------------------
// 100K concurrent workflows — in-memory (heap) footprint
// ---------------------------------------------------------------------------

describe('100K concurrent idle workflows — heap memory', () => {
  it('checkpoint blobs for 100K workflows fit within 2KB-per-workflow budget', () => {
    // Force GC before measuring baseline
    Bun.gc(true);
    const baselineHeap = process.memoryUsage().heapUsed;

    // Store serialized checkpoint blobs keyed by workflow ID, mirroring what
    // MemoryStorage holds for each idle workflow's checkpoint. This is the
    // dominant per-workflow cost — the architecture claims ~2KB (checkpoint).
    const storage = new Map<string, Uint8Array>();

    for (let i = 0; i < WORKFLOW_COUNT; i++) {
      const workflowId = `wf-${i}`;
      const checkpoint = createIdleCheckpoint(workflowId);
      const checkpointBytes = serializeCheckpoint(checkpoint);

      storage.set(KEYS.checkpoint(workflowId), checkpointBytes);
    }

    // Force GC and measure
    Bun.gc(true);
    const afterHeap = process.memoryUsage().heapUsed;

    const heapDelta = afterHeap - baselineHeap;
    const bytesPerWorkflow = heapDelta / WORKFLOW_COUNT;

    // Budget: serialized checkpoint blob + Map entry overhead (key string +
    // Uint8Array wrapper + Map bucket). The checkpoint blob itself is well
    // under 2KB; the Map overhead is the remaining headroom.
    expect(bytesPerWorkflow).toBeLessThanOrEqual(MAX_BYTES_PER_WORKFLOW);

    // Keep a reference so the Map isn't GC'd before measurement
    expect(storage.size).toBe(WORKFLOW_COUNT);
  });
});

// ---------------------------------------------------------------------------
// 100K concurrent workflows — MemoryStorage integration
// ---------------------------------------------------------------------------

describe('100K concurrent idle workflows — MemoryStorage integration', () => {
  it('stores and retrieves 100K workflow checkpoints within 2KB budget', async () => {
    const storage = new MemoryStorage();
    const sizes: number[] = [];

    // Store all checkpoints
    for (let i = 0; i < WORKFLOW_COUNT; i++) {
      const workflowId = `wf-${i}`;
      const checkpoint = createIdleCheckpoint(workflowId);
      const bytes = serializeCheckpoint(checkpoint);
      sizes.push(bytes.byteLength);
      await storage.put(KEYS.checkpoint(workflowId), bytes);
    }

    // Verify count
    expect(storage.size).toBe(WORKFLOW_COUNT);

    // Verify size invariant
    const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
    const averageBytes = totalBytes / WORKFLOW_COUNT;
    const maxBytes = Math.max(...sizes);

    expect(averageBytes).toBeLessThanOrEqual(MAX_BYTES_PER_WORKFLOW);
    expect(maxBytes).toBeLessThanOrEqual(MAX_BYTES_PER_WORKFLOW);

    // Spot-check: retrieve a random checkpoint and verify round-trip
    const spotCheckId = `wf-${Math.floor(WORKFLOW_COUNT / 2)}`;
    const retrieved = await storage.get(KEYS.checkpoint(spotCheckId));
    expect(retrieved).not.toBeNull();
    expect(retrieved!.byteLength).toBeLessThanOrEqual(MAX_BYTES_PER_WORKFLOW);
  });
});
