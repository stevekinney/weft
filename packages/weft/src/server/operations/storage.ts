import { decodeBase64ToBytes, encodeBytesToBase64 } from '../../storage/byte-encoding.ts';
import {
  assertStorageBatchOperationCount,
  storageConditionalBatch,
  type BatchOperation,
  type ConditionalBatchCondition,
  type ScanOptions,
  type Storage,
} from '../../storage/interface.ts';
import type { AccessPolicy } from '../authorization.ts';
import { raiseFault } from '../operation-catalog.ts';
import { defineOperation } from '../operation-registry.ts';
import { isAuthenticated, type Principal } from '../principal.ts';
import {
  invalidParamsFault,
  requireOperationStorage,
  type OperationStorageMethodName,
} from './operation-helpers.ts';
import {
  emptyOutput,
  storageBatchInput,
  storageConditionalBatchInput,
  storageConditionalBatchOutput,
  storageDeleteInput,
  storageGetInput,
  storageGetOutput,
  storagePutInput,
  storageScanInput,
  storageScanOutput,
  type StorageBatchInput,
  type StorageConditionalBatchInput,
  type StorageScanInput,
  type StorageScanOutput,
} from './storage-schemas.ts';

const rawStorageAccess: AccessPolicy = {
  kind: 'scoped',
  scopes: { kind: 'anyOf', scopes: ['storage:admin'] },
};

const httpOnlyStorageTransports = {
  http: true,
  jsonRpcHttp: false,
  jsonRpcStdio: false,
  jsonRpcWebSocket: false,
} as const;

function resolveAuthorizedStorage<const Methods extends readonly OperationStorageMethodName[]>(
  engine: unknown,
  principal: Principal,
  operationName: string,
  methods: Methods,
): Pick<Storage, Methods[number]> {
  if (!isAuthenticated(principal)) {
    return raiseFault(
      { name: operationName },
      {
        code: 'Unauthorized',
        message: 'authentication required',
        data: { reason: 'authentication required' },
      },
    );
  }

  if (principal.hasScope('storage:admin')) {
    return requireOperationStorage(engine, methods);
  }

  return raiseFault(
    { name: operationName },
    {
      code: 'Forbidden',
      message: 'Raw storage access requires storage:admin.',
      data: { reason: 'Raw storage access requires storage:admin.' },
    },
  );
}

function scanOptions(input: StorageScanInput): ScanOptions {
  return {
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.reverse === undefined ? {} : { reverse: input.reverse }),
    ...(input.gt === undefined ? {} : { gt: input.gt }),
    ...(input.gte === undefined ? {} : { gte: input.gte }),
    ...(input.lt === undefined ? {} : { lt: input.lt }),
    ...(input.lte === undefined ? {} : { lte: input.lte }),
  };
}

function decodeBatchOperation(operation: StorageBatchInput['operations'][number]): BatchOperation {
  if (operation.type === 'put') {
    return {
      type: 'put',
      key: operation.key,
      value: decodeStorageBytes(operation.value, 'Storage batch operation value must be base64.'),
    };
  }
  return { type: 'delete', key: operation.key };
}

function decodeStorageBytes(value: string, message: string): Uint8Array {
  try {
    return decodeBase64ToBytes(value);
  } catch {
    throw invalidParamsFault(message);
  }
}

function decodeCondition(
  condition: StorageConditionalBatchInput['conditions'][number],
): ConditionalBatchCondition {
  return {
    key: condition.key,
    expectedValue:
      condition.expectedValue === null
        ? null
        : decodeStorageBytes(
            condition.expectedValue,
            'Storage conditional batch expectedValue must be base64.',
          ),
  };
}

async function* scanStorage(
  storage: Pick<Storage, 'scan'>,
  prefix: string,
  options: ScanOptions,
): StorageScanOutput {
  for await (const [key, value] of storage.scan(prefix, options)) {
    yield { key, value: encodeBytesToBase64(value) };
  }
}

export const storageGetOperation = defineOperation({
  name: 'weft.storage.get',
  mcpExposable: false,
  summary: 'Get a raw storage value',
  destructive: false,
  tags: ['Storage'],
  inputSchema: storageGetInput,
  outputSchema: storageGetOutput,
  access: rawStorageAccess,
  discoverable: true,
  transports: httpOnlyStorageTransports,
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }) => {
    const storage = resolveAuthorizedStorage<['get']>(engine, principal, 'weft.storage.get', [
      'get',
    ]);
    return storage.get(input.key);
  },
});

export const storagePutOperation = defineOperation({
  name: 'weft.storage.put',
  mcpExposable: false,
  summary: 'Put a raw storage value',
  destructive: true,
  tags: ['Storage'],
  inputSchema: storagePutInput,
  outputSchema: emptyOutput,
  access: rawStorageAccess,
  discoverable: true,
  transports: httpOnlyStorageTransports,
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }) => {
    const storage = resolveAuthorizedStorage<['put']>(engine, principal, 'weft.storage.put', [
      'put',
    ]);
    await storage.put(input.key, input.value);
    return null;
  },
});

export const storageDeleteOperation = defineOperation({
  name: 'weft.storage.delete',
  mcpExposable: false,
  summary: 'Delete a raw storage value',
  destructive: true,
  tags: ['Storage'],
  inputSchema: storageDeleteInput,
  outputSchema: emptyOutput,
  access: rawStorageAccess,
  discoverable: true,
  transports: httpOnlyStorageTransports,
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }) => {
    const storage = resolveAuthorizedStorage<['delete']>(engine, principal, 'weft.storage.delete', [
      'delete',
    ]);
    await storage.delete(input.key);
    return null;
  },
});

export const storageScanOperation = defineOperation({
  name: 'weft.storage.scan',
  mcpExposable: false,
  summary: 'Scan raw storage values',
  destructive: false,
  tags: ['Storage'],
  inputSchema: storageScanInput,
  outputSchema: storageScanOutput,
  access: rawStorageAccess,
  discoverable: true,
  transports: httpOnlyStorageTransports,
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }) => {
    const storage = resolveAuthorizedStorage<['scan']>(engine, principal, 'weft.storage.scan', [
      'scan',
    ]);
    return scanStorage(storage, input.prefix, scanOptions(input));
  },
});

export const storageBatchOperation = defineOperation({
  name: 'weft.storage.batch',
  mcpExposable: false,
  summary: 'Apply a raw storage batch',
  destructive: true,
  tags: ['Storage'],
  inputSchema: storageBatchInput,
  outputSchema: emptyOutput,
  access: rawStorageAccess,
  discoverable: true,
  transports: httpOnlyStorageTransports,
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }) => {
    const storage = resolveAuthorizedStorage<['batch']>(engine, principal, 'weft.storage.batch', [
      'batch',
    ]);
    const operations = input.operations.map(decodeBatchOperation);
    assertStorageBatchOperationCount('batch operations', operations.length);
    await storage.batch(operations);
    return null;
  },
});

export const storageConditionalBatchOperation = defineOperation({
  name: 'weft.storage.conditionalbatch',
  mcpExposable: false,
  summary: 'Apply a raw storage conditional batch',
  destructive: true,
  tags: ['Storage'],
  inputSchema: storageConditionalBatchInput,
  outputSchema: storageConditionalBatchOutput,
  access: rawStorageAccess,
  discoverable: true,
  transports: httpOnlyStorageTransports,
  producibleFaults: ['NotImplemented'], // backend reports no conditionalBatch

  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }) => {
    const storage = resolveAuthorizedStorage<['capabilities']>(
      engine,
      principal,
      'weft.storage.conditionalbatch',
      ['capabilities'],
    );
    // Shaped fault instead of leaking the low-level storageConditionalBatch throw.
    if (!storage.capabilities().conditionalBatch) {
      raiseFault(storageConditionalBatchOperation, {
        code: 'NotImplemented',
        message: 'This storage backend reports capabilities().conditionalBatch: false.',
        data: {},
      });
    }
    const conditions = input.conditions.map(decodeCondition);
    const operations = input.operations.map(decodeBatchOperation);
    assertStorageBatchOperationCount('conditionalBatch conditions', conditions.length);
    assertStorageBatchOperationCount('conditionalBatch operations', operations.length);
    const applied = await storageConditionalBatch(storage, conditions, operations);
    return { applied };
  },
});
