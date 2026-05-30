/**
 * Storage-backend argument parsing shared by the CLI subcommand parsers.
 *
 * Splitting these helpers out of `parse-arguments.ts` keeps both that module
 * and `schedule-arguments.ts` under the file-length limit while giving both a
 * single source of truth for backend validation (no import cycle, since this
 * module imports neither parser).
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
 * Validate a `--storage` value for commands whose data must persist across CLI
 * invocations (schedules). Rejects the in-memory backend.
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
