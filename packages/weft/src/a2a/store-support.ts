/**
 * Shared plumbing for the A2A task and push-configuration stores: caller scoping and
 * storage keys, the versioned record envelope, list paging (page sizes and opaque
 * page tokens), and the compare-and-swap retry loop.
 *
 * Every key lives under the reserved `a2a:` prefix and names, in order, the record
 * kind, the store's namespace, the caller's tenant, and the caller's owner, each
 * percent-encoded so no caller-supplied value can reach into another scope.
 *
 * @module a2a/store-support
 */

import type { ServerCallContext } from '@a2a-js/sdk/server';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  decodeBase64ToBytes,
  encodeBytesToBase64,
  encodeStorageKeyComponent,
  isRecord,
  storageConditionalBatch,
  type BatchOperation,
  type ConditionalBatchCondition,
  type Storage,
} from "../embedded/storage/src/index.ts";
import {
  A2AStoreConflictError,
  A2AStorePageSizeError,
  A2AStorePageTokenError,
  A2AStoreRecordVersionError,
} from './store-errors.ts';

/** The only `recordVersion` this release writes and reads. */
export const A2A_RECORD_VERSION = 1;

/** The `pageSize` a list uses when the request names none. */
export const DEFAULT_A2A_PAGE_SIZE = 50;

const MAX_PAGE_SIZE = 100;

/** A write that loses its compare-and-swap is retried this many times before it fails. */
export const MAX_A2A_STORE_RETRIES = 5;

/** The scope every A2A record is keyed by. */
export type A2ACallerScope = {
  readonly namespace: string;
  /** `ServerCallContext.tenant`, empty when absent. */
  readonly tenant: string;
  /** `user:<userName>` for an authenticated caller, `anonymous` otherwise. */
  readonly owner: string;
};

export function callerScope(namespace: string, context: ServerCallContext): A2ACallerScope {
  const user = context.user;
  return {
    namespace,
    tenant: context.tenant ?? '',
    owner: user?.isAuthenticated === true ? `user:${user.userName}` : 'anonymous',
  };
}

/**
 * `task-event` records are a workflow agent's durable per-task event log, and a
 * `workflow-task` record names the caller scope that owns the task a workflow serves.
 */
export type A2ARecordKind = 'task' | 'push' | 'push-head' | 'task-event' | 'workflow-task';

/** The prefix of every `kind` record of `namespace`, across all tenants and owners. */
export function namespaceKeyPrefix(kind: A2ARecordKind, namespace: string): string {
  return `a2a:${kind}:${encodeStorageKeyComponent(namespace)}:`;
}

/** The key of one record, scoped to the caller, named by `parts` in order. */
export function scopedKey(
  kind: A2ARecordKind,
  scope: A2ACallerScope,
  ...parts: readonly string[]
): string {
  return [
    namespaceKeyPrefix(kind, scope.namespace) + encodeStorageKeyComponent(scope.tenant),
    encodeStorageKeyComponent(scope.owner),
    ...parts.map(encodeStorageKeyComponent),
  ].join(':');
}

/**
 * The key of the `to` record that shares a `from` key's scope and parts (the
 * push-configuration head of a task, for instance). Every part of a key is
 * percent-encoded, so swapping the kind segment cannot move the key into another
 * scope.
 */
export function siblingKey(key: string, from: A2ARecordKind, to: A2ARecordKind): string {
  return `a2a:${to}:${key.slice(`a2a:${from}:`.length)}`;
}

/**
 * The key of the record naming the caller scope that owns the task with this
 * identifier. A workflow agent's task identifier is its workflow identifier, which is
 * unique across scopes, so this record is keyed by the namespace alone.
 */
export function workflowTaskKey(namespace: string, taskId: string): string {
  return namespaceKeyPrefix('workflow-task', namespace) + encodeStorageKeyComponent(taskId);
}

/** The prefix of every durable event of the task whose record has `taskKey`. */
export function taskEventPrefix(taskKey: string): string {
  return `${siblingKey(taskKey, 'task', 'task-event')}:`;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Serialize a record with the current `recordVersion`. */
export function encodeRecord(record: Readonly<Record<string, unknown>>): Uint8Array {
  return textEncoder.encode(JSON.stringify({ recordVersion: A2A_RECORD_VERSION, ...record }));
}

/**
 * Parse a stored record, failing with {@link A2AStoreRecordVersionError} unless it
 * carries `recordVersion: 1`.
 */
export function decodeRecord(key: string, bytes: Uint8Array): Record<string, unknown> {
  const parsed: unknown = JSON.parse(textDecoder.decode(bytes));
  const recordVersion = isRecord(parsed) ? parsed['recordVersion'] : undefined;
  if (recordVersion !== A2A_RECORD_VERSION) {
    throw new A2AStoreRecordVersionError(key, recordVersion);
  }
  return parsed as Record<string, unknown>;
}

/** Every record under `prefix`, decoded, with the bytes each was read as. */
export async function scanRecords(
  storage: Storage,
  prefix: string,
): Promise<Array<{ key: string; bytes: Uint8Array; record: Record<string, unknown> }>> {
  const records: Array<{ key: string; bytes: Uint8Array; record: Record<string, unknown> }> = [];
  for await (const [key, bytes] of storage.scan(prefix)) {
    records.push({ key, bytes, record: decodeRecord(key, bytes) });
  }
  return records;
}

/**
 * Resolve a list's page size: `undefined` means the default of 50, and anything else
 * must be an integer from 1 to 100.
 */
export function resolvePageSize(pageSize: number | undefined): number {
  if (pageSize === undefined) return DEFAULT_A2A_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new A2AStorePageSizeError(pageSize);
  }
  return pageSize;
}

/** A position in a list's order: the primary sort key and the identifier tie-breaker. */
export type A2APageCursor = { readonly sortKey: number | null; readonly id: string };

/**
 * A digest naming the caller and the list a page token belongs to, so a token minted
 * for one caller, filter set, or task is rejected for any other.
 */
export function pageTokenBinding(parts: readonly unknown[]): string {
  return encodeBytesToBase64(sha256(textEncoder.encode(JSON.stringify(parts))));
}

function toBase64Url(text: string): string {
  return encodeBytesToBase64(textEncoder.encode(text))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function fromBase64Url(token: string): string {
  return textDecoder.decode(decodeBase64ToBytes(token.replaceAll('-', '+').replaceAll('_', '/')));
}

/** Mint the opaque token that continues a list after `cursor`. */
export function encodePageToken(cursor: A2APageCursor, binding: string): string {
  return toBase64Url(JSON.stringify({ s: cursor.sortKey, i: cursor.id, b: binding }));
}

function parsePageToken(token: string): unknown {
  try {
    return JSON.parse(fromBase64Url(token)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Read a page token back, failing with {@link A2AStorePageTokenError} when it is
 * malformed or was minted for a different `binding`.
 */
export function decodePageToken(token: string, binding: string): A2APageCursor {
  const parsed = parsePageToken(token);
  if (
    !isRecord(parsed) ||
    parsed['b'] !== binding ||
    typeof parsed['i'] !== 'string' ||
    (parsed['s'] !== null && typeof parsed['s'] !== 'number')
  ) {
    throw new A2AStorePageTokenError();
  }
  return { sortKey: parsed['s'], id: parsed['i'] };
}

/**
 * One page of `entries` (already in list order, compared by `compare`), continuing
 * after the token's cursor when there is one.
 */
export function paginate<TEntry extends A2APageCursor>(
  entries: readonly TEntry[],
  options: {
    readonly pageSize: number;
    readonly pageToken: string;
    readonly binding: string;
    readonly compare: (left: A2APageCursor, right: A2APageCursor) => number;
  },
): { page: TEntry[]; nextPageToken: string } {
  const cursor =
    options.pageToken === '' ? undefined : decodePageToken(options.pageToken, options.binding);
  const remaining =
    cursor === undefined ? entries : entries.filter((entry) => options.compare(entry, cursor) > 0);
  const page = remaining.slice(0, options.pageSize);
  const last = page.at(-1);
  const nextPageToken =
    last !== undefined && remaining.length > page.length
      ? encodePageToken({ sortKey: last.sortKey, id: last.id }, options.binding)
      : '';
  return { page, nextPageToken };
}

/** Order two identifiers by code unit, the way storage keys sort. */
export function compareIdentifiers(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** What one compare-and-swap attempt decided. */
export type A2ACompareAndSwapAttempt<TResult> =
  | {
      readonly conditions: ConditionalBatchCondition[];
      readonly operations: BatchOperation[];
      readonly result: TResult;
    }
  | { readonly result: TResult };

/**
 * Run `attempt` until its conditional batch commits, retrying up to
 * {@link MAX_A2A_STORE_RETRIES} times after a lost compare-and-swap and then failing
 * with {@link A2AStoreConflictError}. An attempt that returns no batch needs no write
 * and settles at once.
 */
export async function withCompareAndSwap<TResult>(
  storage: Storage,
  key: string,
  attempt: () => Promise<A2ACompareAndSwapAttempt<TResult>>,
): Promise<TResult> {
  for (let attempts = 1; attempts <= MAX_A2A_STORE_RETRIES + 1; attempts += 1) {
    const decision = await attempt();
    if (!('operations' in decision)) return decision.result;
    if (await storageConditionalBatch(storage, decision.conditions, decision.operations)) {
      return decision.result;
    }
  }
  throw new A2AStoreConflictError(key, MAX_A2A_STORE_RETRIES + 1);
}
