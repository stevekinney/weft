import type { Storage as WeftStorage } from '../../storage/interface.ts';
import {
  CURRENT_PERSISTED_DATA_SCHEMA_VERSION,
  PERSISTED_DATA_SCHEMA_VERSION_KEY,
  PersistedDataIncompatibleError,
} from '../persisted-data-incompatible-error.ts';

const SCHEMA_VERSION_PATTERN = /^(?:0|[1-9]\d*)$/;
const USER_DATA_PREFIXES = ['wf:', 'op:', 'schedule:', 'ev:', 'sig:', 'upd:', 'idx:'] as const;

/**
 * Read the persisted-data schema-version sentinel and throw
 * {@link PersistedDataIncompatibleError} when it is older (or newer) than the
 * engine's {@link CURRENT_PERSISTED_DATA_SCHEMA_VERSION}.
 *
 * Three cases:
 *
 * 1. Sentinel exists and matches: no-op.
 * 2. Sentinel exists but is missing, unparseable, or disagrees with the
 *    current version: throw `PersistedDataIncompatibleError`.
 * 3. Sentinel is absent. Only stamp the storage when it carries no user
 *    workflow data. Stamping a database that already holds workflow records,
 *    schedules, checkpoints, or any other `wf:` / `op:` / `schedule:` / `ev:`
 *    prefixed key would silently classify pre-versioned data (written by an
 *    older Weft binary or by the `new Engine({ storage })` constructor path
 *    before the sentinel was introduced) as schema-current and risk replaying
 *    incompatible records. When user data is already present without a
 *    sentinel, fail with `PersistedDataIncompatibleError(null, …)` so the
 *    operator can choose explicitly whether to wipe and start fresh.
 */
export async function assertCompatiblePersistedDataVersion(
  storage: WeftStorage,
  options: { allowLegacyData?: boolean } = {},
): Promise<void> {
  const raw = await storage.get(PERSISTED_DATA_SCHEMA_VERSION_KEY);
  if (raw !== null) {
    const text = new TextDecoder().decode(raw);
    if (!SCHEMA_VERSION_PATTERN.test(text)) {
      throw new PersistedDataIncompatibleError(null, CURRENT_PERSISTED_DATA_SCHEMA_VERSION);
    }
    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed)) {
      throw new PersistedDataIncompatibleError(null, CURRENT_PERSISTED_DATA_SCHEMA_VERSION);
    }
    if (parsed !== CURRENT_PERSISTED_DATA_SCHEMA_VERSION) {
      throw new PersistedDataIncompatibleError(parsed, CURRENT_PERSISTED_DATA_SCHEMA_VERSION);
    }
    return;
  }
  // No sentinel. Only stamp when storage is clean of user data unless the
  // caller opted in. Any user-data prefix means the database was written by a
  // pre-sentinel engine; the safe default is to reject so the operator chooses
  // explicitly. `allowLegacyData: true` is the documented opt-in for the
  // `new Engine({ storage })` → `Engine.create({ storage })` migration path.
  if (!options.allowLegacyData) {
    for (const prefix of USER_DATA_PREFIXES) {
      for await (const _entry of storage.scan(prefix, { limit: 1 })) {
        throw new PersistedDataIncompatibleError(null, CURRENT_PERSISTED_DATA_SCHEMA_VERSION);
      }
    }
  }
  await storage.put(
    PERSISTED_DATA_SCHEMA_VERSION_KEY,
    new TextEncoder().encode(String(CURRENT_PERSISTED_DATA_SCHEMA_VERSION)),
  );
}
