import type { WorkerRegistry } from '../../worker/registry.ts';
import type { TaskQueue } from '../task-queue.ts';
import type { GetTaskDiagnosticsInput, TaskDiagnosticItem } from './get-task-diagnostics.ts';

export function addCapacityDiagnostics({
  registry,
  taskQueue,
  input,
  queues,
  addItem,
}: {
  registry?: WorkerRegistry | undefined;
  taskQueue?: TaskQueue | undefined;
  input: GetTaskDiagnosticsInput;
  queues: ReadonlySet<string>;
  addItem: (item: TaskDiagnosticItem) => void;
}): void {
  if (registry === undefined || taskQueue === undefined) return;

  const workersByQueue = groupWorkersByQueue(registry);
  const candidateQueues = selectCapacityDiagnosticQueues(input, queues, workersByQueue);

  for (const queue of candidateQueues) {
    const diagnostic = buildCapacityDiagnostic(queue, workersByQueue, taskQueue);
    if (diagnostic === null) continue;
    addItem(diagnostic);
  }
}

function groupWorkersByQueue(
  registry: WorkerRegistry,
): Map<string, ReturnType<WorkerRegistry['getAll']>> {
  const workersByQueue = new Map<string, ReturnType<WorkerRegistry['getAll']>>();
  for (const worker of registry.getAll()) {
    const workers = workersByQueue.get(worker.queue) ?? [];
    workers.push(worker);
    workersByQueue.set(worker.queue, workers);
  }
  return workersByQueue;
}

function selectCapacityDiagnosticQueues(
  input: GetTaskDiagnosticsInput,
  queues: ReadonlySet<string>,
  workersByQueue: ReadonlyMap<string, ReturnType<WorkerRegistry['getAll']>>,
): string[] {
  if (input.queue !== undefined) return [input.queue];
  if (queues.size > 0) return [...queues];
  if (input.operationId !== undefined || input.workflowId !== undefined) return [];
  return [...workersByQueue.keys()];
}

function buildCapacityDiagnostic(
  queue: string,
  workersByQueue: ReadonlyMap<string, ReturnType<WorkerRegistry['getAll']>>,
  taskQueue: TaskQueue,
): TaskDiagnosticItem | null {
  const workers = workersByQueue.get(queue) ?? [];
  const pendingCount = taskQueue.pendingCount(queue);
  if (workers.length === 0 || pendingCount === 0) return null;
  const totalCapacity = workers.reduce((sum, worker) => sum + worker.concurrency, 0);
  const totalInFlight = workers.reduce((sum, worker) => sum + worker.inFlight, 0);
  if (totalCapacity === 0 || totalInFlight < totalCapacity) return null;

  return {
    kind: 'all-workers-at-capacity',
    state: 'capacity',
    queue,
    retryCount: 0,
    requeueCount: 0,
    evidence: [
      `Queue "${queue}" has ${pendingCount} pending tasks and all ${workers.length} workers at capacity`,
    ],
  };
}
