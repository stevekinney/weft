import { decodeBase64ToBytes, encodeBytesToBase64, isRecord } from './byte-encoding.ts';
import { normalizeDeleteRangeOptions, type DeleteRangeOptions } from './delete-range.ts';
import {
  storageCountCore,
  storageDeletePrefixCore,
  storageDeleteRangeCore,
  storageHasCore,
  storageKeysCore,
} from './derived-operations.ts';
import {
  type BatchOperation,
  type ConditionalBatchCondition,
  type ScanOptions,
  type Storage,
  type StorageCapabilities,
} from './interface.ts';
import { scopedStorage } from './scoped-storage.ts';

/**
 * Options for connecting {@link HTTPStorage} to a remote Weft storage API.
 *
 * @example
 * ```ts
 * import { HTTPStorage, type HTTPStorageOptions } from '@lostgradient/weft/storage/http';
 *
 * const token = 'example-token';
 * const options: HTTPStorageOptions = {
 *   baseUrl: 'https://weft.example.com',
 *   headers: { authorization: `Bearer ${token}` },
 * };
 * const storage = new HTTPStorage(options);
 * void storage;
 * ```
 */
export type HTTPStorageOptions = {
  baseUrl: string | URL;
  headers?: Record<string, string>;
  /**
   * Whether the remote server's storage backend supports compare-and-swap.
   * The client cannot detect this — it depends on the server's backend — so the
   * honest default is `false`: a feature gated on `conditionalBatch` fails fast
   * locally instead of issuing a request the server answers with `501`. Set
   * `true` only when you have verified the remote backend implements it.
   *
   * @default false
   */
  remoteConditionalBatch?: boolean;
};

type HTTPBatchOperation =
  | { readonly type: 'put'; readonly key: string; readonly value: string }
  | { readonly type: 'delete'; readonly key: string };

type HTTPBatchCondition = {
  readonly key: string;
  readonly expectedValue: string | null;
};

type HTTPScanEntry = {
  readonly key: string;
  readonly value: string;
};

const MAX_SCAN_RESPONSE_BYTES = 64 * 1024 * 1024;

function encodeOperation(operation: BatchOperation): HTTPBatchOperation {
  if (operation.type === 'put') {
    return {
      type: 'put',
      key: operation.key,
      value: encodeBytesToBase64(operation.value),
    };
  }
  return { type: 'delete', key: operation.key };
}

function encodeCondition(condition: ConditionalBatchCondition): HTTPBatchCondition {
  return {
    key: condition.key,
    expectedValue:
      condition.expectedValue === null ? null : encodeBytesToBase64(condition.expectedValue),
  };
}

function parseScanEntry(value: unknown): HTTPScanEntry {
  if (!isRecord(value) || typeof value['key'] !== 'string' || typeof value['value'] !== 'string') {
    throw new Error('HTTPStorage scan response contained an invalid NDJSON entry.');
  }
  return { key: value['key'], value: value['value'] };
}

function parseConditionalBatchResponse(value: unknown): boolean {
  if (!isRecord(value) || typeof value['applied'] !== 'boolean') {
    throw new Error(
      'HTTPStorage conditional batch response must include a boolean "applied" field.',
    );
  }
  return value['applied'];
}

function appendOptionalSearchParameter(
  url: URL,
  name: string,
  value: boolean | number | string | undefined,
): void {
  if (value !== undefined) {
    url.searchParams.set(name, String(value));
  }
}

function parseScanLine(line: string): [string, Uint8Array] | null {
  if (line.trim().length === 0) return null;
  const entry = parseScanEntry(JSON.parse(line));
  return [entry.key, decodeBase64ToBytes(entry.value)];
}

function assertScanResponseSize(bytesRead: number): void {
  if (bytesRead > MAX_SCAN_RESPONSE_BYTES) {
    throw new Error('HTTPStorage scan response exceeded the maximum allowed size.');
  }
}

async function* readNdjsonLines(response: Response): AsyncIterable<string> {
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
      assertScanResponseSize(bytesRead);

      bufferedText += decoder.decode(value, { stream: true });
      const lines = bufferedText.split('\n');
      bufferedText = lines.pop() ?? '';

      for (const line of lines) {
        yield line;
      }
    }

    bufferedText += decoder.decode();
    if (bufferedText.length > 0) {
      yield bufferedText;
    }
  } finally {
    try {
      if (!reachedEndOfStream) {
        await reader.cancel();
      }
    } catch {
      // Ignore cancellation errors while unwinding a terminated scan.
    }
    reader.releaseLock();
  }
}

/**
 * Remote {@link Storage} adapter backed by Weft's storage REST endpoints.
 *
 * Single-value reads and writes use `application/octet-stream`; scans stream
 * newline-delimited JSON entries with base64-encoded values.
 *
 * @example
 * ```ts
 * import { HTTPStorage } from '@lostgradient/weft/storage/http';
 *
 * const token = 'example-token';
 * await using storage = new HTTPStorage({
 *   baseUrl: 'https://weft.example.com',
 *   headers: { authorization: `Bearer ${token}` },
 * });
 * ```
 */
export class HTTPStorage implements Storage {
  readonly #baseUrl: URL;
  readonly #headers: Record<string, string>;
  readonly #remoteConditionalBatch: boolean;

  constructor(options: HTTPStorageOptions) {
    this.#baseUrl = options.baseUrl instanceof URL ? options.baseUrl : new URL(options.baseUrl);
    this.#headers = { ...options.headers };
    this.#remoteConditionalBatch = options.remoteConditionalBatch ?? false;
  }

  capabilities(): StorageCapabilities {
    // Remote KV over HTTP. The client offers no session affinity, token
    // pinning, or documented read-your-writes guarantee, and scans stream
    // NDJSON pages that can interleave with concurrent writes — so the honest
    // floor is `eventual` / `best-effort`, independent of any stronger
    // reference-server behavior. conditionalBatch support depends on the remote
    // server's backend, which the client cannot detect; default to `false` so a
    // gated feature fails fast locally instead of via a remote 501. Operators
    // who verified remote CAS opt in via `remoteConditionalBatch: true`.
    // deletePrefix and deleteRange use the derived scan-and-delete fallback, so
    // boundedRangeDelete is false.
    return {
      readAfterWrite: 'eventual',
      scanConsistency: 'best-effort',
      atomicBatch: true,
      conditionalBatch: this.#remoteConditionalBatch,
      boundedRangeDelete: false,
    };
  }

  #url(path: string): URL {
    const base = this.#baseUrl.href.endsWith('/') ? this.#baseUrl.href : `${this.#baseUrl.href}/`;
    return new URL(path.replace(/^\/+/, ''), base);
  }

  #storageKeyUrl(key: string): URL {
    return this.#url(`/v1/storage/${encodeURIComponent(key)}`);
  }

  #scanUrl(prefix: string, options: ScanOptions): URL {
    const url = this.#url('/v1/storage');
    url.searchParams.set('prefix', prefix);
    appendOptionalSearchParameter(url, 'limit', options.limit);
    appendOptionalSearchParameter(url, 'reverse', options.reverse);
    appendOptionalSearchParameter(url, 'gt', options.gt);
    appendOptionalSearchParameter(url, 'gte', options.gte);
    appendOptionalSearchParameter(url, 'lt', options.lt);
    appendOptionalSearchParameter(url, 'lte', options.lte);
    return url;
  }

  async #request(
    url: URL,
    init: RequestInit = {},
    allowedStatuses: readonly number[] = [],
  ): Promise<Response> {
    const headers = new Headers(this.#headers);
    for (const [key, value] of new Headers(init.headers).entries()) {
      headers.set(key, value);
    }

    const response = await fetch(url, { ...init, headers });
    if (!response.ok && !allowedStatuses.includes(response.status)) {
      throw new Error(
        `HTTPStorage request failed: ${init.method ?? 'GET'} ${url.pathname} returned ${String(
          response.status,
        )}.`,
      );
    }
    return response;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const response = await this.#request(this.#storageKeyUrl(key), { method: 'GET' }, [404]);
    if (response.status === 404) {
      return null;
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    await this.#request(this.#storageKeyUrl(key), {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Blob([value]),
    });
  }

  async delete(key: string): Promise<void> {
    await this.#request(this.#storageKeyUrl(key), { method: 'DELETE' });
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    const response = await this.#request(this.#scanUrl(prefix, options), {
      method: 'GET',
      headers: { accept: 'application/x-ndjson' },
    });

    for await (const line of readNdjsonLines(response)) {
      const entry = parseScanLine(line);
      if (entry !== null) yield entry;
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    await this.#request(this.#url('/v1/storage/-/batch'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operations: operations.map(encodeOperation) }),
    });
  }

  async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    const response = await this.#request(this.#url('/v1/storage/-/conditional-batch'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conditions: conditions.map(encodeCondition),
        operations: operations.map(encodeOperation),
      }),
    });
    return parseConditionalBatchResponse(await response.json());
  }

  has(key: string): Promise<boolean> {
    return storageHasCore(this, key);
  }

  async *keys(prefix: string, options?: ScanOptions): AsyncIterable<string> {
    yield* storageKeysCore(this, prefix, options);
  }

  count(prefix: string): Promise<number> {
    return storageCountCore(this, prefix);
  }

  deletePrefix(prefix: string): Promise<number> {
    return storageDeletePrefixCore(this, prefix);
  }

  deleteRange(prefix: string, options: DeleteRangeOptions): Promise<number> {
    return storageDeleteRangeCore(this, prefix, normalizeDeleteRangeOptions(options));
  }

  scoped(prefix: string): Storage {
    return scopedStorage(this, prefix);
  }

  [Symbol.dispose](): void {}
}
