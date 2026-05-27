import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { decodeBase64ToBytes, encodeBytesToBase64 } from '../../storage/byte-encoding.ts';
import {
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
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { invalidParamsFault, shapeRestFault } from './operation-helpers.ts';

const storageReadAccess: AccessPolicy = {
  kind: 'scoped',
  scopes: { kind: 'anyOf', scopes: ['storage:read', 'storage:admin'] },
};

const storageWriteAccess: AccessPolicy = {
  kind: 'scoped',
  scopes: { kind: 'anyOf', scopes: ['storage:write', 'storage:admin'] },
};

const storageConditionalBatchAccess: AccessPolicy = {
  kind: 'scopedAlternatives',
  alternatives: [
    { kind: 'anyOf', scopes: ['storage:admin'] },
    { kind: 'allOf', scopes: ['storage:read', 'storage:write'] },
  ],
};

const httpOnlyStorageTransports = {
  http: true,
  jsonRpcHttp: false,
  jsonRpcStdio: false,
  jsonRpcWebSocket: false,
} as const;

const binaryValueSchema = z.instanceof(Uint8Array).meta({ type: 'string', format: 'binary' });

const storageGetInput = z.object({ key: z.string().min(1) });

const storagePutInput = z.object({ key: z.string().min(1), value: binaryValueSchema });

const storageDeleteInput = z.object({ key: z.string().min(1) });

const storageScanInput = z.object({
  prefix: z.string(),
  limit: z.number().int().positive().optional(),
  reverse: z.boolean().optional(),
  gt: z.string().optional(),
  gte: z.string().optional(),
  lt: z.string().optional(),
  lte: z.string().optional(),
});

const storageBatchOperationInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('put'), key: z.string().min(1), value: z.string() }),
  z.object({ type: z.literal('delete'), key: z.string().min(1) }),
]);

const storageConditionInput = z.object({
  key: z.string().min(1),
  expectedValue: z.string().nullable(),
});

const storageBatchInput = z.object({ operations: z.array(storageBatchOperationInput) });

const storageConditionalBatchInput = z.object({
  conditions: z.array(storageConditionInput),
  operations: z.array(storageBatchOperationInput),
});

const emptyOutput = z.null();
const storageGetOutput = binaryValueSchema.nullable();
const storageScanOutput = z.custom<StorageScanOutput>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function',
  'Storage scan output must be an async iterable.',
);
const storageConditionalBatchOutput = z.object({ applied: z.boolean() });

export type StorageGetInput = z.infer<typeof storageGetInput>;
export type StoragePutInput = z.infer<typeof storagePutInput>;
export type StorageDeleteInput = z.infer<typeof storageDeleteInput>;
export type StorageScanInput = z.infer<typeof storageScanInput>;
type StorageScanEntry = { readonly key: string; readonly value: string };
export type StorageScanOutput = AsyncIterable<StorageScanEntry>;
export type StorageBatchInput = z.infer<typeof storageBatchInput>;
export type StorageConditionalBatchInput = z.infer<typeof storageConditionalBatchInput>;
export type StorageConditionalBatchOutput = z.infer<typeof storageConditionalBatchOutput>;

function resolveAuthorizedStorage(
  engine: Engine,
  principal: Principal,
  operation: Parameters<typeof raiseFault>[0],
): Storage {
  if (!isAuthenticated(principal)) {
    raiseFault(operation, {
      code: 'Unauthorized',
      message: 'authentication required',
      data: { reason: 'authentication required' },
    });
  }

  if (principal.hasScope('storage:admin')) {
    return engine.storage;
  }

  raiseFault(operation, {
    code: 'Forbidden',
    message: 'Raw storage access requires storage:admin.',
    data: { reason: 'Raw storage access requires storage:admin.' },
  });
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

async function readJsonRequestBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw invalidParamsFault('Request body must be valid JSON.');
  }
}

function parseBooleanQuery(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw invalidParamsFault('Query parameter "reverse" must be "true" or "false".');
}

function parseLimitQuery(value: string | null): number | undefined {
  if (value === null) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw invalidParamsFault('Query parameter "limit" must be a positive integer.');
  }
  return limit;
}

function extractStorageScanInput(request: Request): StorageScanInput {
  const url = new URL(request.url);
  const input: StorageScanInput = {
    prefix: url.searchParams.get('prefix') ?? '',
  };
  const limit = parseLimitQuery(url.searchParams.get('limit'));
  const reverse = parseBooleanQuery(url.searchParams.get('reverse'));

  if (limit !== undefined) input.limit = limit;
  if (reverse !== undefined) input.reverse = reverse;

  for (const field of ['gt', 'gte', 'lt', 'lte'] as const) {
    const value = url.searchParams.get(field);
    if (value !== null) input[field] = value;
  }

  return input;
}

function storageKeyFromPath(pathParams: Record<string, string>): string {
  return pathParams['key'] ?? '';
}

function createNoContentResponse(): Response {
  return new Response(null, { status: 204 });
}

function createBinaryResponse(value: Uint8Array | null): Response {
  if (value === null) {
    return new Response(null, { status: 404 });
  }
  return new Response(value, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

function createNdjsonResponse(entries: StorageScanOutput): Response {
  const encoder = new TextEncoder();
  const iterator = entries[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const entry = await iterator.next();
          if (entry.done === true) {
            controller.close();
            return;
          }

          controller.enqueue(encoder.encode(`${JSON.stringify(entry.value)}\n`));
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return?.();
      },
    },
    { highWaterMark: 0 },
  );

  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

async function* scanStorage(
  storage: Storage,
  prefix: string,
  options: ScanOptions,
): StorageScanOutput {
  for await (const [key, value] of storage.scan(prefix, options)) {
    yield { key, value: encodeBytesToBase64(value) };
  }
}

export const storageGetOperation = defineOperation<StorageGetInput, Uint8Array | null>({
  name: 'weft.storage.get',
  mcpExposable: false,
  summary: 'Get a raw storage value',
  destructive: false,
  tags: ['Storage'],
  inputSchema: storageGetInput,
  outputSchema: storageGetOutput,
  access: storageReadAccess,
  discoverable: true,
  transports: httpOnlyStorageTransports,
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }) => {
    const storage = resolveAuthorizedStorage(engine as Engine, principal, storageGetOperation);
    return storage.get(input.key);
  },
});

export const storagePutOperation = defineOperation<StoragePutInput, null>({
  name: 'weft.storage.put',
  mcpExposable: false,
  summary: 'Put a raw storage value',
  destructive: true,
  tags: ['Storage'],
  inputSchema: storagePutInput,
  outputSchema: emptyOutput,
  access: storageWriteAccess,
  discoverable: true,
  transports: httpOnlyStorageTransports,
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }) => {
    const storage = resolveAuthorizedStorage(engine as Engine, principal, storagePutOperation);
    await storage.put(input.key, input.value);
    return null;
  },
});

export const storageDeleteOperation = defineOperation<StorageDeleteInput, null>({
  name: 'weft.storage.delete',
  mcpExposable: false,
  summary: 'Delete a raw storage value',
  destructive: true,
  tags: ['Storage'],
  inputSchema: storageDeleteInput,
  outputSchema: emptyOutput,
  access: storageWriteAccess,
  discoverable: true,
  transports: httpOnlyStorageTransports,
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }) => {
    const storage = resolveAuthorizedStorage(engine as Engine, principal, storageDeleteOperation);
    await storage.delete(input.key);
    return null;
  },
});

export const storageScanOperation = defineOperation<StorageScanInput, StorageScanOutput>({
  name: 'weft.storage.scan',
  mcpExposable: false,
  summary: 'Scan raw storage values',
  destructive: false,
  tags: ['Storage'],
  inputSchema: storageScanInput,
  outputSchema: storageScanOutput,
  access: storageReadAccess,
  discoverable: true,
  transports: httpOnlyStorageTransports,
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }) => {
    const storage = resolveAuthorizedStorage(engine as Engine, principal, storageScanOperation);
    return scanStorage(storage, input.prefix, scanOptions(input));
  },
});

export const storageBatchOperation = defineOperation<StorageBatchInput, null>({
  name: 'weft.storage.batch',
  mcpExposable: false,
  summary: 'Apply a raw storage batch',
  destructive: true,
  tags: ['Storage'],
  inputSchema: storageBatchInput,
  outputSchema: emptyOutput,
  access: storageWriteAccess,
  discoverable: true,
  transports: httpOnlyStorageTransports,
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }) => {
    const storage = resolveAuthorizedStorage(engine as Engine, principal, storageBatchOperation);
    await storage.batch(input.operations.map(decodeBatchOperation));
    return null;
  },
});

export const storageConditionalBatchOperation = defineOperation<
  StorageConditionalBatchInput,
  StorageConditionalBatchOutput
>({
  name: 'weft.storage.conditionalbatch',
  mcpExposable: false,
  summary: 'Apply a raw storage conditional batch',
  destructive: true,
  tags: ['Storage'],
  inputSchema: storageConditionalBatchInput,
  outputSchema: storageConditionalBatchOutput,
  access: storageConditionalBatchAccess,
  discoverable: true,
  transports: httpOnlyStorageTransports,
  producibleFaults: ['NotImplemented'], // backend reports no conditionalBatch

  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }) => {
    const storage = resolveAuthorizedStorage(
      engine as Engine,
      principal,
      storageConditionalBatchOperation,
    );
    // Shaped fault instead of leaking the low-level storageConditionalBatch throw.
    if (!storage.capabilities().conditionalBatch) {
      raiseFault(storageConditionalBatchOperation, {
        code: 'NotImplemented',
        message: 'This storage backend reports capabilities().conditionalBatch: false.',
        data: {},
      });
    }
    const applied = await storageConditionalBatch(
      storage,
      input.conditions.map(decodeCondition),
      input.operations.map(decodeBatchOperation),
    );
    return { applied };
  },
});

export const storageGetRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/storage/:key',
  pathParamNames: ['key'],
  operationName: 'weft.storage.get',
  inputSources: {
    key: { kind: 'path', pathParam: 'key' },
  },
  extractInput: async (_request, pathParams) => ({ key: storageKeyFromPath(pathParams) }),
  success: { kind: 'streaming', mediaType: 'application/octet-stream' },
  shapeSuccess: (output: Uint8Array | null) => createBinaryResponse(output),
  shapeFault: shapeRestFault,
};

export const storagePutRestBinding: UnknownRestBinding = {
  method: 'PUT',
  path: '/v1/storage/:key',
  pathParamNames: ['key'],
  operationName: 'weft.storage.put',
  inputSources: {
    key: { kind: 'path', pathParam: 'key' },
    value: { kind: 'body', mediaType: 'application/octet-stream' },
  },
  extractInput: async (request, pathParams) => ({
    key: storageKeyFromPath(pathParams),
    value: new Uint8Array(await request.arrayBuffer()),
  }),
  success: { kind: 'empty', status: 204 },
  shapeSuccess: createNoContentResponse,
  shapeFault: shapeRestFault,
};

export const storageDeleteRestBinding: UnknownRestBinding = {
  method: 'DELETE',
  path: '/v1/storage/:key',
  pathParamNames: ['key'],
  operationName: 'weft.storage.delete',
  inputSources: {
    key: { kind: 'path', pathParam: 'key' },
  },
  extractInput: async (_request, pathParams) => ({ key: storageKeyFromPath(pathParams) }),
  success: { kind: 'empty', status: 204 },
  shapeSuccess: createNoContentResponse,
  shapeFault: shapeRestFault,
};

export const storageScanRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/storage',
  pathParamNames: [],
  operationName: 'weft.storage.scan',
  inputSources: {
    prefix: { kind: 'query', queryParam: 'prefix' },
    limit: { kind: 'query', queryParam: 'limit' },
    reverse: { kind: 'query', queryParam: 'reverse' },
    gt: { kind: 'query', queryParam: 'gt' },
    gte: { kind: 'query', queryParam: 'gte' },
    lt: { kind: 'query', queryParam: 'lt' },
    lte: { kind: 'query', queryParam: 'lte' },
  },
  extractInput: async (request) => extractStorageScanInput(request),
  success: { kind: 'streaming', mediaType: 'application/x-ndjson' },
  shapeSuccess: (output: StorageScanOutput) => createNdjsonResponse(output),
  shapeFault: shapeRestFault,
};

export const storageBatchRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/storage/-/batch',
  pathParamNames: [],
  operationName: 'weft.storage.batch',
  inputSources: {
    operations: { kind: 'body-field', bodyField: 'operations' },
  },
  extractInput: async (request) => readJsonRequestBody(request) as Promise<StorageBatchInput>,
  success: { kind: 'empty', status: 204 },
  shapeSuccess: createNoContentResponse,
  shapeFault: shapeRestFault,
};

export const storageConditionalBatchRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/storage/-/conditional-batch',
  pathParamNames: [],
  operationName: 'weft.storage.conditionalbatch',
  inputSources: {
    conditions: { kind: 'body-field', bodyField: 'conditions' },
    operations: { kind: 'body-field', bodyField: 'operations' },
  },
  extractInput: async (request) =>
    readJsonRequestBody(request) as Promise<StorageConditionalBatchInput>,
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: StorageConditionalBatchOutput) => Response.json(output),
  shapeFault: shapeRestFault,
};
