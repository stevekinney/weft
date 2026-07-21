import { decodeBase64ToBytes, encodeBytesToBase64, isRecord } from '../storage/byte-encoding.ts';
import {
  assertStorageBatchOperationCount,
  type BatchOperation,
  type ConditionalBatchCondition,
  type ScanOptions,
} from '../storage/interface.ts';
import type { WeftClientStorage } from './client-storage.ts';
import { request, requestResponse } from './http-request.ts';

type WireBatchOperation =
  | { readonly type: 'put'; readonly key: string; readonly value: string }
  | { readonly type: 'delete'; readonly key: string };

const MAX_SCAN_RESPONSE_BYTES = 64 * 1024 * 1024;

function encodeOperation(operation: BatchOperation): WireBatchOperation {
  return operation.type === 'put'
    ? { type: 'put', key: operation.key, value: encodeBytesToBase64(operation.value) }
    : { type: 'delete', key: operation.key };
}

function scanPath(prefix: string, options: ScanOptions): string {
  const parameters = new URLSearchParams({ prefix });
  for (const [name, value] of Object.entries(options)) {
    if (value !== undefined) parameters.set(name, String(value));
  }
  return `/storage?${parameters.toString()}`;
}

function scanEntry(value: unknown): [string, Uint8Array] {
  if (!isRecord(value) || typeof value['key'] !== 'string' || typeof value['value'] !== 'string') {
    throw new Error('HttpClient storage scan response contained an invalid NDJSON entry.');
  }
  return [value['key'], decodeBase64ToBytes(value['value'])];
}

async function releaseScanReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reachedEndOfStream: boolean,
): Promise<void> {
  if (!reachedEndOfStream) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the scan failure or consumer return that triggered cleanup.
    }
  }
  reader.releaseLock();
}

async function* scanResponse(response: Response): AsyncIterable<[string, Uint8Array]> {
  if (response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bufferedText = '';
  let bytesRead = 0;
  let reachedEndOfStream = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEndOfStream = true;
        break;
      }
      bytesRead += value.byteLength;
      if (bytesRead > MAX_SCAN_RESPONSE_BYTES) {
        throw new Error('HttpClient storage scan response exceeded the maximum allowed size.');
      }
      bufferedText += decoder.decode(value, { stream: true });
      const lines = bufferedText.split('\n');
      bufferedText = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length > 0) yield scanEntry(JSON.parse(line));
      }
    }
    bufferedText += decoder.decode();
    if (bufferedText.trim().length > 0) yield scanEntry(JSON.parse(bufferedText));
  } finally {
    await releaseScanReader(reader, reachedEndOfStream);
  }
}

/** Build the raw-storage facade over the six specialized REST bindings. */
export function createHttpClientStorage(
  baseUrl: string,
  headers: Record<string, string>,
): WeftClientStorage {
  return {
    async get(key) {
      const response = await requestResponse(
        baseUrl,
        `/storage/${encodeURIComponent(key)}`,
        headers,
        { method: 'GET' },
      );
      return response === null ? null : new Uint8Array(await response.arrayBuffer());
    },
    async put(key, value) {
      await requestResponse(baseUrl, `/storage/${encodeURIComponent(key)}`, headers, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Blob([value]),
      });
    },
    async delete(key) {
      await requestResponse(baseUrl, `/storage/${encodeURIComponent(key)}`, headers, {
        method: 'DELETE',
      });
    },
    async *scan(prefix, options = {}) {
      const response = await requestResponse(baseUrl, scanPath(prefix, options), headers, {
        method: 'GET',
        headers: { accept: 'application/x-ndjson' },
      });
      if (response !== null) yield* scanResponse(response);
    },
    async batch(operations) {
      assertStorageBatchOperationCount('batch operations', operations.length);
      await request<void>(baseUrl, '/storage/-/batch', headers, {
        method: 'POST',
        body: JSON.stringify({ operations: operations.map(encodeOperation) }),
      });
    },
    async conditionalBatch(conditions, operations) {
      assertStorageBatchOperationCount('conditionalBatch conditions', conditions.length);
      assertStorageBatchOperationCount('conditionalBatch operations', operations.length);
      const result = await request<unknown>(baseUrl, '/storage/-/conditional-batch', headers, {
        method: 'POST',
        body: JSON.stringify({
          conditions: conditions.map((condition: ConditionalBatchCondition) => ({
            key: condition.key,
            expectedValue:
              condition.expectedValue === null
                ? null
                : encodeBytesToBase64(condition.expectedValue),
          })),
          operations: operations.map(encodeOperation),
        }),
      });
      if (!isRecord(result) || typeof result['applied'] !== 'boolean') {
        throw new Error(
          'HttpClient storage conditional batch response must include a boolean "applied" field.',
        );
      }
      return result['applied'];
    },
  };
}
