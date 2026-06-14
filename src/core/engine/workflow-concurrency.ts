import type { BatchOperation, ConditionalBatchCondition } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { AtomicState, atomicStateVersionKey, readAtomicStateSnapshot } from '../atomic-state.ts';
import { decode, encode } from '../codec.ts';
import {
  initialLockRecord,
  reduceRelease,
  type LockHolder,
  type LockRecord,
} from '../concurrency.ts';
import type { WorkflowConcurrencyOptions } from '../types.ts';
import { WorkflowConcurrencyLimitExceededError } from './errors.ts';
import type { EngineInternals } from './internals.ts';

const WORKFLOW_CONCURRENCY_HOLDER_VERSION = 1;
const NON_EXPIRING_WORKFLOW_CONCURRENCY_LEASE = Number.MAX_SAFE_INTEGER;

export type WorkflowConcurrencyStartOperations = {
  stateKey: string;
  operations: BatchOperation[];
  conditions: ConditionalBatchCondition[];
};

type WorkflowConcurrencyHolderRecord = {
  version: typeof WORKFLOW_CONCURRENCY_HOLDER_VERSION;
  workflowType: string;
  partitionKey: string;
};

function encodeVersionCondition(dataKey: string, version: number): ConditionalBatchCondition {
  return {
    key: atomicStateVersionKey(dataKey),
    expectedValue: version === 0 ? null : encode(version),
  };
}

function normalizeLockRecord(record: LockRecord | undefined): LockRecord {
  if (record === undefined) return initialLockRecord();
  return {
    holders: Array.isArray(record.holders) ? record.holders : [],
    waiters: Array.isArray(record.waiters) ? record.waiters : [],
  };
}

function liveWorkflowConcurrencyHolders(holders: LockHolder[], now: number): LockHolder[] {
  return holders.filter((holder) => holder.leaseExpiresAt > now);
}

function acquireWorkflowConcurrencySlot(
  current: LockRecord | undefined,
  options: { workflowId: string; now: number; limit: number },
): { acquired: boolean; record: LockRecord } {
  const record = normalizeLockRecord(current);
  const holders = liveWorkflowConcurrencyHolders(record.holders, options.now);

  if (holders.some((holder) => holder.holderId === options.workflowId)) {
    return {
      acquired: true,
      record: {
        holders: holders.map((holder) =>
          holder.holderId === options.workflowId
            ? {
                holderId: options.workflowId,
                leaseExpiresAt: NON_EXPIRING_WORKFLOW_CONCURRENCY_LEASE,
              }
            : holder,
        ),
        waiters: [],
      },
    };
  }

  if (holders.length >= options.limit) {
    return { acquired: false, record: { holders, waiters: [] } };
  }

  return {
    acquired: true,
    record: {
      holders: [
        ...holders,
        {
          holderId: options.workflowId,
          leaseExpiresAt: NON_EXPIRING_WORKFLOW_CONCURRENCY_LEASE,
        },
      ],
      waiters: [],
    },
  };
}

function resolveWorkflowConcurrencyPartitionKey(
  workflowType: string,
  input: unknown,
  concurrency: WorkflowConcurrencyOptions,
): string {
  if (concurrency.key === undefined) {
    return workflowType;
  }
  const partitionKey = concurrency.key(input);
  if (typeof partitionKey !== 'string') {
    throw new TypeError(
      `workflow("${workflowType}").concurrency.key must return a string partition key`,
    );
  }
  return partitionKey;
}

function encodeHolderRecord(
  workflowType: string,
  partitionKey: string,
): WorkflowConcurrencyHolderRecord {
  return {
    version: WORKFLOW_CONCURRENCY_HOLDER_VERSION,
    workflowType,
    partitionKey,
  };
}

function decodeHolderRecord(bytes: Uint8Array): WorkflowConcurrencyHolderRecord | null {
  const decoded = decode(bytes);
  if (typeof decoded !== 'object' || decoded === null) {
    return null;
  }
  const record = decoded as Record<string, unknown>;
  if (
    record['version'] !== WORKFLOW_CONCURRENCY_HOLDER_VERSION ||
    typeof record['workflowType'] !== 'string' ||
    typeof record['partitionKey'] !== 'string'
  ) {
    return null;
  }
  return {
    version: WORKFLOW_CONCURRENCY_HOLDER_VERSION,
    workflowType: record['workflowType'],
    partitionKey: record['partitionKey'],
  };
}

export async function buildWorkflowConcurrencyStartOperations(
  internals: EngineInternals,
  workflowType: string,
  workflowId: string,
  input: unknown,
  concurrency: WorkflowConcurrencyOptions,
): Promise<WorkflowConcurrencyStartOperations> {
  const partitionKey = resolveWorkflowConcurrencyPartitionKey(workflowType, input, concurrency);
  const stateKey = KEYS.workflowConcurrency(workflowType, partitionKey);
  const snapshot = await readAtomicStateSnapshot<LockRecord>(internals.storage, stateKey, {
    initial: initialLockRecord(),
  });
  const acquired = acquireWorkflowConcurrencySlot(snapshot.value, {
    workflowId,
    now: internals.options.getNow(),
    limit: concurrency.max,
  });

  if (!acquired.acquired) {
    throw new WorkflowConcurrencyLimitExceededError({
      workflowType,
      limit: concurrency.max,
      partitionKey,
    });
  }

  return {
    stateKey,
    conditions: [encodeVersionCondition(stateKey, snapshot.version)],
    operations: [
      { type: 'put', key: stateKey, value: encode(acquired.record) },
      { type: 'put', key: atomicStateVersionKey(stateKey), value: encode(snapshot.version + 1) },
      {
        type: 'put',
        key: KEYS.workflowConcurrencyHolder(workflowId),
        value: encode(encodeHolderRecord(workflowType, partitionKey)),
      },
      {
        type: 'put',
        key: KEYS.terminalCleanupNeeded(workflowId),
        value: new Uint8Array(0),
      },
    ],
  };
}

export async function releaseWorkflowConcurrencySlot(
  internals: EngineInternals,
  workflowId: string,
): Promise<void> {
  const holderKey = KEYS.workflowConcurrencyHolder(workflowId);
  const markerBytes = await internals.storage.get(holderKey);
  if (markerBytes === null) {
    return;
  }

  const marker = decodeHolderRecord(markerBytes);
  if (marker === null) {
    await internals.storage.delete(holderKey);
    return;
  }

  const stateKey = KEYS.workflowConcurrency(marker.workflowType, marker.partitionKey);
  const slot = new AtomicState<LockRecord>(internals.storage, stateKey, {
    initial: initialLockRecord(),
  });
  await slot.update((current) =>
    reduceRelease(current, { holderId: workflowId, now: internals.options.getNow() }),
  );
  await internals.storage.delete(holderKey);
}
