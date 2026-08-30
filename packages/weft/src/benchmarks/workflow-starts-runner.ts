import { Engine } from '../core/engine.ts';
import { registerOnRuntimeEngine, runtimeWorkflowEngine } from '../core/runtime-workflow-engine.ts';
import { workflow, type WorkflowContext } from '../core/types.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';

export type WorkflowStartAdmissionMeasurement = {
  batchSize: number;
  warmupStarts: number;
  measuredStarts: number;
  admissionsPerSecond: number;
};

const DEFAULT_WARMUP_STARTS = 50;
const DEFAULT_TOTAL_STARTS = 10_000;
const DEFAULT_BATCH_SIZE = 100;

export function buildWarmupWorkflowArgument(index: number): string {
  return `warmup-${index}`;
}

export function buildMeasuredWorkflowArgument(index: number): string {
  return `measured-${index}`;
}

async function measureWorkflowStartAdmissions(
  totalStarts: number,
  batchSize: number,
  warmupStarts: number,
): Promise<WorkflowStartAdmissionMeasurement> {
  const storage = new BunSQLiteStorage(':memory:');
  const engine = runtimeWorkflowEngine(new Engine({ storage }));

  try {
    // The benchmark needs the minimal immediately-completing workflow shape.
    registerOnRuntimeEngine(
      engine,
      workflow({ name: 'noop' }).execute(
        // eslint-disable-next-line require-yield
        async function* (_ctx: WorkflowContext) {
          return 'done';
        },
      ),
    );

    for (let index = 0; index < warmupStarts; index += 1) {
      const handle = await engine.start('noop', buildWarmupWorkflowArgument(index));
      await handle.result();
    }

    const handles: Array<{ result: () => Promise<unknown> }> = [];
    const start = performance.now();

    for (let index = 0; index < totalStarts; index += batchSize) {
      const starters: Array<Promise<{ result: () => Promise<unknown> }>> = [];

      for (let offset = 0; offset < batchSize && index + offset < totalStarts; offset += 1) {
        starters.push(engine.start('noop', buildMeasuredWorkflowArgument(index + offset)));
      }

      handles.push(...(await Promise.all(starters)));
    }

    const elapsed = performance.now() - start;
    await Promise.all(handles.map((handle) => handle.result()));

    return {
      batchSize,
      warmupStarts,
      measuredStarts: totalStarts,
      admissionsPerSecond: Math.round((totalStarts / elapsed) * 1000),
    };
  } finally {
    engine[Symbol.dispose]();
    storage[Symbol.dispose]();
  }
}

if (import.meta.main) {
  const totalStarts = Number(Bun.argv[2] ?? String(DEFAULT_TOTAL_STARTS));
  const batchSize = Number(Bun.argv[3] ?? String(DEFAULT_BATCH_SIZE));
  const warmupStarts = Number(Bun.argv[4] ?? String(DEFAULT_WARMUP_STARTS));

  if (
    !Number.isInteger(totalStarts) ||
    totalStarts <= 0 ||
    !Number.isInteger(batchSize) ||
    batchSize <= 0 ||
    !Number.isInteger(warmupStarts) ||
    warmupStarts < 0
  ) {
    console.error('Expected positive integer values for total starts and batch size.');
    process.exit(1);
  }

  const measurement = await measureWorkflowStartAdmissions(totalStarts, batchSize, warmupStarts);
  console.log(JSON.stringify(measurement));
}
