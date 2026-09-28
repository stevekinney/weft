/**
 * Process lifecycle and observation primitives for the `weft conformance`
 * command's checks (`conformance.ts`). Every wait here is barrier-based —
 * polled against an observed condition (registry state, a ledger record, a
 * worker's own reported heartbeat/idle status), never a fixed sleep standing
 * in for "probably done by now" — so a check fails only when the condition
 * it names genuinely never becomes true within `timeoutMs`, not when a slow
 * machine merely takes longer than some guessed margin.
 *
 * @module cli/conformance-harness
 */

import {
  decode,
  isRemoteTaskTerminalCancelled,
  isRemoteTaskTerminalResolved,
  MemoryStorage,
  REMOTE_WORKER_PROTOCOL_VERSION,
  taskLedgerKey,
  type WeftServer,
} from '../index.ts';

export const CONFORMANCE_QUEUE = 'conformance';
export const CONFORMANCE_ACTIVITIES = [
  'conformance.echo',
  'conformance.sleep',
  'conformance.cancel',
] as const;
export const CONFORMANCE_HEARTBEAT_INTERVAL_MS = 25;

export type RunningWorker = {
  process: ReturnType<typeof Bun.spawn>;
};

export async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(25);
  }

  const message = `Timed out after ${timeoutMs}ms waiting for ${label}`;
  throw lastError instanceof Error
    ? new Error(`${message}: ${lastError.message}`)
    : new Error(message);
}

export function startWorker(command: string[], server: WeftServer): RunningWorker {
  const environment = {
    ...Bun.env,
    WEFT_WORKER_URL: `${server.url.replace('http://', 'ws://')}/v1/tasks/${CONFORMANCE_QUEUE}/stream`,
    WEFT_WORKER_QUEUE: CONFORMANCE_QUEUE,
    WEFT_WORKER_ACTIVITIES: CONFORMANCE_ACTIVITIES.join(','),
    WEFT_WORKER_PROTOCOL_VERSION: String(REMOTE_WORKER_PROTOCOL_VERSION),
    WEFT_CONFORMANCE_HEARTBEAT_INTERVAL_MS: String(CONFORMANCE_HEARTBEAT_INTERVAL_MS),
  };

  return {
    process: Bun.spawn(command, {
      env: environment,
      stdout: 'ignore',
      stderr: 'ignore',
    }),
  };
}

export async function stopWorker(worker: RunningWorker | undefined): Promise<void> {
  if (worker === undefined) return;
  if (worker.process.exitCode !== null) return;

  worker.process.kill('SIGTERM');
  try {
    await Promise.race([worker.process.exited, Bun.sleep(1_000)]);
  } catch {
    // Ignore shutdown races; the fallback kill below handles a still-running child.
  }
  if (worker.process.exitCode === null) {
    worker.process.kill('SIGKILL');
    await worker.process.exited.catch(() => undefined);
  }
}

export async function waitForRegisteredWorker(
  server: WeftServer,
  timeoutMs: number,
): Promise<string> {
  await waitForCondition(() => server.registry.getAll().length > 0, timeoutMs, 'worker register');
  const worker = server.registry.getAll()[0];
  if (worker === undefined) {
    throw new Error('worker registry was empty after registration wait');
  }
  return worker.id;
}

export async function waitForReplacementWorker(
  server: WeftServer,
  originalWorkerId: string,
  timeoutMs: number,
): Promise<string> {
  let replacementWorkerId: string | undefined;
  await waitForCondition(
    () => {
      replacementWorkerId = server.registry
        .getAll()
        .find((registeredWorker) => registeredWorker.id !== originalWorkerId)?.id;
      return replacementWorkerId !== undefined;
    },
    timeoutMs,
    'replacement worker register',
  );
  if (replacementWorkerId === undefined) {
    throw new Error('replacement worker registry was empty after registration wait');
  }
  return replacementWorkerId;
}

export async function waitForWorkerHeartbeat(
  server: WeftServer,
  workerId: string,
  timeoutMs: number,
): Promise<void> {
  const disconnectedMessage = `Worker ${workerId} disconnected before heartbeat was observed`;
  const heartbeatBefore = server.registry.getWorker(workerId)?.lastHeartbeat;
  if (heartbeatBefore === undefined) {
    throw new Error(disconnectedMessage);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const worker = server.registry.getWorker(workerId);
    if (worker === undefined) {
      throw new Error(disconnectedMessage);
    }
    if (worker.lastHeartbeat > heartbeatBefore) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for worker ${workerId} heartbeat`);
}

export async function waitForWorkerIdle(
  server: WeftServer,
  workerId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const worker = server.registry.getWorker(workerId);
    if (worker === undefined) {
      throw new Error(`Worker ${workerId} disconnected while waiting to become idle`);
    }
    if (worker.inFlight === 0) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for worker ${workerId} to become idle`);
}

/**
 * Read the resolved status of a task through the durable remote task ledger
 * (WFT-22) — the sole writer of task state; `op:resolved:` no longer exists.
 * Only a `resolved`-disposition terminal record carries a `status`; a
 * cancelled or retry-exhausted disposition returns `undefined` since neither
 * represents "resolved as completed/failed" the way this harness's checks
 * expect.
 */
export async function readResolvedStatus(
  storage: MemoryStorage,
  operationId: string,
): Promise<'completed' | 'failed' | undefined> {
  const stored = await storage.get(taskLedgerKey(operationId));
  if (stored === null) return undefined;
  const decoded = decode(stored);
  if (!isRemoteTaskTerminalResolved(decoded)) return undefined;
  return decoded.status;
}

export async function waitForResolvedStatus(
  storage: MemoryStorage,
  operationId: string,
  status: 'completed' | 'failed',
  timeoutMs: number,
): Promise<void> {
  await waitForCondition(
    async () => (await readResolvedStatus(storage, operationId)) === status,
    timeoutMs,
    `${operationId} to resolve as ${status}`,
  );
}

/**
 * Whether a task has resolved with the ledger's distinct `cancelled`
 * disposition (COR-230, acceptance criterion 13) — a `RemoteTaskTerminalCancelled`
 * record, not a `resolved`-disposition record with `status: 'failed'`. Before
 * COR-230, a worker's cooperative `taskResult(status: 'cancelled')` was
 * folded into an ordinary failed resolution; this check exists specifically
 * to prove that conflation is gone.
 */
export async function readCancelledDisposition(
  storage: MemoryStorage,
  operationId: string,
): Promise<boolean> {
  const stored = await storage.get(taskLedgerKey(operationId));
  if (stored === null) return false;
  return isRemoteTaskTerminalCancelled(decode(stored));
}

export async function waitForCancelledDisposition(
  storage: MemoryStorage,
  operationId: string,
  timeoutMs: number,
): Promise<void> {
  await waitForCondition(
    () => readCancelledDisposition(storage, operationId),
    timeoutMs,
    `${operationId} to resolve with the cancelled disposition`,
  );
}

/**
 * Read an operation's current attempt number and ledger state together.
 * `attempt` alone is not enough: `requeueExpiredAttempt` bumps it the moment
 * a stale or disconnected attempt is REQUEUED, landing the record back in
 * `queued` — attempt 2, but not yet claimed by, let alone delivered to, any
 * worker. A wait keyed on "attempt > 1" alone can fire during that `queued`
 * window, before the replacement has actually been assigned anything, which
 * is indistinguishable from a genuine reassignment only by checking `state`
 * too: `leased`/`completing`/`cancelling`/`terminal` all mean a worker
 * session actually held (or holds) the attempt; `queued` means nobody does
 * yet. `attempt` is still the right monotonic counter to gate on — see
 * {@link waitForReassignmentPastFirstAttempt}'s doc comment for why
 * `workerSessionId` alone is not — it just needs `state` alongside it to
 * exclude the pending-requeue window.
 */
export async function readCurrentAttemptState(
  storage: MemoryStorage,
  operationId: string,
): Promise<{ attempt: number | undefined; state: string | undefined }> {
  const stored = await storage.get(taskLedgerKey(operationId));
  const empty = { attempt: undefined, state: undefined };
  if (stored === null) return empty;
  const decoded = decode(stored);
  if (decoded === null || typeof decoded !== 'object') return empty;
  const record = decoded as Record<string, unknown>;
  const attempt = record['attempt'];
  const state = record['state'];
  return {
    attempt: typeof attempt === 'number' ? attempt : undefined,
    state: typeof state === 'string' ? state : undefined,
  };
}

/**
 * Wait for an operation to be reassigned — its attempt to advance past 1
 * AND actually be claimed by a worker, not merely `queued` waiting for one
 * (see {@link readCurrentAttemptState}'s doc comment) — or for `workerId`
 * (the replacement the reassignment is expected to land on) to disconnect
 * first, matching a fixture that simulates the replacement vanishing
 * instead of completing a reassigned attempt.
 *
 * `attempt > 1` alone, without the state check, is not merely imprecise but
 * WRONG in the other direction too: `workerSessionId` (an earlier version
 * of this wait's signal) disappears the instant the record goes `terminal`,
 * so a fixture that resolves a reassigned attempt immediately could reach
 * `terminal` between two polls with no `workerSessionId`-bearing state ever
 * observed — a false timeout on a passing worker. That version had to be
 * padded out with "resolved status is not undefined" to compensate, and
 * that padding was itself a hole: a NON-conforming worker that ignores
 * `holdForReassignment` and resolves attempt 1 in place — the exact failure
 * this check exists to catch — also leaves a resolved status behind, so it
 * satisfied the same disjunct and made the check pass with no reassignment
 * ever happening. Gating on `attempt > 1` (which a same-attempt resolution
 * never produces) closes that hole; excluding `queued` closes the
 * pending-requeue hole without reopening it.
 */
export async function waitForReassignmentPastFirstAttempt(
  server: WeftServer,
  storage: MemoryStorage,
  operationId: string,
  workerId: string,
  timeoutMs: number,
): Promise<void> {
  await waitForCondition(
    async () => {
      const { attempt, state } = await readCurrentAttemptState(storage, operationId);
      return (
        ((attempt ?? 0) > 1 && state !== 'queued') ||
        server.registry.getWorker(workerId) === undefined
      );
    },
    timeoutMs,
    `${operationId} to be claimed past attempt 1`,
  );
}
