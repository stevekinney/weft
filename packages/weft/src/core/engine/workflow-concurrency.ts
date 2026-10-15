import { sleep } from '../../runtime/portable.ts';
import type { BatchOperation, ConditionalBatchCondition } from '../../storage/interface.ts';
import { KEYS, storageConditionalBatch } from '../../storage/interface.ts';
import {
  AtomicState,
  AtomicStateConflictError,
  atomicStateVersionKey,
  readAtomicStateSnapshot,
  retryDelay,
} from '../atomic-state.ts';
import { decode, encode } from '../codec.ts';
import {
  initialLockRecord,
  reduceRelease,
  type LockHolder,
  type LockRecord,
} from '../concurrency.ts';
import type { WorkflowConcurrencyOptions } from '../types.ts';
import { WorkflowConcurrencyLimitExceededError } from './errors.ts';
import type { RunIdentity } from './execution-attempts.ts';
import type { EngineInternals } from './internals.ts';
import {
  bytesEqual,
  FENCED_RETRY_BUDGET,
  sameRunCondition,
  type TerminalFence,
} from './termination/terminal-fence.ts';

const WORKFLOW_CONCURRENCY_HOLDER_VERSION = 1;
const MAX_FENCED_RELEASE_ATTEMPTS = FENCED_RETRY_BUDGET;
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
  let partitionKey: unknown;
  try {
    partitionKey = concurrency.key(input);
  } catch (error) {
    throw new Error(
      `workflow("${workflowType}").concurrency.key threw while resolving the partition key: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
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

/**
 * Release the concurrency slot a terminal commit's run held, fenced on that
 * commit's durable identity (see {@link TerminalFence}).
 *
 * The slot entry and the holder marker are keyed by workflow id, and a
 * same-id `start-new` replacement re-stamps or replaces them. The partition is
 * read from the marker captured before the commit, so it is still known after
 * a replacement purged the marker. While the id still belongs to the committing
 * run, one conditional batch frees the entry and drops the marker. Once a
 * replacement owns the id, a same-partition entry is the replacement's and is
 * left alone, and a different-partition entry is the old run's own and is
 * freed, fenced on the replacement's marker staying as observed.
 */
export async function releaseWorkflowConcurrencySlotForRun(
  internals: EngineInternals,
  workflowId: string,
  fence: TerminalFence,
): Promise<void> {
  const holderKey = KEYS.workflowConcurrencyHolder(workflowId);
  const identity = fence.identity;
  if (identity === undefined) return;
  const capturedMarker = identity.holderMarker;
  if (capturedMarker === null) return;
  const marker = decodeHolderRecord(capturedMarker);
  const ownCommit = sameRunCondition(workflowId, identity);
  if (marker === null) {
    await storageConditionalBatch(
      internals.storage,
      [ownCommit, { key: holderKey, expectedValue: capturedMarker }],
      [{ type: 'delete', key: holderKey }],
    );
    return;
  }

  const stateKey = KEYS.workflowConcurrency(marker.workflowType, marker.partitionKey);
  for (let attempt = 0; attempt < MAX_FENCED_RELEASE_ATTEMPTS; attempt++) {
    const snapshot = await readAtomicStateSnapshot<LockRecord>(internals.storage, stateKey, {
      initial: initialLockRecord(),
    });
    const released = reduceRelease(snapshot.value, {
      holderId: workflowId,
      now: internals.options.getNow(),
    });
    const slotOperations: BatchOperation[] = [
      { type: 'put', key: stateKey, value: encode(released) },
      { type: 'put', key: atomicStateVersionKey(stateKey), value: encode(snapshot.version + 1) },
    ];
    const slotVersion = encodeVersionCondition(stateKey, snapshot.version);
    const releaseAll = [...slotOperations, { type: 'delete' as const, key: holderKey }];
    // The marker deleted is the one captured for this run, enforced by the condition itself.
    const ownMarker = { key: holderKey, expectedValue: capturedMarker };
    if (
      await storageConditionalBatch(
        internals.storage,
        [slotVersion, ownCommit, ownMarker],
        releaseAll,
      )
    ) {
      return;
    }

    // Either the slot version moved or the id changed hands; find out which.
    if (
      await settleAfterConflict(
        internals,
        workflowId,
        identity,
        marker,
        slotVersion,
        slotOperations,
      )
    ) {
      return;
    }
    // Lost a race for the slot: back off with jitter, as `AtomicState` does, so contenders spread out.
    if (attempt < MAX_FENCED_RELEASE_ATTEMPTS - 1) await sleep(retryDelay(attempt));
  }
  throw new AtomicStateConflictError(stateKey, MAX_FENCED_RELEASE_ATTEMPTS);
}

/** Whether `markerBytes` is a holder marker for the same concurrency partition as `marker`. */
function isSamePartitionMarker(
  markerBytes: Uint8Array | null,
  marker: WorkflowConcurrencyHolderRecord,
): boolean {
  const current = markerBytes === null ? null : decodeHolderRecord(markerBytes);
  return (
    current !== null &&
    current.workflowType === marker.workflowType &&
    current.partitionKey === marker.partitionKey
  );
}

/**
 * After a fenced release lost its conditional batch, decide whether it is finished. Returns
 * `true` when there is nothing left to do (the id changed hands and the entry is the
 * replacement's, or the old partition's own entry was freed) and `false` to retry, which is the
 * case for a same-run slot race.
 */
async function settleAfterConflict(
  internals: EngineInternals,
  workflowId: string,
  identity: RunIdentity,
  marker: WorkflowConcurrencyHolderRecord,
  slotVersion: ConditionalBatchCondition,
  slotOperations: BatchOperation[],
): Promise<boolean> {
  const holderKey = KEYS.workflowConcurrencyHolder(workflowId);
  // Read the generation, then the marker, never together: a replacement writes its generation and
  // marker in one batch, so a marker read after a changed generation is the replacement's (or a
  // later state), never this run's own. Read together, a marker fetched just before the
  // replacement landed would look like the replacement's and the old partition would be skipped.
  const generationNow = await internals.storage.get(KEYS.workflowGeneration(workflowId));
  if (bytesEqual(generationNow, identity.generation)) {
    // Still this run. If its marker is already gone, a concurrent terminalizer of the same run
    // (a completion racing a remote cancel) released the slot in one batch with that delete, so
    // the release is idempotent and done. Otherwise only the slot version moved: retry.
    return (await internals.storage.get(holderKey)) === null;
  }
  const markerNow = await internals.storage.get(holderKey);
  if (isSamePartitionMarker(markerNow, marker)) return true;
  const conditions = [slotVersion, { key: holderKey, expectedValue: markerNow }];
  return storageConditionalBatch(internals.storage, conditions, slotOperations);
}
