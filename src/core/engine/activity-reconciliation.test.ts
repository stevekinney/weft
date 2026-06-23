import { describe, expect, it } from 'bun:test';

import type { ConditionalBatchCondition } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import type { ContextOperationRequest } from '../context.ts';
import {
  buildActivityReconciliationReference,
  commitActivityReconciliationTransitionWithFencedWrite,
  normalizePreDispatchVerificationResult,
  readActivityReconciliationRecord,
  resolveStartedActivityReconciliationRecord,
} from './activity-reconciliation.ts';
import type { EngineInternals } from './internals.ts';

type ActivityOperation = Extract<ContextOperationRequest, { type: 'activity' }>;

class ClaimLosingWithoutRecordStorage extends MemoryStorage {
  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: Array<{ type: 'put'; key: string; value: Uint8Array }>,
  ): Promise<boolean> {
    const condition = conditions[0];
    const operation = operations[0];
    const isInitialClaim =
      conditions.length === 1 && condition?.expectedValue === null && operation?.type === 'put';
    if (isInitialClaim) {
      return false;
    }
    return super.conditionalBatch(conditions, operations);
  }
}

class TransitionLosingStorage extends MemoryStorage {
  override async conditionalBatch(): Promise<boolean> {
    return false;
  }
}

function createInternals(storage: MemoryStorage): EngineInternals {
  return {
    options: {
      getNow: () => 2_000,
      ownershipMode: 'none',
      payloadSizePolicy: { maxBytes: null },
    },
    storage,
    deposed: false,
    leaseManager: null,
  } as unknown as EngineInternals;
}

function createActivityOperation(overrides: Partial<ActivityOperation> = {}): ActivityOperation {
  return {
    type: 'activity',
    operationId: 'activity-operation',
    activityName: 'test-activity',
    input: 'payload',
    options: { idempotencyKey: 'activity-key' },
    ...overrides,
  };
}

describe('activity reconciliation helpers', () => {
  it('rejects completed reconciliation records that omit the completed result payload', async () => {
    const storage = new MemoryStorage();
    const reference = await buildActivityReconciliationReference(
      'workflow-id',
      'test-activity',
      'activity-key',
    );
    await storage.put(
      reference.key,
      encode({
        version: 1,
        status: 'completed',
        workflowId: 'workflow-id',
        operationId: 'activity-operation',
        activityName: 'test-activity',
        idempotencyKeyDigest: reference.idempotencyKeyDigest,
        attempt: 1,
        ownerId: 'owner',
        createdAt: 1,
        updatedAt: 2,
      }),
    );

    await expect(readActivityReconciliationRecord(storage, reference.key)).rejects.toThrow(
      'Activity reconciliation record has an unsupported status.',
    );
  });

  it('rejects unsupported verifier normalization results', () => {
    expect(() =>
      normalizePreDispatchVerificationResult({
        status: 'completed-without-result',
      } as unknown as Parameters<typeof normalizePreDispatchVerificationResult>[0]),
    ).toThrow('Tier-0 pre-dispatch reconciliation state');
  });

  it('fails closed when a lost initial claim cannot read the competing record back', async () => {
    const storage = new ClaimLosingWithoutRecordStorage();
    const internals = createInternals(storage);
    const operation = createActivityOperation();
    const reference = await buildActivityReconciliationReference(
      'workflow-id',
      operation.activityName,
      'activity-key',
    );

    await expect(
      resolveStartedActivityReconciliationRecord(
        internals,
        'workflow-id',
        operation,
        reference,
        undefined,
        'activity-key',
        1,
      ),
    ).rejects.toThrow('claim conflicted but no record could be read');
  });

  it('surfaces fenced-write ownership loss when committing a reconciliation transition', async () => {
    const storage = new TransitionLosingStorage();
    const internals = createInternals(storage);
    const reference = await buildActivityReconciliationReference(
      'workflow-id',
      'test-activity',
      'activity-key',
    );
    const expectedRecord = {
      version: 1 as const,
      status: 'started' as const,
      workflowId: 'workflow-id',
      operationId: 'activity-operation',
      activityName: 'test-activity',
      idempotencyKeyDigest: reference.idempotencyKeyDigest,
      attempt: 1,
      ownerId: 'owner',
      createdAt: 1,
      updatedAt: 1,
    };
    await storage.put(reference.key, encode(expectedRecord));

    await expect(
      commitActivityReconciliationTransitionWithFencedWrite(internals, reference, expectedRecord, {
        ...expectedRecord,
        status: 'completed',
        result: 'done',
        updatedAt: 2,
      }),
    ).rejects.toThrow('Activity reconciliation completion lost compare-and-set ownership.');
  });
});
