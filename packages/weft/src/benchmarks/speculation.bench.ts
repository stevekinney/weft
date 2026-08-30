import { describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import {
  registerOnRuntimeEngine,
  runtimeWorkflowEngine,
  type RuntimeWorkflowEngine,
} from '../core/runtime-workflow-engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { activity, workflow } from '../core/types.ts';

/**
 * Track 3 speculation benchmark.
 *
 * The architecture note describes a 5-turn workload with 500ms mock tool
 * latency. Running that exact timing in the default test suite would take
 * several minutes, so the benchmark keeps the ratio-identical structure but
 * defaults to a smaller latency. Set `WEFT_SPECULATION_BENCH_LATENCY_MS=500`
 * to run the full-fat manual benchmark locally.
 */

const TURN_COUNT = 5;
const RUNS = 100;
const TOOL_LATENCY_MS = Number(process.env['WEFT_SPECULATION_BENCH_LATENCY_MS'] ?? 5);
const TARGET_REDUCTION = 0.3;

async function measureWorkflowDuration(
  engine: RuntimeWorkflowEngine,
  type: string,
  runs: number,
): Promise<number> {
  const start = performance.now();

  for (let index = 0; index < runs; index++) {
    const handle = await engine.start(type, null, { id: `${type}-${index}` });
    const result = await handle.result();
    expect(result).toBe('turn-5');
  }

  return performance.now() - start;
}

describe('Track 3 speculation benchmark', () => {
  it('Track 3 speculation benchmark: ≥30% latency reduction with zero incorrect results', async () => {
    const engine = runtimeWorkflowEngine(new Engine());

    const mockToolTurn = activity({
      name: 'mock-tool-turn',
      execute: async (turn: unknown) => {
        const typedTurn = turn as number;
        await Bun.sleep(TOOL_LATENCY_MS);
        return `turn-${typedTurn}`;
      },
      verify: async () => {
        await Bun.sleep(TOOL_LATENCY_MS);
        return true;
      },
    });

    registerOnRuntimeEngine(
      engine,
      workflow({ name: 'sequential-agent-like-workflow' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        const context = ctx;

        let lastResult = '';
        for (let turn = 1; turn <= TURN_COUNT; turn++) {
          lastResult = yield* context.run(mockToolTurn, turn);
        }

        return lastResult;
      }),
    );

    registerOnRuntimeEngine(
      engine,
      workflow({ name: 'speculative-agent-like-workflow' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        const context = ctx;

        return yield* context.speculate(async function* (branch) {
          let lastResult = '';
          for (let turn = 1; turn <= TURN_COUNT; turn++) {
            lastResult = yield* branch.run(mockToolTurn, turn);
          }

          return lastResult;
        });
      }),
    );

    for (let index = 0; index < 5; index++) {
      const sequentialWarmup = await engine.start('sequential-agent-like-workflow', null, {
        id: `warm-seq-${index}`,
      });
      await sequentialWarmup.result();

      const speculativeWarmup = await engine.start('speculative-agent-like-workflow', null, {
        id: `warm-spec-${index}`,
      });
      await speculativeWarmup.result();
    }

    const sequentialElapsed = await measureWorkflowDuration(
      engine,
      'sequential-agent-like-workflow',
      RUNS,
    );
    const speculativeElapsed = await measureWorkflowDuration(
      engine,
      'speculative-agent-like-workflow',
      RUNS,
    );

    const reduction = (sequentialElapsed - speculativeElapsed) / sequentialElapsed;

    console.log(
      [
        `\n  Track 3 speculation benchmark:`,
        `    Tool latency:    ${TOOL_LATENCY_MS}ms`,
        `    Runs:            ${RUNS}`,
        `    Sequential:      ${sequentialElapsed.toFixed(1)}ms`,
        `    Speculative:     ${speculativeElapsed.toFixed(1)}ms`,
        `    Reduction:       ${(reduction * 100).toFixed(1)}%`,
        `    Target:          ${(TARGET_REDUCTION * 100).toFixed(0)}%\n`,
      ].join('\n'),
    );

    expect(reduction).toBeGreaterThanOrEqual(TARGET_REDUCTION);

    engine[Symbol.dispose]();
  }, 30_000);
});
