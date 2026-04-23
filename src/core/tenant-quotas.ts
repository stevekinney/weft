/**
 * Per-tenant workflow admission quotas.
 *
 * Enforces tenant-scoped limits at workflow start time and reports current
 * tenant usage by scanning durable workflow-owned storage.
 *
 * @module core/tenant-quotas
 */

import type { BatchOperation, Storage as WeftStorage } from '../storage/interface.ts';
import {
  KEYS,
  storageConditionalBatch,
  tryDecodeStorageKeyComponent,
} from '../storage/interface.ts';
import { decode, encode } from './codec.ts';
import { parseDuration } from './scheduler.ts';
import type { TenantQuotaOptions, TenantQuotaUsage, WorkflowStatus } from './types.ts';

type NormalizedTenantQuotaOptions = {
  maxConcurrentWorkflows: number | null;
  maxStorageBytes: number | null;
  maxWorkflowCreationRate: {
    count: number;
    windowMilliseconds: number;
  } | null;
};

type WorkflowCreationRateRecord = {
  timestamps: number[];
};

type TenantActiveWorkflowRecord = {
  workflowIds: string[];
};

type TenantStorageUsageRecord = {
  bytes: number;
};

type DecodedWorkflowTenantRecord = {
  id: string;
  status: WorkflowStatus;
  tenant?: {
    id: string;
  };
};

type StartAdmissionParameters = {
  tenantId: string;
  workflowId: string;
  startOperations: BatchOperation[];
  estimatedStorageBytes: number;
};

type TerminalTransitionParameters = {
  tenantId: string;
  workflowId: string;
  operations: BatchOperation[];
};

const STORAGE_BYTE_ENCODER = new TextEncoder();

const WORKFLOW_OWNED_PREFIXES = [
  'wf:',
  'attr:',
  'sig:',
  'ev:',
  'review:',
  'wf-headers:',
  'offload:',
  'archive:',
  'shared:',
  'blob:',
  'tool-effect:',
  'upd:',
  'upk:',
] as const;

const WORKFLOW_USAGE_SCAN_PREFIXES = [
  'attr:',
  'idx:',
  'tag:',
  'wf-deadline:',
  'wf-delayed:',
  'timer-idx:',
] as const;

const WORKFLOW_STATUSES: ReadonlySet<WorkflowStatus> = new Set([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

const MAX_CONDITIONAL_BATCH_ATTEMPTS = 5;

function validateLimitNumber(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function validateByteLimit(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function normalizeQuotaOptions(
  options: TenantQuotaOptions | undefined,
): NormalizedTenantQuotaOptions {
  const maxConcurrentWorkflows =
    options?.maxConcurrentWorkflows !== undefined
      ? validateLimitNumber(
          'EngineOptions.quotas.maxConcurrentWorkflows',
          options.maxConcurrentWorkflows,
        )
      : null;

  const maxStorageBytes =
    options?.maxStorageBytes !== undefined
      ? validateByteLimit('EngineOptions.quotas.maxStorageBytes', options.maxStorageBytes)
      : null;

  const maxWorkflowCreationRate =
    options?.maxWorkflowCreationRate !== undefined
      ? {
          count: validateLimitNumber(
            'EngineOptions.quotas.maxWorkflowCreationRate.count',
            options.maxWorkflowCreationRate.count,
          ),
          windowMilliseconds: validateLimitNumber(
            'EngineOptions.quotas.maxWorkflowCreationRate.window',
            parseDuration(options.maxWorkflowCreationRate.window),
          ),
        }
      : null;

  return {
    maxConcurrentWorkflows,
    maxStorageBytes,
    maxWorkflowCreationRate,
  };
}

function isTopLevelWorkflowStateKey(key: string): boolean {
  return key.startsWith('wf:') && !key.slice('wf:'.length).includes(':');
}

function isActiveWorkflowStatus(status: WorkflowStatus): boolean {
  return status === 'pending' || status === 'running';
}

function isDecodedWorkflowStatus(value: unknown): value is WorkflowStatus {
  return typeof value === 'string' && WORKFLOW_STATUSES.has(value as WorkflowStatus);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function extractWorkflowIdFromKeyWithPrefix(key: string, prefix: string): string | null {
  if (!key.startsWith(prefix)) {
    return null;
  }

  const remainder = key.slice(prefix.length);
  const separatorIndex = remainder.indexOf(':');
  const encodedWorkflowId = separatorIndex === -1 ? remainder : remainder.slice(0, separatorIndex);
  if (encodedWorkflowId.length === 0) {
    return null;
  }
  return tryDecodeStorageKeyComponent(encodedWorkflowId);
}

function extractWorkflowIdFromLastKeySegment(key: string): string | null {
  const lastSeparatorIndex = key.lastIndexOf(':');
  if (lastSeparatorIndex === -1 || lastSeparatorIndex === key.length - 1) {
    return null;
  }

  return tryDecodeStorageKeyComponent(key.slice(lastSeparatorIndex + 1));
}

function extractWorkflowIdFromStorageKey(key: string): string | null {
  if (key.startsWith('idx:') || key.startsWith('tag:')) {
    return extractWorkflowIdFromLastKeySegment(key);
  }

  for (const prefix of WORKFLOW_OWNED_PREFIXES) {
    const workflowId = extractWorkflowIdFromKeyWithPrefix(key, prefix);
    if (workflowId !== null) {
      return workflowId;
    }
  }
  return null;
}

function decodeTimerWorkflowId(bytes: Uint8Array): string | null {
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    return null;
  }

  if (!isRecord(decoded) || typeof decoded['workflowId'] !== 'string') {
    return null;
  }

  return decoded['workflowId'];
}

function decodeTimerIndexTargetKey(bytes: Uint8Array): string | null {
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    return null;
  }

  return typeof decoded === 'string' ? decoded : null;
}

function measureStoredRecordBytes(key: string, value: Uint8Array): number {
  return STORAGE_BYTE_ENCODER.encode(key).byteLength + value.byteLength;
}

function resolveNestedWorkflowPrefix(workflowId: string): string {
  return `${KEYS.workflow(workflowId)}:`;
}

function decodeWorkflowCreationRateRecord(bytes: Uint8Array | null): number[] {
  if (!bytes) {
    return [];
  }

  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    return [];
  }

  if (!isRecord(decoded) || !Array.isArray(decoded['timestamps'])) {
    return [];
  }

  return decoded['timestamps'].filter((value): value is number => Number.isFinite(value));
}

function decodeTenantStorageUsageBytes(bytes: Uint8Array | null): number {
  if (!bytes) {
    return 0;
  }

  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    return 0;
  }

  if (!isRecord(decoded)) {
    return 0;
  }

  const bytesUsed = decoded['bytes'];
  if (typeof bytesUsed !== 'number' || !Number.isInteger(bytesUsed) || bytesUsed < 0) {
    return 0;
  }

  return bytesUsed;
}

function decodeTenantActiveWorkflowIds(bytes: Uint8Array | null): string[] {
  if (!bytes) {
    return [];
  }

  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    return [];
  }

  if (!isRecord(decoded) || !Array.isArray(decoded['workflowIds'])) {
    return [];
  }

  return [
    ...new Set(
      decoded['workflowIds'].filter((value): value is string => typeof value === 'string'),
    ),
  ];
}

function decodeWorkflowTenantRecord(bytes: Uint8Array): DecodedWorkflowTenantRecord | null {
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    return null;
  }

  if (!isRecord(decoded)) {
    return null;
  }

  const id = decoded['id'];
  const status = decoded['status'];
  const tenant = decoded['tenant'];
  if (typeof id !== 'string' || !isDecodedWorkflowStatus(status)) {
    return null;
  }

  if (tenant === undefined) {
    return { id, status };
  }

  if (!isRecord(tenant) || typeof tenant['id'] !== 'string') {
    return null;
  }

  return {
    id,
    status,
    tenant: {
      id: tenant['id'],
    },
  };
}

function trimWorkflowCreationTimestamps(
  timestamps: number[],
  now: number,
  windowMilliseconds: number,
): number[] {
  const earliestAllowedTimestamp = now - windowMilliseconds;
  return timestamps.filter((timestamp) => timestamp > earliestAllowedTimestamp);
}

export class QuotaExceededError extends Error {
  readonly tenantId: string;
  readonly quota: 'maxConcurrentWorkflows' | 'maxWorkflowCreationRate' | 'maxStorageBytes';
  readonly currentUsage: number;
  readonly limit: number;
  readonly windowMilliseconds: number | null;

  constructor(parameters: {
    tenantId: string;
    quota: 'maxConcurrentWorkflows' | 'maxWorkflowCreationRate' | 'maxStorageBytes';
    currentUsage: number;
    limit: number;
    windowMilliseconds?: number | null;
  }) {
    const { tenantId, quota, currentUsage, limit, windowMilliseconds = null } = parameters;
    const windowDescription =
      quota === 'maxWorkflowCreationRate' && windowMilliseconds !== null
        ? ` in ${windowMilliseconds}ms`
        : '';

    super(
      `Tenant quota exceeded for "${tenantId}": ${quota} current usage ${currentUsage} exceeds limit ${limit}${windowDescription}`,
    );
    this.name = 'QuotaExceededError';
    this.tenantId = tenantId;
    this.quota = quota;
    this.currentUsage = currentUsage;
    this.limit = limit;
    this.windowMilliseconds = windowMilliseconds;
  }
}

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

    if (this.#requiresConditionalBatch() && !storage.conditionalBatch) {
      throw new Error(
        'EngineOptions.quotas.maxConcurrentWorkflows, maxWorkflowCreationRate, and maxStorageBytes require a storage backend that implements conditionalBatch().',
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
        this.#extractWorkflowIdFromPendingOperation(
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
    const { tenantId, workflowId, startOperations } = parameters;

    for (let attempt = 1; attempt <= MAX_CONDITIONAL_BATCH_ATTEMPTS; attempt++) {
      const quotaOperations: BatchOperation[] = [];
      const conditions: Array<{
        key: string;
        expectedValue: Uint8Array | null;
      }> = [];
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
      const durableActiveWorkflowIds =
        this.#quotas.maxConcurrentWorkflows !== null
          ? currentActiveRecord === null
            ? await this.#listTenantActiveWorkflowIds(tenantId)
            : decodeTenantActiveWorkflowIds(currentActiveRecord)
          : [];

      if (this.#quotas.maxConcurrentWorkflows !== null) {
        const nextActiveWorkflowIds = [...new Set([...durableActiveWorkflowIds, workflowId])];
        const projectedActiveWorkflows = nextActiveWorkflowIds.length;
        if (projectedActiveWorkflows > this.#quotas.maxConcurrentWorkflows) {
          throw new QuotaExceededError({
            tenantId,
            quota: 'maxConcurrentWorkflows',
            currentUsage: projectedActiveWorkflows,
            limit: this.#quotas.maxConcurrentWorkflows,
          });
        }

        quotaOperations.push({
          type: 'put',
          key: KEYS.quotaActive(tenantId),
          value: encode({
            workflowIds: nextActiveWorkflowIds,
          } satisfies TenantActiveWorkflowRecord),
        });
        conditions.push({
          key: KEYS.quotaActive(tenantId),
          expectedValue: currentActiveRecord,
        });
      }

      if (this.#quotas.maxStorageBytes !== null) {
        const currentStorageBytes = decodeTenantStorageUsageBytes(currentStorageUsageRecord);
        const projectedStorageBytes = currentStorageBytes + parameters.estimatedStorageBytes;
        if (projectedStorageBytes > this.#quotas.maxStorageBytes) {
          throw new QuotaExceededError({
            tenantId,
            quota: 'maxStorageBytes',
            currentUsage: projectedStorageBytes,
            limit: this.#quotas.maxStorageBytes,
          });
        }

        quotaOperations.push({
          type: 'put',
          key: KEYS.quotaStorage(tenantId),
          value: encode({
            bytes: projectedStorageBytes,
          } satisfies TenantStorageUsageRecord),
        });
        quotaOperations.push({
          type: 'put',
          key: KEYS.quotaWorkflowStorage(tenantId, workflowId),
          value: encode({
            bytes: parameters.estimatedStorageBytes,
          } satisfies TenantStorageUsageRecord),
        });
        conditions.push({
          key: KEYS.quotaStorage(tenantId),
          expectedValue: currentStorageUsageRecord,
        });
        conditions.push({
          key: KEYS.quotaWorkflowStorage(tenantId, workflowId),
          expectedValue: currentWorkflowStorageReservationRecord,
        });
      }

      const rateLimit = this.#quotas.maxWorkflowCreationRate;
      if (rateLimit !== null) {
        const attemptTimestamp = this.#getNow();
        const currentRateRecord = await this.#storage.get(
          KEYS.quotaRate(tenantId, rateLimit.windowMilliseconds),
        );
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

        quotaOperations.push({
          type: 'put',
          key: KEYS.quotaRate(tenantId, rateLimit.windowMilliseconds),
          value: encode({
            timestamps: [...currentTimestamps, attemptTimestamp],
          } satisfies WorkflowCreationRateRecord),
        });
        conditions.push({
          key: KEYS.quotaRate(tenantId, rateLimit.windowMilliseconds),
          expectedValue: currentRateRecord,
        });
      }

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
    const { tenantId, workflowId, operations } = parameters;

    for (let attempt = 1; attempt <= MAX_CONDITIONAL_BATCH_ATTEMPTS; attempt++) {
      const quotaOperations: BatchOperation[] = [];
      const conditions: Array<{
        key: string;
        expectedValue: Uint8Array | null;
      }> = [];

      if (this.#quotas.maxConcurrentWorkflows !== null) {
        const currentActiveRecord = await this.#storage.get(KEYS.quotaActive(tenantId));
        const durableActiveWorkflowIds =
          currentActiveRecord === null
            ? await this.#listTenantActiveWorkflowIds(tenantId)
            : decodeTenantActiveWorkflowIds(currentActiveRecord);
        const remainingWorkflowIds = [
          ...new Set(durableActiveWorkflowIds.filter((id) => id !== workflowId)),
        ];

        quotaOperations.push(
          ...(remainingWorkflowIds.length > 0
            ? [
                {
                  type: 'put' as const,
                  key: KEYS.quotaActive(tenantId),
                  value: encode({
                    workflowIds: remainingWorkflowIds,
                  } satisfies TenantActiveWorkflowRecord),
                },
              ]
            : [{ type: 'delete' as const, key: KEYS.quotaActive(tenantId) }]),
        );
        conditions.push({
          key: KEYS.quotaActive(tenantId),
          expectedValue: currentActiveRecord,
        });
      }

      if (this.#quotas.maxStorageBytes !== null) {
        const currentStorageUsageRecord = await this.#storage.get(KEYS.quotaStorage(tenantId));
        const currentWorkflowStorageReservationRecord = await this.#storage.get(
          KEYS.quotaWorkflowStorage(tenantId, workflowId),
        );
        const reservedStorageBytes =
          currentWorkflowStorageReservationRecord !== null
            ? decodeTenantStorageUsageBytes(currentWorkflowStorageReservationRecord)
            : await this.#measureWorkflowStorageBytes(workflowId);
        const remainingStorageBytes = Math.max(
          0,
          decodeTenantStorageUsageBytes(currentStorageUsageRecord) - reservedStorageBytes,
        );

        quotaOperations.push(
          ...(remainingStorageBytes > 0
            ? [
                {
                  type: 'put' as const,
                  key: KEYS.quotaStorage(tenantId),
                  value: encode({
                    bytes: remainingStorageBytes,
                  } satisfies TenantStorageUsageRecord),
                },
              ]
            : [{ type: 'delete' as const, key: KEYS.quotaStorage(tenantId) }]),
        );
        quotaOperations.push({
          type: 'delete',
          key: KEYS.quotaWorkflowStorage(tenantId, workflowId),
        });
        conditions.push({
          key: KEYS.quotaStorage(tenantId),
          expectedValue: currentStorageUsageRecord,
        });
        conditions.push({
          key: KEYS.quotaWorkflowStorage(tenantId, workflowId),
          expectedValue: currentWorkflowStorageReservationRecord,
        });
      }

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

    const tenantWorkflowIds = new Set<string>();
    let activeWorkflows = 0;
    let storageBytes = 0;

    for await (const [key, value] of this.#storage.scan('wf:')) {
      if (!isTopLevelWorkflowStateKey(key)) {
        continue;
      }

      const workflowState = decodeWorkflowTenantRecord(value);
      if (!workflowState) {
        continue;
      }
      if (workflowState.tenant?.id !== tenantId) {
        continue;
      }

      tenantWorkflowIds.add(workflowState.id);
      storageBytes += measureStoredRecordBytes(key, value);

      if (isActiveWorkflowStatus(workflowState.status)) {
        activeWorkflows++;
      }
    }

    if (tenantWorkflowIds.size > 0) {
      for (const workflowId of tenantWorkflowIds) {
        for await (const [key, value] of this.#storage.scan(
          resolveNestedWorkflowPrefix(workflowId),
        )) {
          storageBytes += measureStoredRecordBytes(key, value);
        }
      }

      for (const prefix of WORKFLOW_USAGE_SCAN_PREFIXES) {
        for await (const [key, value] of this.#storage.scan(prefix)) {
          const workflowId = await this.#extractWorkflowIdFromStoredRecord(key, value);
          if (!workflowId || !tenantWorkflowIds.has(workflowId)) {
            continue;
          }

          storageBytes += measureStoredRecordBytes(key, value);
        }
      }
    }

    const rateLimit = this.#quotas.maxWorkflowCreationRate;
    const workflowCreationRate = rateLimit
      ? trimWorkflowCreationTimestamps(
          decodeWorkflowCreationRateRecord(
            await this.#storage.get(KEYS.quotaRate(tenantId, rateLimit.windowMilliseconds)),
          ),
          this.#getNow(),
          rateLimit.windowMilliseconds,
        ).length
      : 0;

    return {
      tenantId,
      activeWorkflows: {
        used: activeWorkflows,
        limit: this.#quotas.maxConcurrentWorkflows,
      },
      storageBytes: {
        used: storageBytes,
        limit: this.#quotas.maxStorageBytes,
      },
      workflowCreationRate: {
        used: workflowCreationRate,
        limit: rateLimit?.count ?? null,
        windowMilliseconds: rateLimit?.windowMilliseconds ?? null,
      },
    };
  }

  async #listTenantActiveWorkflowIds(tenantId: string): Promise<string[]> {
    const workflowIds = new Set<string>();

    for await (const [key, value] of this.#storage.scan('wf:')) {
      if (!isTopLevelWorkflowStateKey(key)) {
        continue;
      }

      const workflowState = decodeWorkflowTenantRecord(value);
      if (!workflowState || workflowState.tenant?.id !== tenantId) {
        continue;
      }

      if (isActiveWorkflowStatus(workflowState.status)) {
        workflowIds.add(workflowState.id);
      }
    }

    return [...workflowIds];
  }

  #extractWorkflowIdFromPendingOperation(
    key: string,
    value: Uint8Array,
    putOperationValues: ReadonlyMap<string, Uint8Array>,
  ): string | null {
    if (key.startsWith('wf-deadline:') || key.startsWith('wf-delayed:')) {
      return decodeTimerWorkflowId(value);
    }

    if (key.startsWith('timer-idx:')) {
      const timerTargetKey = decodeTimerIndexTargetKey(value);
      if (!timerTargetKey) {
        return null;
      }

      const timerTargetValue = putOperationValues.get(timerTargetKey);
      return timerTargetValue ? decodeTimerWorkflowId(timerTargetValue) : null;
    }

    return extractWorkflowIdFromStorageKey(key);
  }

  async #extractWorkflowIdFromStoredRecord(key: string, value: Uint8Array): Promise<string | null> {
    if (key.startsWith('wf-deadline:') || key.startsWith('wf-delayed:')) {
      return decodeTimerWorkflowId(value);
    }

    if (key.startsWith('timer-idx:')) {
      const timerTargetKey = decodeTimerIndexTargetKey(value);
      if (!timerTargetKey) {
        return null;
      }

      const timerTargetValue = await this.#storage.get(timerTargetKey);
      return timerTargetValue ? decodeTimerWorkflowId(timerTargetValue) : null;
    }

    return extractWorkflowIdFromStorageKey(key);
  }

  async #measureWorkflowStorageBytes(workflowId: string): Promise<number> {
    let storageBytes = 0;

    const workflowStateBytes = await this.#storage.get(KEYS.workflow(workflowId));
    if (workflowStateBytes !== null) {
      storageBytes += measureStoredRecordBytes(KEYS.workflow(workflowId), workflowStateBytes);
    }

    for await (const [key, value] of this.#storage.scan(resolveNestedWorkflowPrefix(workflowId))) {
      storageBytes += measureStoredRecordBytes(key, value);
    }

    for (const prefix of WORKFLOW_USAGE_SCAN_PREFIXES) {
      for await (const [key, value] of this.#storage.scan(prefix)) {
        const ownedWorkflowId = await this.#extractWorkflowIdFromStoredRecord(key, value);
        if (ownedWorkflowId !== workflowId) {
          continue;
        }

        storageBytes += measureStoredRecordBytes(key, value);
      }
    }

    return storageBytes;
  }

  #requiresConditionalBatch(): boolean {
    return (
      this.#quotas.maxConcurrentWorkflows !== null ||
      this.#quotas.maxStorageBytes !== null ||
      this.#quotas.maxWorkflowCreationRate !== null
    );
  }
}
