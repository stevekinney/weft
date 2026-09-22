import { copyBytesToArrayBuffer } from '../../core/byte-arrays.ts';
import type { RestInputContext } from '../rest-binding.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { readRestBodyBounded, readRestJsonBody } from '../rest-body.ts';
import { invalidParamsFault, isOperationFault } from './operation-helpers.ts';
import type {
  StorageConditionalBatchOutput,
  StorageScanInput,
  StorageScanOutput,
} from './storage-schemas.ts';

async function readJsonRequestBody(request: Request, context: RestInputContext): Promise<unknown> {
  try {
    return await readRestJsonBody(request, context);
  } catch (error) {
    if (isOperationFault(error)) throw error;
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
  return new Response(copyBytesToArrayBuffer(value), {
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
  extractInput: async (request, pathParams, context) => ({
    key: storageKeyFromPath(pathParams),
    value: await readRestBodyBounded(request, context),
  }),
  success: { kind: 'empty', status: 204 },
  shapeSuccess: createNoContentResponse,
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
};

export const storageBatchRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/storage/-/batch',
  pathParamNames: [],
  operationName: 'weft.storage.batch',
  inputSources: {
    operations: { kind: 'body-field', bodyField: 'operations' },
  },
  extractInput: async (request, _pathParams, context) => readJsonRequestBody(request, context),
  success: { kind: 'empty', status: 204 },
  shapeSuccess: createNoContentResponse,
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
  extractInput: async (request, _pathParams, context) => readJsonRequestBody(request, context),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: StorageConditionalBatchOutput) => Response.json(output),
};
