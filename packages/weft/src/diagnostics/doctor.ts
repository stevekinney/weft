/**
 * Diagnostic data collection for `weft doctor`.
 *
 * Inspects storage to gather database health, workflow statistics,
 * and queue statistics, then generates actionable recommendations.
 *
 * @module diagnostics/doctor
 */

import { decode } from '../core/codec.ts';
import { decodeWorkflowState } from '../core/engine/validation.ts';
import { isTopLevelWorkflowStateKey } from '../core/engine/workflow-state-stream.ts';
import type { Checkpoint, WorkflowState } from '../core/types.ts';
import { fileSize } from '../runtime/portable.ts';
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
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage, collectDiagnostics } from '@lostgradient/weft';
 *
 * await using storage = new MemoryStorage();
 * const report = await collectDiagnostics(storage, ':memory:');
 * console.log(report.workflows.total);
 * console.log(report.recommendations.length);
 * ```
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

type DatabasePragmas = {
  pageCount: number;
  pageSize: number;
  freelistCount: number;
  integrityResult: string;
  journalMode: string;
};

function firstNumber(rows: ReadonlyArray<Record<string, unknown>>, column: string): number {
  const value = rows[0]?.[column];
  return typeof value === 'number' ? value : 0;
}

function firstString(
  rows: ReadonlyArray<Record<string, unknown>>,
  column: string,
  fallback: string,
): string {
  const value = rows[0]?.[column];
  return typeof value === 'string' ? value : fallback;
}

async function readDatabasePragmas(query: NonNullable<Storage['query']>): Promise<DatabasePragmas> {
  const [pageCountRows, pageSizeRows, freelistRows, integrityRows, journalRows] = await Promise.all(
    [
      query<Record<string, unknown>>('PRAGMA page_count'),
      query<Record<string, unknown>>('PRAGMA page_size'),
      query<Record<string, unknown>>('PRAGMA freelist_count'),
      query<Record<string, unknown>>('PRAGMA integrity_check'),
      query<Record<string, unknown>>('PRAGMA journal_mode'),
    ],
  );
  return {
    pageCount: firstNumber(pageCountRows, 'page_count'),
    pageSize: firstNumber(pageSizeRows, 'page_size'),
    freelistCount: firstNumber(freelistRows, 'freelist_count'),
    integrityResult: firstString(integrityRows, 'integrity_check', 'ok'),
    journalMode: firstString(journalRows, 'journal_mode', 'unknown'),
  };
}

function measureDatabaseFiles(databasePath: string): {
  sizeBytes: number;
  walSizeBytes: number | null;
} {
  if (databasePath === ':memory:') {
    return { sizeBytes: 0, walSizeBytes: null };
  }
  const walSize = fileSize(databasePath + '-wal');
  return {
    sizeBytes: fileSize(databasePath),
    walSizeBytes: walSize > 0 ? walSize : null,
  };
}

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

  const pragmas = await readDatabasePragmas(storage.query.bind(storage));
  const { sizeBytes, walSizeBytes } = measureDatabaseFiles(databasePath);

  const integrityOk = pragmas.integrityResult === 'ok';
  const fragmentationPercent =
    pragmas.pageCount > 0 ? (pragmas.freelistCount / pragmas.pageCount) * 100 : 0;

  return {
    sizeBytes,
    sizeLimitBytes,
    walSizeBytes,
    integrityOk,
    integrityError: integrityOk ? null : pragmas.integrityResult,
    fragmentationPercent,
    journalMode: pragmas.journalMode,
    pageCount: pragmas.pageCount,
    pageSize: pragmas.pageSize,
    freelistCount: pragmas.freelistCount,
  };
}

// ---------------------------------------------------------------------------
// Workflow statistics
// ---------------------------------------------------------------------------

function mapStatusKey(status: WorkflowState['status']): keyof WorkflowStatusCounts {
  return status === 'timed-out' ? 'timedOut' : status;
}

type WorkflowScanResult = {
  total: number;
  statusCounts: WorkflowStatusCounts;
  longestRunning: LongestRunningWorkflow | null;
};

async function aggregateWorkflowScan(storage: Storage, now: number): Promise<WorkflowScanResult> {
  const statusCounts: WorkflowStatusCounts = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    timedOut: 0,
    suspended: 0,
  };
  let total = 0;
  let longestRunning: LongestRunningWorkflow | null = null;
  let earliestCreatedAt = Infinity;

  for await (const [key, value] of storage.scan('wf:')) {
    // `wf:` also matches side-records (`wf:{id}:ckpt`, `:timeline:`, `:offload`,
    // `:archive`, index keys). Only top-level `wf:{id}` state records are workflow
    // states; everything else would decode into a bogus WorkflowState and inflate
    // the counts. Use the same allowlist filter as the engine's own scans.
    if (!isTopLevelWorkflowStateKey(key)) continue;
    // Decode through `decodeWorkflowState` so older flat-shaped persisted records
    // are normalized (e.g. flat version fields lifted into `versionTuple`) before
    // any field is read, matching the version-check diagnostics path.
    const state = decodeWorkflowState(value);
    total++;
    statusCounts[mapStatusKey(state.status)]++;

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
  return { total, statusCounts, longestRunning };
}

async function hydrateLongestRunningStep(
  storage: Storage,
  longestRunning: LongestRunningWorkflow,
): Promise<void> {
  const checkpointValue = await storage.get(KEYS.checkpoint(longestRunning.id));
  if (!checkpointValue) return;
  const checkpoint = decode(checkpointValue) as Checkpoint;
  longestRunning.currentStep = checkpoint.step;
}

async function findLargestCheckpoint(storage: Storage): Promise<LargestCheckpoint | null> {
  let largestCheckpoint: LargestCheckpoint | null = null;
  let largestSize = 0;
  for await (const [key, value] of storage.scan('wf:')) {
    // Match exactly wf:{id}:ckpt — not wf:{id}:ckpt:{step}.
    const checkpointIndex = key.indexOf(':ckpt');
    if (checkpointIndex === -1) continue;
    if (key.length > checkpointIndex + ':ckpt'.length) continue;

    if (value.byteLength > largestSize) {
      largestSize = value.byteLength;
      largestCheckpoint = {
        workflowId: key.slice('wf:'.length, checkpointIndex),
        sizeBytes: value.byteLength,
      };
    }
  }
  return largestCheckpoint;
}

async function collectWorkflowStatistics(
  storage: Storage,
  now: number,
): Promise<WorkflowStatistics> {
  const { total, statusCounts, longestRunning } = await aggregateWorkflowScan(storage, now);
  if (longestRunning) {
    await hydrateLongestRunningStep(storage, longestRunning);
  }
  const largestCheckpoint = await findLargestCheckpoint(storage);
  return { total, statusCounts, longestRunning, largestCheckpoint };
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
    if (key.startsWith(KEYS.operationResolvedByTimePrefix())) continue;

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
