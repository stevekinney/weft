import { Engine } from '../core/engine.ts';
import { activity, type WorkflowContext } from '../core/types.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';

export type ActivityCompletionMeasurement = {
  completionsPerSecond: number;
};

const WARMUP_WORKFLOWS = 100;

function echo(value: unknown): unknown {
  return value;
}

const echoActivity = activity({ name: 'echo', execute: echo });

async function measureActivityCompletionRound(
  totalWorkflows: number,
  activitiesPerWorkflow: number,
  startBatchSize: number,
): Promise<number> {
  const storage = new BunSQLiteStorage(':memory:');
  const engine = new Engine({ storage });

  try {
    engine.register(echoActivity);

    engine.register('with-activity', async function* (ctx: WorkflowContext) {
      let result: unknown = 0;
      for (let index = 0; index < activitiesPerWorkflow; index += 1) {
        result = yield* ctx.run(echo, index);
      }
      return result;
    });

    for (let index = 0; index < WARMUP_WORKFLOWS; index += 1) {
      const handle = await engine.start('with-activity', index);
      await handle.result();
    }

    const handles: Array<{ result: () => Promise<unknown> }> = [];
    const start = performance.now();

    for (let index = 0; index < totalWorkflows; index += startBatchSize) {
      const starters: Promise<{ result: () => Promise<unknown> }>[] = [];
      for (
        let offset = 0;
        offset < startBatchSize && index + offset < totalWorkflows;
        offset += 1
      ) {
        starters.push(engine.start('with-activity', index + offset));
      }
      handles.push(...(await Promise.all(starters)));
    }

    await Promise.all(handles.map((handle) => handle.result()));

    return performance.now() - start;
  } finally {
    engine[Symbol.dispose]();
    storage[Symbol.dispose]();
  }
}

export async function measureActivityCompletions(
  totalWorkflows: number,
  activitiesPerWorkflow: number,
  startBatchSize: number,
  measurementRounds = 1,
): Promise<ActivityCompletionMeasurement> {
  let totalElapsed = 0;

  for (let round = 0; round < measurementRounds; round += 1) {
    totalElapsed += await measureActivityCompletionRound(
      totalWorkflows,
      activitiesPerWorkflow,
      startBatchSize,
    );
  }

  return {
    completionsPerSecond: Math.round(
      ((totalWorkflows * activitiesPerWorkflow * measurementRounds) / totalElapsed) * 1000,
    ),
  };
}

if (import.meta.main) {
  const totalWorkflows = Number(Bun.argv[2] ?? '250');
  const activitiesPerWorkflow = Number(Bun.argv[3] ?? '30');
  const startBatchSize = Number(Bun.argv[4] ?? '250');
  const measurementRounds = Number(Bun.argv[5] ?? '1');

  if (
    !Number.isInteger(totalWorkflows) ||
    totalWorkflows <= 0 ||
    !Number.isInteger(activitiesPerWorkflow) ||
    activitiesPerWorkflow <= 0 ||
    !Number.isInteger(startBatchSize) ||
    startBatchSize <= 0 ||
    !Number.isInteger(measurementRounds) ||
    measurementRounds <= 0
  ) {
    console.error(
      'Expected positive integer values for workflows, activities, batch size, and rounds.',
    );
    process.exit(1);
  }

  const measurement = await measureActivityCompletions(
    totalWorkflows,
    activitiesPerWorkflow,
    startBatchSize,
    measurementRounds,
  );
  console.log(JSON.stringify(measurement));
}
