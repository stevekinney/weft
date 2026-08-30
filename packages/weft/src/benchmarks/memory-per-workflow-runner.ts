import { Engine, ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING } from '../core/engine.ts';
import {
  registerOnRuntimeEngine,
  runtimeWorkflowEngine,
  type RuntimeWorkflowEngine,
} from '../core/runtime-workflow-engine.ts';
import { workflow, type WorkflowContext } from '../core/types.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';
import { isConstrainedCodexRunner } from './benchmark-environment.ts';

const WORKFLOW_ID_PREFIX = 'memory-benchmark-';
const WORKFLOW_ID_PATTERN = /memory-benchmark-\d+/;

type WorkflowFootprint = {
  checkpointBytes: number;
  durableBytes: number;
};

export type MemoryPerWorkflowMeasurement = {
  totalWorkflows: number;
  countedWorkflows: number;
  checkpointBytesTotal: number;
  averageCheckpointBytesPerWorkflow: number;
  maxCheckpointBytesPerWorkflow: number;
  durableBytesTotal: number;
  averageDurableBytesPerWorkflow: number;
  maxDurableBytesPerWorkflow: number;
  workflowStateBytesTotal: number;
  checkpointHistoryBytesTotal: number;
  timelineBytesTotal: number;
  eventBytesTotal: number;
  otherBytesTotal: number;
};

function roundBytesPerWorkflow(totalBytes: number, workflowCount: number): number {
  if (workflowCount === 0) {
    return 0;
  }

  return Math.round(totalBytes / workflowCount);
}

function extractBenchmarkWorkflowId(storageKey: string): string | null {
  return storageKey.match(WORKFLOW_ID_PATTERN)?.[0] ?? null;
}

function classifyStorageKey(
  storageKey: string,
): keyof Pick<
  MemoryPerWorkflowMeasurement,
  | 'workflowStateBytesTotal'
  | 'checkpointHistoryBytesTotal'
  | 'timelineBytesTotal'
  | 'eventBytesTotal'
  | 'otherBytesTotal'
> {
  if (storageKey.startsWith('ev:')) {
    return 'eventBytesTotal';
  }

  if (!storageKey.startsWith('wf:')) {
    return 'otherBytesTotal';
  }

  if (storageKey.includes(':timeline:')) {
    return 'timelineBytesTotal';
  }

  if (storageKey.includes(':ckpt:')) {
    return 'checkpointHistoryBytesTotal';
  }

  return 'workflowStateBytesTotal';
}

type StorageScanTotals = {
  footprints: Map<string, WorkflowFootprint>;
  checkpointBytesTotal: number;
  durableBytesTotal: number;
  workflowStateBytesTotal: number;
  checkpointHistoryBytesTotal: number;
  timelineBytesTotal: number;
  eventBytesTotal: number;
  otherBytesTotal: number;
};

/**
 * Warmup phase: start `totalWorkflows` idle workflows and wait until every one
 * is parked on the wake signal. Returns once the workflow population is stable.
 */
async function warmupParkedWorkflows(
  engine: RuntimeWorkflowEngine,
  totalWorkflows: number,
): Promise<void> {
  registerOnRuntimeEngine(
    engine,
    workflow({ name: 'idle' }).execute(async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('wake');
      return 'done';
    }),
  );

  for (let index = 0; index < totalWorkflows; index += 1) {
    await engine.start('idle', null, { id: `${WORKFLOW_ID_PREFIX}${index}` });
  }

  await waitForParkedWorkflows(engine, totalWorkflows);
}

/**
 * Sample phase: scan storage entries belonging to benchmark workflows and
 * accumulate per-category byte totals plus per-workflow footprints.
 */
async function sampleStorageTotals(storage: BunSQLiteStorage): Promise<StorageScanTotals> {
  const totals: StorageScanTotals = {
    footprints: new Map<string, WorkflowFootprint>(),
    checkpointBytesTotal: 0,
    durableBytesTotal: 0,
    workflowStateBytesTotal: 0,
    checkpointHistoryBytesTotal: 0,
    timelineBytesTotal: 0,
    eventBytesTotal: 0,
    otherBytesTotal: 0,
  };

  for await (const [storageKey, value] of storage.scan('')) {
    const workflowId = extractBenchmarkWorkflowId(storageKey);
    if (workflowId === null) {
      continue;
    }
    accumulateStorageEntry(totals, storageKey, workflowId, value.byteLength);
  }

  return totals;
}

function accumulateStorageEntry(
  totals: StorageScanTotals,
  storageKey: string,
  workflowId: string,
  bytes: number,
): void {
  totals.durableBytesTotal += bytes;

  const footprint = totals.footprints.get(workflowId) ?? {
    checkpointBytes: 0,
    durableBytes: 0,
  };
  footprint.durableBytes += bytes;
  totals.footprints.set(workflowId, footprint);

  const isLatestCheckpoint =
    storageKey.startsWith(`wf:${workflowId}:ckpt`) && !storageKey.includes(':ckpt:');
  if (isLatestCheckpoint) {
    totals.checkpointBytesTotal += bytes;
    footprint.checkpointBytes += bytes;
  }

  const category = classifyStorageKey(storageKey);
  if (category === 'workflowStateBytesTotal') {
    if (!isLatestCheckpoint) {
      totals.workflowStateBytesTotal += bytes;
    }
    return;
  }
  if (category === 'checkpointHistoryBytesTotal') {
    totals.checkpointHistoryBytesTotal += bytes;
    return;
  }
  if (category === 'timelineBytesTotal') {
    totals.timelineBytesTotal += bytes;
    return;
  }
  if (category === 'eventBytesTotal') {
    totals.eventBytesTotal += bytes;
    return;
  }
  totals.otherBytesTotal += bytes;
}

/**
 * Summarize phase: derive per-workflow maxima and average byte counts from the
 * sampled totals and assemble the final measurement record.
 */
function summarizeTotals(
  totals: StorageScanTotals,
  totalWorkflows: number,
): MemoryPerWorkflowMeasurement {
  let maxCheckpointBytesPerWorkflow = 0;
  let maxDurableBytesPerWorkflow = 0;
  for (const footprint of totals.footprints.values()) {
    maxCheckpointBytesPerWorkflow = Math.max(
      maxCheckpointBytesPerWorkflow,
      footprint.checkpointBytes,
    );
    maxDurableBytesPerWorkflow = Math.max(maxDurableBytesPerWorkflow, footprint.durableBytes);
  }

  const countedWorkflows = totals.footprints.size;

  return {
    totalWorkflows,
    countedWorkflows,
    checkpointBytesTotal: totals.checkpointBytesTotal,
    averageCheckpointBytesPerWorkflow: roundBytesPerWorkflow(
      totals.checkpointBytesTotal,
      countedWorkflows,
    ),
    maxCheckpointBytesPerWorkflow,
    durableBytesTotal: totals.durableBytesTotal,
    averageDurableBytesPerWorkflow: roundBytesPerWorkflow(
      totals.durableBytesTotal,
      countedWorkflows,
    ),
    maxDurableBytesPerWorkflow,
    workflowStateBytesTotal: totals.workflowStateBytesTotal,
    checkpointHistoryBytesTotal: totals.checkpointHistoryBytesTotal,
    timelineBytesTotal: totals.timelineBytesTotal,
    eventBytesTotal: totals.eventBytesTotal,
    otherBytesTotal: totals.otherBytesTotal,
  };
}

/**
 * Measure the durable storage footprint of `totalWorkflows` idle workflows.
 *
 * Runs three phases: warm up by starting and parking the workflow population,
 * sample by scanning durable storage, and summarize by computing maxima and
 * averages from the sampled totals.
 */
export async function measureMemoryPerWorkflow(
  totalWorkflows: number,
): Promise<MemoryPerWorkflowMeasurement> {
  const storage = new BunSQLiteStorage(':memory:');
  const engine = runtimeWorkflowEngine(new Engine({ storage }));

  try {
    await warmupParkedWorkflows(engine, totalWorkflows);
    const totals = await sampleStorageTotals(storage);
    return summarizeTotals(totals, totalWorkflows);
  } finally {
    engine[Symbol.dispose]();
    storage[Symbol.dispose]();
  }
}

if (import.meta.main) {
  const totalWorkflowsArgument = Bun.argv[2];
  const totalWorkflows =
    totalWorkflowsArgument !== undefined ? Number(totalWorkflowsArgument) : 100_000;

  if (!Number.isInteger(totalWorkflows) || totalWorkflows <= 0) {
    console.error('Expected a positive integer total workflow count.');
    process.exit(1);
  }

  const measurement = await measureMemoryPerWorkflow(totalWorkflows);
  console.log(JSON.stringify(measurement));
}

async function waitForParkedWorkflows(
  engine: RuntimeWorkflowEngine,
  expectedCount: number,
): Promise<void> {
  const timeoutMilliseconds = isConstrainedCodexRunner() ? 180_000 : 60_000;
  const deadline = Date.now() + timeoutMilliseconds;

  while (Date.now() < deadline) {
    if (engine[ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING]() === expectedCount) {
      return;
    }

    await Bun.sleep(5);
  }

  throw new Error(
    `Timed out waiting for ${expectedCount.toLocaleString()} parked workflows in the memory benchmark runner.`,
  );
}
