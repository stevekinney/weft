import {
  WEFT_RESERVED_KEY_PREFIXES,
  storageConditionalBatch,
  storageHas,
  type BatchOperation,
  type ConditionalBatchCondition,
  type Storage,
} from './interface.ts';

/**
 * A string-valued key/value row from an existing application store.
 *
 * The importer treats both fields as application data: `key` becomes the
 * unencoded suffix under the optional target prefix, and `value` is encoded
 * as UTF-8 bytes before writing to Weft storage.
 *
 * @example
 * ```ts
 * import { type TextKeyValueRow } from '@lostgradient/weft/storage';
 *
 * const row: TextKeyValueRow = {
 *   key: 'session:1',
 *   value: '{"status":"open"}',
 * };
 * console.log(row.key); // 'session:1'
 * ```
 */
export type TextKeyValueRow = {
  key: string;
  value: string;
};

/**
 * Options for {@link copyTextKeyValueRowsToStorage}.
 *
 * @example
 * ```ts
 * import { MemoryStorage, type CopyTextKeyValueRowsToStorageOptions } from '@lostgradient/weft/storage';
 *
 * await using storage = new MemoryStorage();
 * const options: CopyTextKeyValueRowsToStorageOptions = {
 *   storage,
 *   targetPrefix: 'app:my-service',
 *   rows: [{ key: 'session:1', value: 'active' }],
 * };
 * console.log(options.targetPrefix); // 'app:my-service'
 * ```
 */
export type CopyTextKeyValueRowsToStorageOptions = {
  /** Destination Weft storage that receives UTF-8 encoded values. */
  storage: Storage;
  /** Source rows from a string-valued key/value store. */
  rows: Iterable<TextKeyValueRow> | AsyncIterable<TextKeyValueRow>;
  /**
   * Optional application namespace applied before each source key. A value like
   * `app:my-service` writes source key `session:1` to
   * `app:my-service:session:1`.
   */
  targetPrefix?: string;
};

/**
 * Result returned by {@link copyTextKeyValueRowsToStorage}.
 *
 * @example
 * ```ts
 * import { type CopyTextKeyValueRowsToStorageResult } from '@lostgradient/weft/storage';
 *
 * const result: CopyTextKeyValueRowsToStorageResult = { copied: 3 };
 * console.log(result.copied); // 3
 * ```
 */
export type CopyTextKeyValueRowsToStorageResult = {
  /** Number of rows copied into the target storage. */
  copied: number;
};

const textEncoder = new TextEncoder();

function normalizeTargetPrefix(prefix: string | undefined): string {
  return prefix?.replaceAll(/:+$/g, '') ?? '';
}

function toTargetKey(prefix: string, key: string): string {
  if (prefix.length === 0) {
    return key;
  }

  return key.length === 0 ? `${prefix}:` : `${prefix}:${key}`;
}

async function collectRows(
  rows: Iterable<TextKeyValueRow> | AsyncIterable<TextKeyValueRow>,
  targetPrefix: string,
): Promise<Array<TextKeyValueRow & { targetKey: string }>> {
  const collected: Array<TextKeyValueRow & { targetKey: string }> = [];
  const seenTargetKeys = new Set<string>();

  for await (const row of rows) {
    if (typeof row.key !== 'string') {
      throw new TypeError('Text key-value import rows must have string keys.');
    }

    if (typeof row.value !== 'string') {
      throw new TypeError('Text key-value import rows must have string values.');
    }

    const targetKey = toTargetKey(targetPrefix, row.key);
    if (WEFT_RESERVED_KEY_PREFIXES.some((prefix) => targetKey.startsWith(prefix))) {
      throw new Error(
        `Text key-value import target key "${targetKey}" uses a Weft-reserved key prefix.`,
      );
    }

    if (seenTargetKeys.has(targetKey)) {
      throw new Error(`Text key-value import source produced duplicate target key "${targetKey}".`);
    }

    seenTargetKeys.add(targetKey);
    collected.push({ ...row, targetKey });
  }

  return collected;
}

/**
 * Copy string-valued key/value rows into a Weft byte-oriented storage backend.
 *
 * This helper is for one-time imports from application stores that already hold
 * text values. It encodes values as UTF-8 bytes, optionally prefixes target
 * keys, and refuses to overwrite existing target keys.
 *
 * @example
 * ```ts
 * import { MemoryStorage, copyTextKeyValueRowsToStorage } from '@lostgradient/weft/storage';
 *
 * await using storage = new MemoryStorage();
 * const result = await copyTextKeyValueRowsToStorage({
 *   storage,
 *   targetPrefix: 'app:my-service',
 *   rows: [{ key: 'session:1', value: 'active' }],
 * });
 * console.log(result.copied); // 1
 * ```
 */
export async function copyTextKeyValueRowsToStorage(
  options: CopyTextKeyValueRowsToStorageOptions,
): Promise<CopyTextKeyValueRowsToStorageResult> {
  const targetPrefix = normalizeTargetPrefix(options.targetPrefix);
  const rows = await collectRows(options.rows, targetPrefix);

  if (rows.length === 0) {
    return { copied: 0 };
  }

  for (const row of rows) {
    if (await storageHas(options.storage, row.targetKey)) {
      throw new Error(`Target storage already contains key "${row.targetKey}".`);
    }
  }

  const conditions: ConditionalBatchCondition[] = rows.map((row) => ({
    key: row.targetKey,
    expectedValue: null,
  }));
  const operations: BatchOperation[] = rows.map((row) => ({
    type: 'put',
    key: row.targetKey,
    value: textEncoder.encode(row.value),
  }));

  const committed = await storageConditionalBatch(options.storage, conditions, operations);
  if (!committed) {
    throw new Error('Target storage changed before import could commit.');
  }

  return { copied: rows.length };
}
