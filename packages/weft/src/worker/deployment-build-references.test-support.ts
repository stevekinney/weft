/**
 * Seeds durable work that is bound to a deployment build, so a test can assert what removal and
 * the reported reference count make of it: run records with a worker binding, and task-ledger
 * entries with an execution requirement. Records are written the way the engine writes them, but
 * directly, so a test does not need a live engine to place work on a build.
 */
import { type Storage } from "../embedded/storage/src/index.ts";
import { encode } from '../core/codec/index.ts';
import { encodeRemoteTaskRecord } from '../core/task-ledger/task-ledger-codec.ts';
import { taskLedgerKey } from '../core/task-ledger/task-ledger-keys.ts';
import type {
  RemoteTaskQueued,
  RemoteTaskTerminalResolved,
  WorkerExecutionRequirementInput,
} from '../core/task-ledger/task-ledger-types.ts';
import { KEYS } from '../storage/keys.ts';

export type SeededRunStatus =
  'pending' | 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled' | 'timed-out';

function binding(workflowId: string, deploymentName: string, buildId: string) {
  return {
    workflowId,
    workflowType: 'checkout',
    deploymentName,
    buildId,
    artifactDigest: `sha256:${buildId}`,
    manifestDigest: `sha256:manifest-${buildId}`,
    routingGeneration: 1,
    workflowRevision: 'revision-a',
    workflowContractHash: 'sha256:workflow',
    activityContracts: {},
    activityName: '*',
    activityContractHash: 'sha256:workflow',
    boundAt: 1,
    checkpointId: workflowId,
  };
}

/** Write a run record whose current worker binding names `deploymentName/buildId`. */
export async function seedBoundRun(
  storage: Storage,
  run: Readonly<{
    workflowId: string;
    deploymentName: string;
    buildId: string;
    status?: SeededRunStatus;
    policy?: 'pinned' | 'auto-upgrade';
  }>,
): Promise<void> {
  const current = binding(run.workflowId, run.deploymentName, run.buildId);
  await storage.put(
    KEYS.workflow(run.workflowId),
    encode({
      id: run.workflowId,
      type: 'checkout',
      status: run.status ?? 'running',
      workerVersioningPolicy:
        run.policy === 'auto-upgrade'
          ? { mode: 'auto-upgrade', compatibility: { ...current, buildId: run.buildId } }
          : { mode: 'pinned' },
      workerBinding: { current, history: [] },
    }),
  );
}

function ledgerBase(operationId: string, executionRequirement: WorkerExecutionRequirementInput) {
  return {
    recordVersion: 1 as const,
    operationId,
    workflowType: 'checkout',
    activityName: 'charge',
    queue: 'default',
    input: {},
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    executionRequirement,
    createdAt: 1,
    generation: 0,
  };
}

/** Write a task-ledger entry, queued or finished, whose requirement is `requirement`. */
export async function seedLedgerEntry(
  storage: Storage,
  entry: Readonly<{
    operationId: string;
    requirement: WorkerExecutionRequirementInput;
    finished?: boolean;
  }>,
): Promise<void> {
  const base = ledgerBase(entry.operationId, entry.requirement);
  const record: RemoteTaskQueued | RemoteTaskTerminalResolved =
    entry.finished === true
      ? {
          ...base,
          state: 'terminal',
          disposition: 'resolved',
          attempt: 1,
          attemptToken: 'attempt-1',
          status: 'completed',
          resultDigest: 'digest-1',
          terminalAt: 2,
          adopted: false,
          retentionGeneration: 0,
        }
      : {
          ...base,
          state: 'queued',
          attempt: 1,
          availableAt: 1,
          firstQueuedAt: 1,
          lastQueuedAt: 1,
          retryCount: 0,
          requeueCount: 0,
        };
  await storage.put(taskLedgerKey(entry.operationId), encodeRemoteTaskRecord(record));
}
