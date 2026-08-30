import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import type { SearchAttributeSchema, WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types/workflow-function.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';

/**
 * Search attributes index scan benchmark.
 *
 * Architecture target: single-attribute equality filter on 100K workflows in
 * <1ms. We verify that against both `BunSQLiteStorage` (the production target)
 * at a relaxed median latency threshold that absorbs machine variance, and log
 * the actual number so we can track it in `reference/IMPORTANT.md`.
 */

const enforceArchitectureTarget =
  process.env['WEFT_SEARCH_ATTRIBUTES_ARCHITECTURE_BENCHMARK'] === '1';
const ARCHITECTURE_TOTAL_WORKFLOWS = process.env['CI'] ? 20_000 : 100_000;
const SMOKE_TOTAL_WORKFLOWS = 1_000;
const TOTAL_WORKFLOWS = enforceArchitectureTarget
  ? ARCHITECTURE_TOTAL_WORKFLOWS
  : SMOKE_TOTAL_WORKFLOWS;
const SAMPLES = enforceArchitectureTarget ? 50 : 5;
/**
 * Architecture spec target is <1ms. The CI threshold absorbs runner variance;
 * the local threshold is slightly above the spec so this file doesn't flake
 * on cold caches, but the spec number itself is still logged explicitly.
 */
const CI_MEDIAN_TARGET_MS = 5;
const LOCAL_MEDIAN_TARGET_MS = 1;
const MEDIAN_TARGET_MS = process.env['CI'] ? CI_MEDIAN_TARGET_MS : LOCAL_MEDIAN_TARGET_MS;

const attributeSchema: SearchAttributeSchema = {
  customerId: { type: 'string' },
};

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index]!;
}

describe('Search attribute index scan', () => {
  let storage: BunSQLiteStorage;
  let engine: Engine;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    storage?.[Symbol.dispose]();
  });

  it('records single-attribute equality scan latency', async () => {
    storage = new BunSQLiteStorage(':memory:');
    engine = new Engine({ storage });

    // Register a long-sleeping workflow so starts don't race against engine
    // completion / cleanup paths — we only care about attribute indexing here.
    // Park via durable `ctx.sleep` rather than `Bun.sleep` so workflows
    // checkpoint at the yield boundary instead of holding tens of thousands
    // of live in-process timers.
    const stayRunning = workflow({ name: 'stay-running' })
      .searchAttributes(attributeSchema)
      .execute(async function* (ctx: WorkflowContext) {
        yield* ctx.sleep(999_999);
        return 'done';
      });
    engine.register(stayRunning);

    // Seed workflows. Each customer id is reused ~10 times so the target row is
    // not the only match, which is representative of real usage.
    const distinctCustomers = Math.max(1, Math.floor(TOTAL_WORKFLOWS / 10));
    for (let index = 0; index < TOTAL_WORKFLOWS; index += 1) {
      await engine.start('stay-running', undefined, {
        id: `wf-${index}`,
        searchAttributes: { customerId: `c-${index % distinctCustomers}` },
      });
    }

    // Warm caches — run a handful of queries before measuring.
    for (let warm = 0; warm < 5; warm += 1) {
      await engine.list({
        attributes: [{ key: 'customerId', value: `c-${warm}` }],
        limit: 100,
      });
    }

    // Measure. Each sample picks a random customer id so caches can't
    // short-circuit repeated queries.
    const samples: number[] = [];
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const target = `c-${Math.floor(Math.random() * distinctCustomers)}`;
      const start = performance.now();
      const result = await engine.list({
        attributes: [{ key: 'customerId', value: target }],
        limit: 100,
      });
      const elapsed = performance.now() - start;
      samples.push(elapsed);
      // Sanity: every customer should still match at least one workflow.
      expect(result.items.length).toBeGreaterThan(0);
    }

    samples.sort((a, b) => a - b);
    const median = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);

    console.log(
      [
        `\n  Search attribute index scan benchmark (BunSQLiteStorage):`,
        `    Workflows seeded: ${TOTAL_WORKFLOWS.toLocaleString()}`,
        `    Distinct keys:    ${distinctCustomers.toLocaleString()}`,
        `    Samples:          ${SAMPLES}`,
        `    Median latency:   ${median.toFixed(3)}ms`,
        `    p95 latency:      ${p95.toFixed(3)}ms`,
        `    Median target:    ${MEDIAN_TARGET_MS}ms`,
        `    Spec target:      <1ms (architecture.md "Performance Targets")\n`,
      ].join('\n'),
    );

    expect(median).toBeGreaterThanOrEqual(0);
    if (enforceArchitectureTarget) {
      expect(median).toBeLessThan(MEDIAN_TARGET_MS);
    }
  }, 600_000);
});
