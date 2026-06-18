/**
 * Workflow-level execution timeouts with durable deadline storage.
 *
 * Deadlines are stored as lexicographically sortable keys so that
 * a single prefix scan can discover all expired workflows.
 *
 * @module timeouts
 */

import type { BatchOperation, Storage } from '../storage/interface';
import { KEYS, resolvePrefixRangeEnd } from '../storage/interface';
import { decode, encode } from './codec';
import { normalizeStorageTimestamp, parseDuration } from './scheduler';
import type { Duration, WorkflowId } from './types';
import type { TerminationReason } from './types/history-policy';
import { WeftError } from './weft-error';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExpiredDeadline {
  workflowId: string;
  deadline: number;
}

// ---------------------------------------------------------------------------
// Deadline batch operations
// ---------------------------------------------------------------------------

/**
 * Create batch operations for storing an execution deadline.
 *
 * @example
 * ```ts
 * import { createDeadlineOperations } from '@lostgradient/weft';
 *
 * const ops = createDeadlineOperations('wf-123', Date.now(), '30m');
 * // Returns a BatchOperation array to put the deadline key in storage.
 * console.log(ops.length);      // 1
 * console.log(ops[0]?.type);    // 'put'
 * ```
 */
export function createDeadlineOperations(
  workflowId: WorkflowId,
  startedAt: number,
  executionTimeout: Duration,
): BatchOperation[] {
  const timeoutMilliseconds = parseDuration(executionTimeout);
  const deadline = normalizeStorageTimestamp(
    startedAt + timeoutMilliseconds,
    'Workflow execution deadline',
  );
  const key = KEYS.deadline(deadline, workflowId);

  return [{ type: 'put', key, value: encode({ workflowId, deadline }) }];
}

/** Create batch operations to clean up deadline entries for a workflow. */
export function cleanupDeadlineOperations(
  workflowId: WorkflowId,
  deadline: number,
): BatchOperation[] {
  const key = KEYS.deadline(deadline, workflowId);
  return [{ type: 'delete', key }];
}

// ---------------------------------------------------------------------------
// Deadline scanning
// ---------------------------------------------------------------------------

/**
 * Scan storage for expired deadlines. Returns workflow IDs that have timed out.
 *
 * @example
 * ```ts
 * import { checkExpiredDeadlines, createDeadlineOperations } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/weft/storage/memory';
 *
 * const storage = new MemoryStorage();
 * const ops = createDeadlineOperations('wf-abc', Date.now() - 60_000, '30s');
 * await storage.batch(ops);
 *
 * const expired = await checkExpiredDeadlines(storage, Date.now());
 * console.log(expired[0]?.workflowId); // 'wf-abc'
 * ```
 */
export async function checkExpiredDeadlines(
  storage: Storage,
  now: number,
): Promise<ExpiredDeadline[]> {
  const expired: ExpiredDeadline[] = [];

  for await (const [, value] of storage.scan('wf-deadline:', {
    lt: resolvePrefixRangeEnd(KEYS.deadline(now, '')),
  })) {
    const entry = decode(value) as { workflowId: string; deadline: number };
    expired.push({ workflowId: entry.workflowId, deadline: entry.deadline });
  }

  return expired;
}

// ---------------------------------------------------------------------------
// Time remaining
// ---------------------------------------------------------------------------

/**
 * Calculate remaining time before deadline. Returns Infinity if no deadline.
 *
 * @example
 * ```ts
 * import { timeRemaining } from '@lostgradient/weft';
 *
 * const now = Date.now();
 * const deadline = now + 5000;
 *
 * console.log(timeRemaining(deadline, now));       // ~5000
 * console.log(timeRemaining(undefined, now));      // Infinity
 * console.log(timeRemaining(now - 1000, now) < 0); // true (expired)
 * ```
 */
export function timeRemaining(deadline: number | undefined, now: number): number {
  if (deadline === undefined) return Infinity;
  return deadline - now;
}

// ---------------------------------------------------------------------------
// Timeout error
// ---------------------------------------------------------------------------

/**
 * Thrown inside a workflow generator when it exceeds its configured execution
 * or run timeout. Also available as an event via {@link WorkflowTimedOutEvent}.
 * The `timeoutType` distinguishes `'execution'` (wall-clock cap set via
 * {@link StartOptions.executionTimeout}) from `'run'` (per-step run timeout).
 *
 * When the run was force-terminated by the history circuit breaker
 * (`history.maxEvents`) rather than a genuine deadline, `terminationReason` is
 * set to {@link HISTORY_CIRCUIT_BREAKER_REASON}; for ordinary deadline timeouts
 * it is `undefined`. This mirrors {@link WorkflowTimedOutEvent.reason} so callers
 * can classify the two without a second `engine.get(runId)` read.
 *
 * @example
 * ```ts
 * import { workflow, Engine, WorkflowTimeoutError } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(
 *   workflow({ name: 'slow' }).execute(async function* () {
 *     await new Promise(resolve => setTimeout(resolve, 60_000));
 *     return 'done';
 *   }),
 * );
 *
 * try {
 *   const handle = await engine.start('slow', null, { executionTimeout: '1s' });
 *   await handle.result();
 * } catch (err) {
 *   if (err instanceof WorkflowTimeoutError) {
 *     console.error('timed out after', err.elapsed, 'ms, type:', err.timeoutType);
 *   }
 * }
 * ```
 */
export class WorkflowTimeoutError extends WeftError<'WorkflowTimeoutError'> {
  readonly workflowId: string;
  readonly timeoutType: 'execution' | 'run';
  readonly elapsed: number;
  /**
   * Set to {@link HISTORY_CIRCUIT_BREAKER_REASON} when the run was force-terminated
   * by the history circuit breaker; `undefined` for an ordinary deadline timeout.
   */
  readonly terminationReason?: TerminationReason;

  constructor(
    workflowId: string,
    timeoutType: 'execution' | 'run',
    elapsed: number,
    terminationReason?: TerminationReason,
  ) {
    super(
      'WorkflowTimeoutError',
      `Workflow "${workflowId}" exceeded ${timeoutType} timeout after ${elapsed}ms`,
    );
    this.workflowId = workflowId;
    this.timeoutType = timeoutType;
    this.elapsed = elapsed;
    // `exactOptionalPropertyTypes` forbids assigning `undefined` to an optional
    // field whose type omits it; mirror WorkflowTimedOutEvent's guarded set.
    if (terminationReason !== undefined) {
      this.terminationReason = terminationReason;
    }
  }
}
