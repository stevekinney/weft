import type { BatchOperation, Storage as WeftStorage } from '../../storage/interface.ts';
import { KEYS, storageConditionalBatch } from '../../storage/interface.ts';
import { encode } from '../codec.ts';
import type { TenantQuotaOptions, TenantQuotaUsage } from '../types.ts';
import {
  extractWorkflowIdFromPendingOperation,
  listTenantActiveWorkflowIds,
  measureWorkflowStorageBytes,
} from './manager-storage.ts';
import { QuotaExceededError } from './quota-error.ts';
import {
  activeQuotaReleaseOperation,
  encodeTenantActiveWorkflowIds,
  encodeTenantStorageBytes,
  quotaCondition,
  storageQuotaReleaseOperation,
  type QuotaCondition,
} from './quota-manager-operations.ts';
import { collectTenantUsageRecords, getWorkflowCreationRateUsage } from './quota-usage.ts';
import {
  decodeTenantActiveWorkflowIds,
  decodeTenantStorageUsageBytes,
  decodeWorkflowCreationRateRecord,
  MAX_CONDITIONAL_BATCH_ATTEMPTS,
  measureStoredRecordBytes,
  normalizeQuotaOptions,
  trimWorkflowCreationTimestamps,
} from './storage-helpers.ts';
import type {
  NormalizedTenantQuotaOptions,
  StartAdmissionParameters,
  TerminalTransitionParameters,
} from './types.ts';

type QuotaMutation = { quotaOperations: BatchOperation[]; conditions: QuotaCondition[] };
type StartAdmissionQuotaRecords = {
  currentStorageUsageRecord: Uint8Array | null;
  currentWorkflowStorageReservationRecord: Uint8Array | null;
  currentActiveRecord: Uint8Array | null;
  durableActiveWorkflowIds: string[];
};

/**
 * Computes tenant-scoped usage from durable storage and prepares start-time
 * quota checks for workflow admission.
 */
export class TenantQuotaManager {
  readonly #storage: WeftStorage;
  readonly #getNow: () => number;
  readonly #quotas: NormalizedTenantQuotaOptions;

  constructor(storage: WeftStorage, getNow: () => number, quotas: TenantQuotaOptions | undefined) {
    this.#storage = storage;
    this.#getNow = getNow;
    this.#quotas = normalizeQuotaOptions(quotas);

    // Configuration-time validation: these quotas rely on compare-and-swap, so
    // refuse construction when the backend's capabilities() reports no
    // conditionalBatch support. Reading the honest capability (not method
    // presence) is what lets a value-transforming decorator be respected.
    if (this.#requiresConditionalBatch() && !storage.capabilities().conditionalBatch) {
      throw new Error(
        'EngineOptions.quotas.maxConcurrentWorkflows, maxWorkflowCreationRate, and maxStorageBytes require a storage backend whose capabilities() reports conditionalBatch support.',
      );
    }
  }

  estimateStartStorageBytes(workflowId: string, operations: BatchOperation[]): number {
    const putOperationValues = new Map<string, Uint8Array>();
    for (const operation of operations) {
      if (operation.type === 'put') {
        putOperationValues.set(operation.key, operation.value);
      }
    }

    let estimatedBytes = 0;

    for (const operation of operations) {
      if (operation.type !== 'put') {
        continue;
      }

      if (
        extractWorkflowIdFromPendingOperation(
          operation.key,
          operation.value,
          putOperationValues,
        ) !== workflowId
      ) {
        continue;
      }

      estimatedBytes += measureStoredRecordBytes(operation.key, operation.value);
    }

    return estimatedBytes;
  }

  async commitStartAdmission(parameters: StartAdmissionParameters): Promise<void> {
    const { tenantId, startOperations } = parameters;

    for (let attempt = 1; attempt <= MAX_CONDITIONAL_BATCH_ATTEMPTS; attempt++) {
      const { quotaOperations, conditions } = await this.#buildStartAdmissionMutation(parameters);

      if (conditions.length === 0) {
        await this.#storage.batch([...startOperations, ...quotaOperations]);
        return;
      }

      if (
        await storageConditionalBatch(this.#storage, conditions, [
          ...startOperations,
          ...quotaOperations,
        ])
      ) {
        return;
      }

      if (attempt === MAX_CONDITIONAL_BATCH_ATTEMPTS) {
        throw new Error(
          `Failed to commit tenant quota admission for "${tenantId}" after ${String(MAX_CONDITIONAL_BATCH_ATTEMPTS)} concurrent retries`,
        );
      }
    }
  }

  async commitTerminalTransition(parameters: TerminalTransitionParameters): Promise<void> {
    const { tenantId, operations } = parameters;

    for (let attempt = 1; attempt <= MAX_CONDITIONAL_BATCH_ATTEMPTS; attempt++) {
      const { quotaOperations, conditions } =
        await this.#buildTerminalTransitionMutation(parameters);

      if (conditions.length === 0) {
        await this.#storage.batch(operations);
        return;
      }

      if (
        await storageConditionalBatch(this.#storage, conditions, [
          ...operations,
          ...quotaOperations,
        ])
      ) {
        return;
      }

      if (attempt === MAX_CONDITIONAL_BATCH_ATTEMPTS) {
        throw new Error(
          `Failed to commit tenant quota release for "${tenantId}" after ${String(MAX_CONDITIONAL_BATCH_ATTEMPTS)} concurrent retries`,
        );
      }
    }
  }

  async getUsage(tenantId: string): Promise<TenantQuotaUsage> {
    if (tenantId.trim().length === 0) {
      throw new Error('tenantId must be a non-empty string');
    }

    const usageRecords = await collectTenantUsageRecords(this.#storage, tenantId);
    const rateLimit = this.#quotas.maxWorkflowCreationRate;
    const workflowCreationRate = await getWorkflowCreationRateUsage(
      this.#storage,
      this.#getNow,
      this.#quotas,
      tenantId,
    );

    return {
      tenantId,
      activeWorkflows: {
        used: usageRecords.activeWorkflows,
        limit: this.#quotas.maxConcurrentWorkflows,
      },
      storageBytes: {
        used: usageRecords.storageBytes,
        limit: this.#quotas.maxStorageBytes,
      },
      workflowCreationRate: {
        used: workflowCreationRate,
        limit: rateLimit?.count ?? null,
        windowMilliseconds: rateLimit?.windowMilliseconds ?? null,
      },
    };
  }

  #requiresConditionalBatch(): boolean {
    return (
      this.#quotas.maxConcurrentWorkflows !== null ||
      this.#quotas.maxStorageBytes !== null ||
      this.#quotas.maxWorkflowCreationRate !== null
    );
  }

  async #buildStartAdmissionMutation(parameters: StartAdmissionParameters): Promise<QuotaMutation> {
    const records = await this.#readStartAdmissionQuotaRecords(parameters);
    const mutation: QuotaMutation = { quotaOperations: [], conditions: [] };

    this.#addStartActiveQuotaMutation(parameters, records, mutation);
    this.#addStartStorageQuotaMutation(parameters, records, mutation);
    await this.#addStartRateQuotaMutation(parameters.tenantId, mutation);

    return mutation;
  }

  async #readStartAdmissionQuotaRecords(
    parameters: StartAdmissionParameters,
  ): Promise<StartAdmissionQuotaRecords> {
    const { tenantId, workflowId } = parameters;
    const currentStorageUsageRecord =
      this.#quotas.maxStorageBytes !== null
        ? await this.#storage.get(KEYS.quotaStorage(tenantId))
        : null;
    const currentWorkflowStorageReservationRecord =
      this.#quotas.maxStorageBytes !== null
        ? await this.#storage.get(KEYS.quotaWorkflowStorage(tenantId, workflowId))
        : null;
    const currentActiveRecord =
      this.#quotas.maxConcurrentWorkflows !== null
        ? await this.#storage.get(KEYS.quotaActive(tenantId))
        : null;
    const durableActiveWorkflowIds = await this.#getDurableActiveWorkflowIds(
      tenantId,
      currentActiveRecord,
    );

    return {
      currentStorageUsageRecord,
      currentWorkflowStorageReservationRecord,
      currentActiveRecord,
      durableActiveWorkflowIds,
    };
  }

  async #getDurableActiveWorkflowIds(
    tenantId: string,
    currentActiveRecord: Uint8Array | null,
  ): Promise<string[]> {
    if (this.#quotas.maxConcurrentWorkflows === null) {
      return [];
    }
    return currentActiveRecord === null
      ? await listTenantActiveWorkflowIds(this.#storage, tenantId)
      : decodeTenantActiveWorkflowIds(currentActiveRecord);
  }

  #addStartActiveQuotaMutation(
    parameters: StartAdmissionParameters,
    records: StartAdmissionQuotaRecords,
    mutation: QuotaMutation,
  ): void {
    if (this.#quotas.maxConcurrentWorkflows === null) {
      return;
    }

    const { tenantId, workflowId } = parameters;
    const nextActiveWorkflowIds = [...new Set([...records.durableActiveWorkflowIds, workflowId])];
    const projectedActiveWorkflows = nextActiveWorkflowIds.length;
    if (projectedActiveWorkflows > this.#quotas.maxConcurrentWorkflows) {
      throw new QuotaExceededError({
        tenantId,
        quota: 'maxConcurrentWorkflows',
        currentUsage: projectedActiveWorkflows,
        limit: this.#quotas.maxConcurrentWorkflows,
      });
    }

    mutation.quotaOperations.push({
      type: 'put',
      key: KEYS.quotaActive(tenantId),
      value: encodeTenantActiveWorkflowIds(nextActiveWorkflowIds),
    });
    mutation.conditions.push(
      quotaCondition(KEYS.quotaActive(tenantId), records.currentActiveRecord),
    );
  }

  #addStartStorageQuotaMutation(
    parameters: StartAdmissionParameters,
    records: StartAdmissionQuotaRecords,
    mutation: QuotaMutation,
  ): void {
    if (this.#quotas.maxStorageBytes === null) {
      return;
    }

    const { tenantId, workflowId, estimatedStorageBytes } = parameters;
    const currentStorageBytes = decodeTenantStorageUsageBytes(records.currentStorageUsageRecord);
    const projectedStorageBytes = currentStorageBytes + estimatedStorageBytes;
    if (projectedStorageBytes > this.#quotas.maxStorageBytes) {
      throw new QuotaExceededError({
        tenantId,
        quota: 'maxStorageBytes',
        currentUsage: projectedStorageBytes,
        limit: this.#quotas.maxStorageBytes,
      });
    }

    mutation.quotaOperations.push(
      {
        type: 'put',
        key: KEYS.quotaStorage(tenantId),
        value: encodeTenantStorageBytes(projectedStorageBytes),
      },
      {
        type: 'put',
        key: KEYS.quotaWorkflowStorage(tenantId, workflowId),
        value: encodeTenantStorageBytes(estimatedStorageBytes),
      },
    );
    mutation.conditions.push(
      quotaCondition(KEYS.quotaStorage(tenantId), records.currentStorageUsageRecord),
      quotaCondition(
        KEYS.quotaWorkflowStorage(tenantId, workflowId),
        records.currentWorkflowStorageReservationRecord,
      ),
    );
  }

  async #addStartRateQuotaMutation(tenantId: string, mutation: QuotaMutation): Promise<void> {
    const rateLimit = this.#quotas.maxWorkflowCreationRate;
    if (rateLimit === null) {
      return;
    }

    const attemptTimestamp = this.#getNow();
    const rateKey = KEYS.quotaRate(tenantId, rateLimit.windowMilliseconds);
    const currentRateRecord = await this.#storage.get(rateKey);
    const currentTimestamps = trimWorkflowCreationTimestamps(
      decodeWorkflowCreationRateRecord(currentRateRecord),
      attemptTimestamp,
      rateLimit.windowMilliseconds,
    );
    const projectedWorkflowCreations = currentTimestamps.length + 1;

    if (projectedWorkflowCreations > rateLimit.count) {
      throw new QuotaExceededError({
        tenantId,
        quota: 'maxWorkflowCreationRate',
        currentUsage: projectedWorkflowCreations,
        limit: rateLimit.count,
        windowMilliseconds: rateLimit.windowMilliseconds,
      });
    }

    mutation.quotaOperations.push({
      type: 'put',
      key: rateKey,
      value: encode({ timestamps: [...currentTimestamps, attemptTimestamp] }),
    });
    mutation.conditions.push(quotaCondition(rateKey, currentRateRecord));
  }

  async #buildTerminalTransitionMutation(
    parameters: TerminalTransitionParameters,
  ): Promise<QuotaMutation> {
    const mutation: QuotaMutation = { quotaOperations: [], conditions: [] };

    await this.#addTerminalActiveQuotaMutation(parameters, mutation);
    await this.#addTerminalStorageQuotaMutation(parameters, mutation);

    return mutation;
  }

  async #addTerminalActiveQuotaMutation(
    parameters: TerminalTransitionParameters,
    mutation: QuotaMutation,
  ): Promise<void> {
    if (this.#quotas.maxConcurrentWorkflows === null) {
      return;
    }

    const { tenantId, workflowId } = parameters;
    const currentActiveRecord = await this.#storage.get(KEYS.quotaActive(tenantId));
    const durableActiveWorkflowIds =
      currentActiveRecord === null
        ? await listTenantActiveWorkflowIds(this.#storage, tenantId)
        : decodeTenantActiveWorkflowIds(currentActiveRecord);
    const remainingWorkflowIds = [
      ...new Set(durableActiveWorkflowIds.filter((id) => id !== workflowId)),
    ];

    mutation.quotaOperations.push(activeQuotaReleaseOperation(tenantId, remainingWorkflowIds));
    mutation.conditions.push(quotaCondition(KEYS.quotaActive(tenantId), currentActiveRecord));
  }

  async #addTerminalStorageQuotaMutation(
    parameters: TerminalTransitionParameters,
    mutation: QuotaMutation,
  ): Promise<void> {
    if (this.#quotas.maxStorageBytes === null) {
      return;
    }

    const { tenantId, workflowId } = parameters;
    const currentStorageUsageRecord = await this.#storage.get(KEYS.quotaStorage(tenantId));
    const currentWorkflowStorageReservationRecord = await this.#storage.get(
      KEYS.quotaWorkflowStorage(tenantId, workflowId),
    );
    const reservedStorageBytes =
      currentWorkflowStorageReservationRecord !== null
        ? decodeTenantStorageUsageBytes(currentWorkflowStorageReservationRecord)
        : await measureWorkflowStorageBytes(this.#storage, workflowId);
    const remainingStorageBytes = Math.max(
      0,
      decodeTenantStorageUsageBytes(currentStorageUsageRecord) - reservedStorageBytes,
    );

    mutation.quotaOperations.push(storageQuotaReleaseOperation(tenantId, remainingStorageBytes), {
      type: 'delete',
      key: KEYS.quotaWorkflowStorage(tenantId, workflowId),
    });
    mutation.conditions.push(
      quotaCondition(KEYS.quotaStorage(tenantId), currentStorageUsageRecord),
      quotaCondition(
        KEYS.quotaWorkflowStorage(tenantId, workflowId),
        currentWorkflowStorageReservationRecord,
      ),
    );
  }
}
