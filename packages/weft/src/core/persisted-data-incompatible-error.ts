import { WeftError } from './weft-error.ts';

/**
 * Thrown by {@link Engine.create} (and other storage-opening entry points) when
 * a persisted Weft database's schema version does not match what the engine
 * requires — an older version, a newer one, an unparseable sentinel, or user
 * data present with no sentinel at all. Weft loads persisted data only at the
 * exact current schema version; it never reshapes a non-matching database in
 * place. Bumping {@link CURRENT_PERSISTED_DATA_SCHEMA_VERSION} intentionally
 * invalidates databases stamped with any other version so the failure surfaces
 * deterministically at boot, before any workflow attempts replay.
 *
 * Inspect `foundVersion` to see what the storage advertised and `expectedVersion`
 * to see what this engine requires. Resolve by deleting the database or by
 * starting from fresh storage.
 *
 * @example
 * ```ts
 * import { Engine, PersistedDataIncompatibleError } from '@lostgradient/weft';
 *
 * try {
 *   await Engine.create({});
 * } catch (error) {
 *   if (error instanceof PersistedDataIncompatibleError) {
 *     console.error(
 *       `expected schema ${error.expectedVersion}, found ${error.foundVersion ?? 'pre-versioned'}`,
 *     );
 *   }
 * }
 * ```
 */
export class PersistedDataIncompatibleError extends WeftError<'PersistedDataIncompatibleError'> {
  readonly foundVersion: number | null;
  readonly expectedVersion: number;

  constructor(foundVersion: number | null, expectedVersion: number) {
    super(
      'PersistedDataIncompatibleError',
      `Persisted workflow data was written by an older Weft version (schema ${
        foundVersion === null ? 'pre-versioned' : `v${foundVersion}`
      }, current v${expectedVersion}) and is incompatible with the workflow-builder refactor. Delete the database or start fresh.`,
    );
    this.foundVersion = foundVersion;
    this.expectedVersion = expectedVersion;
  }
}

/**
 * A durable record could not be decoded without risking data loss.
 *
 * @example
 * ```ts
 * import { PersistedDataCorruptError } from '@lostgradient/weft';
 * declare const error: unknown;
 * if (error instanceof PersistedDataCorruptError) console.error(error.key);
 * ```
 */
export class PersistedDataCorruptError extends WeftError<'PersistedDataCorruptError'> {
  readonly key: string;

  constructor(key: string) {
    super('PersistedDataCorruptError', `Persisted Weft record is corrupt at key "${key}".`);
    this.key = key;
  }
}

/**
 * Bumped to `1` by the workflow-builder refactor (Phase 3). Pre-MVP databases
 * have no version key recorded — `assertCompatiblePersistedDataVersion` treats
 * the absence of the key on an otherwise non-empty database as
 * `pre-versioned`, which is incompatible. Fresh databases get the current
 * version written on first open.
 */
export const CURRENT_PERSISTED_DATA_SCHEMA_VERSION = 2;

/**
 * Storage key holding the persisted-data schema version (encoded as the UTF-8
 * digits of an integer). Kept under a `weft:` prefix so it cannot collide with
 * the public `wf:` / `op:` / `schedule:` / etc. layouts in
 * `src/storage/interface.ts#KEYS`.
 */
export const PERSISTED_DATA_SCHEMA_VERSION_KEY = 'weft:schema-version';
