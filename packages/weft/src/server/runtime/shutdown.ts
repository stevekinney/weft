import type { ServerContext } from './context.ts';

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

type WorkerShutdownOptions = {
  timeoutMs?: number | undefined;
  stopWaitingWhenIdle?: boolean | undefined;
};

function workerShutdownFinished(
  context: ServerContext,
  workerId: string,
  options: WorkerShutdownOptions | undefined,
): boolean {
  if (!context.workerSockets.has(workerId)) return true;
  return (
    options?.stopWaitingWhenIdle === true && context.registry.getWorkerTasks(workerId).length === 0
  );
}

/** Send a shutdown message to a specific worker and wait for it to disconnect. */
export async function shutdownWorker(
  context: ServerContext,
  workerId: string,
  shutdownOptions?: WorkerShutdownOptions,
): Promise<boolean> {
  const ws = context.workerSockets.get(workerId);
  if (!ws) return false;

  ws.send(JSON.stringify({ type: 'shutdown' }));

  const timeout = shutdownOptions?.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const deadline = Date.now() + timeout;

  while (!workerShutdownFinished(context, workerId, shutdownOptions)) {
    if (Date.now() >= deadline) {
      return true; // We sent the message, but the worker did not disconnect in time.
    }
    await Bun.sleep(50);
  }

  return true;
}

/** Send a shutdown message to all connected workers and wait for them to disconnect. */
export async function shutdownAllWorkers(
  context: ServerContext,
  shutdownOptions?: WorkerShutdownOptions,
): Promise<void> {
  const workerIds = [...context.workerSockets.keys()];
  await Promise.all(workerIds.map((id) => shutdownWorker(context, id, shutdownOptions)));
}
