/**
 * Diagnostic data collection for `weft doctor`.
 *
 * Inspects storage to gather database health, workflow statistics,
 * and queue statistics, then generates actionable recommendations.
 *
 * @module diagnostics/doctor
 */

import { decode } from '../core/codec.ts';
import type { Checkpoint, WorkflowState } from '../core/types.ts';
import type { Storage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { generateRecommendations } from './recommendations.ts';
import type {
  DatabaseHealth,
  DiagnosticReport,
  LargestCheckpoint,
  LongestRunningWorkflow,
  QueueStatistics,
  WorkflowStatistics,
  WorkflowStatusCounts,
} from './types.ts';
import { THRESHOLDS } from './types.ts';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collect diagnostics from a Weft storage instance.
 *
 * Gathers database health, workflow statistics, and queue statistics,
 * then generates recommendations based on configurable thresholds.
 */
export async function collectDiagnostics(
  storage: Storage,
  databasePath: string,
  options?: { now?: number; sizeLimitBytes?: number },
): Promise<DiagnosticReport> {
  const now = options?.now ?? Date.now();
  const sizeLimitBytes = options?.sizeLimitBytes ?? THRESHOLDS.defaultDatabaseSizeLimitBytes;

  const [database, workflows, queues] = await Promise.all([
    collectDatabaseHealth(storage, databasePath, sizeLimitBytes),
    collectWorkflowStatistics(storage, now),
    collectQueueStatistics(storage),
  ]);

  const recommendations = generateRecommendations({ database, workflows, queues });

  return {
    timestamp: now,
    databasePath,
    database,
    workflows,
    queues,
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// Database health
// ---------------------------------------------------------------------------

async function collectDatabaseHealth(
  storage: Storage,
  databasePath: string,
  sizeLimitBytes: number,
): Promise<DatabaseHealth> {
  if (typeof storage.query !== 'function') {
    return {
      sizeBytes: 0,
      sizeLimitBytes,
      walSizeBytes: null,
      integrityOk: true,
      integrityError: null,
      fragmentationPercent: 0,
      journalMode: 'unknown',
      pageCount: 0,
      pageSize: 0,
      freelistCount: 0,
    };
  }

  const query = storage.query.bind(storage);

  const [pageCountRows, pageSizeRows, freelistRows, integrityRows, journalRows] = await Promise.all(
    [
      query<{ page_count: number }>('PRAGMA page_count'),
      query<{ page_size: number }>('PRAGMA page_size'),
      query<{ freelist_count: number }>('PRAGMA freelist_count'),
      query<{ integrity_check: string }>('PRAGMA integrity_check'),
      query<{ journal_mode: string }>('PRAGMA journal_mode'),
    ],
  );

  const pageCount = pageCountRows[0]?.page_count ?? 0;
  const pageSize = pageSizeRows[0]?.page_size ?? 0;
  const freelistCount = freelistRows[0]?.freelist_count ?? 0;
  const integrityResult = integrityRows[0]?.integrity_check ?? 'ok';
  const journalMode = journalRows[0]?.journal_mode ?? 'unknown';

  const integrityOk = integrityResult === 'ok';
  const integrityError = integrityOk ? null : integrityResult;

  const fragmentationPercent = pageCount > 0 ? (freelistCount / pageCount) * 100 : 0;

  const sizeBytes = databasePath === ':memory:' ? 0 : Bun.file(databasePath).size;

  let walSizeBytes: number | null = null;
  if (databasePath !== ':memory:') {
    const walSize = Bun.file(databasePath + '-wal').size;
    walSizeBytes = walSize > 0 ? walSize : null;
  }

  return {
    sizeBytes,
    sizeLimitBytes,
    walSizeBytes,
    integrityOk,
    integrityError,
    fragmentationPercent,
    journalMode,
    pageCount,
    pageSize,
    freelistCount,
  };
}

// ---------------------------------------------------------------------------
// Workflow statistics
// ---------------------------------------------------------------------------

async function collectWorkflowStatistics(
  storage: Storage,
  now: number,
): Promise<WorkflowStatistics> {
  const statusCounts: WorkflowStatusCounts = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    timedOut: 0,
  };

  let total = 0;
  let longestRunning: LongestRunningWorkflow | null = null;
  let earliestCreatedAt = Infinity;

  // Collect all workflow states and track the longest running
  for await (const [key, value] of storage.scan('wf:')) {
    // Skip checkpoint keys: wf:{id}:ckpt and wf:{id}:ckpt:{step}
    if (key.includes(':ckpt')) continue;

    const state = decode(value) as WorkflowState;
    total++;

    // Map status to counts
    const statusKey = state.status === 'timed-out' ? 'timedOut' : state.status;
    statusCounts[statusKey]++;

    // Track longest running
    if (state.status === 'running' && state.createdAt < earliestCreatedAt) {
      earliestCreatedAt = state.createdAt;
      longestRunning = {
        id: state.id,
        type: state.type,
        startedAt: state.createdAt,
        elapsedMilliseconds: now - state.createdAt,
        currentStep: 0,
      };
    }
  }

  // Load checkpoint for longest running workflow to get the current step
  if (longestRunning) {
    const checkpointValue = await storage.get(KEYS.checkpoint(longestRunning.id));
    if (checkpointValue) {
      const checkpoint = decode(checkpointValue) as Checkpoint;
      longestRunning.currentStep = checkpoint.step;
    }
  }

  // Track largest checkpoint
  let largestCheckpoint: LargestCheckpoint | null = null;
  let largestSize = 0;

  for await (const [key, value] of storage.scan('wf:')) {
    // Match exactly wf:{id}:ckpt — not wf:{id}:ckpt:{step}
    // The key must contain :ckpt and the part after the last :ckpt must be empty
    if (!key.includes(':ckpt')) continue;

    // Split to verify this is wf:{id}:ckpt and not wf:{id}:ckpt:{step}
    const checkpointIndex = key.indexOf(':ckpt');
    const afterCheckpoint = key.slice(checkpointIndex + ':ckpt'.length);
    if (afterCheckpoint.length > 0) continue;

    const workflowId = key.slice('wf:'.length, checkpointIndex);

    if (value.byteLength > largestSize) {
      largestSize = value.byteLength;
      largestCheckpoint = {
        workflowId,
        sizeBytes: value.byteLength,
      };
    }
  }

  return {
    total,
    statusCounts,
    longestRunning,
    largestCheckpoint,
  };
}

// ---------------------------------------------------------------------------
// Queue statistics
// ---------------------------------------------------------------------------

async function collectQueueStatistics(storage: Storage): Promise<QueueStatistics[]> {
  const queueMap = new Map<string, { pending: number; inflight: number }>();

  // Count pending operations: op:{queue}:{timestamp}:{id}
  // Skip state-tracking keys (inflight, queued, resolved)
  for await (const [key] of storage.scan('op:')) {
    if (key.startsWith('op:inflight:')) continue;
    if (key.startsWith('op:queued:')) continue;
    if (key.startsWith('op:resolved:')) continue;

    const parts = key.split(':');
    const queueName = parts[1] ?? '';

    if (!queueMap.has(queueName)) {
      queueMap.set(queueName, { pending: 0, inflight: 0 });
    }
    queueMap.get(queueName)!.pending++;
  }

  // Count in-flight operations: op:inflight:{id}
  for await (const [, value] of storage.scan('op:inflight:')) {
    const operation = decode(value) as { queue: string };
    const queueName = operation.queue;

    if (!queueMap.has(queueName)) {
      queueMap.set(queueName, { pending: 0, inflight: 0 });
    }
    queueMap.get(queueName)!.inflight++;
  }

  return [...queueMap.entries()].map(([name, counts]) => ({
    name,
    pendingCount: counts.pending,
    inflightCount: counts.inflight,
  }));
}
