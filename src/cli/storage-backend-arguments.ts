/**
 * Shared CLI parsing for the `--storage` backend flag. Centralizes the valid
 * backend set and the persistent-only restriction so the top-level argument
 * parser and the schedule subcommand parser agree on validation.
 *
 * @module cli/storage-backend-arguments
 */

import type { PersistentStorageBackend, StorageBackend } from './types.ts';

const VALID_STORAGE_BACKENDS = new Set(['sqlite', 'lmdb', 'memory']);

function isValidStorageBackend(value: string): value is StorageBackend {
  return VALID_STORAGE_BACKENDS.has(value);
}

/** Validate a `--storage` value, defaulting to `sqlite` when omitted. */
export function parseStorageBackend(value: string | undefined): StorageBackend {
  const storageValue = value ?? 'sqlite';

  if (!isValidStorageBackend(storageValue)) {
    throw new Error(
      `Invalid storage backend '${storageValue}'. Must be one of: sqlite, lmdb, memory`,
    );
  }

  return storageValue;
}

/**
 * Validate a `--storage` value for commands that must persist data across CLI
 * invocations (e.g. schedules). Rejects the in-memory backend.
 */
export function parsePersistentStorageBackend(value: string | undefined): PersistentStorageBackend {
  const storageValue = parseStorageBackend(value);

  if (storageValue === 'memory') {
    throw new Error(
      "Invalid storage backend 'memory'. Schedule commands support only sqlite and lmdb because data must persist across CLI invocations",
    );
  }

  return storageValue;
}
