/**
 * Shared test-only utilities for the trace fixture generator
 * (`scripts/regenerate-trace-fixtures.ts`) and the replay verifier
 * (`tests/replay-fixtures/replay-fixtures.test.ts`). Both produce or compare the
 * same deterministic storage snapshots, so this module is the single source of
 * truth for sorting a `MemoryStorage` snapshot, encoding it as a base64 record,
 * and pinning the runtime (UUIDs + `Date.now()`) while a scenario runs.
 *
 * This module is consumed via deep import and intentionally not re-exported
 * from `src/testing/index.ts` — it is test infrastructure, not part of the
 * package surface. The `.test-support.ts` suffix is excluded by
 * `tsconfig.build.json` so this file never ships in `dist/`.
 *
 * Deliberately NOT here: binary snapshot serialization (`serializeSnapshot`)
 * lives only in the generator since only it writes `.bin` files, and the two
 * `waitForCheckpoint` helpers stay in their respective callers because they are
 * intentionally different (the generator polls with `Bun.sleep` under real
 * timers; the test uses `waitForCondition` under fake timers). Neither is a
 * clone group, so pulling them in would be over-extraction.
 *
 * Concurrency: `withDeterministicRuntime` mutates the global `crypto.randomUUID`
 * and `Date.now` for the duration of `operation` and restores them in a
 * `finally` block. It is NOT safe for overlapping or concurrent invocations;
 * all current callers invoke it sequentially.
 */

import type { WorkflowEvent, WorkflowState, WorkflowTimelineEntry } from '../core/types.ts';
import type { MemoryStorage } from '../storage/memory.ts';

type RandomUuid = ReturnType<Crypto['randomUUID']>;

/**
 * The shape of a replay trace fixture JSON file. This is the single source of
 * truth for the fixture contract, shared by the generator
 * (`scripts/regenerate-trace-fixtures.ts`) and the verifier
 * (`tests/replay-fixtures/replay-fixtures.test.ts`).
 *
 * Note: `replayMetadata.version` is the fixture-metadata schema version and is
 * deliberately distinct from the engine's `CURRENT_CHECKPOINT_SCHEMA_VERSION`.
 * Extending this type never changes persisted checkpoint or event bytes.
 */
export type TraceFixture = {
  scenario: string;
  description: string;
  events: WorkflowEvent[];
  timeline: WorkflowTimelineEntry[];
  finalState: WorkflowState;
  storage: Record<string, string>;
  /**
   * Replay metadata for scenarios that produce more than one terminal
   * workflow. Optional and additive: absent means single-workflow replay (run
   * the scenario, compare `finalState`). Present means the verifier also
   * asserts each additional terminal workflow's persisted state via
   * `engine.get(state.id)`.
   */
  replayMetadata?: {
    version: 1;
    /**
     * Terminal workflow states produced beyond `finalState` (for example, the
     * forked child). Each is compared by id via `engine.get(state.id)`, so the
     * comparison is order-independent: the array order is not asserted. Must be
     * non-empty when `replayMetadata` is present.
     */
    additionalTerminalStates: WorkflowState[];
  };
};

/** A sorted snapshot of MemoryStorage as [key, bytes] pairs (deterministic key order). */
export function sortedStorageEntries(storage: MemoryStorage): Array<readonly [string, Uint8Array]> {
  return [...storage.snapshot().entries()].toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

/** Encodes sorted storage entries to a { key: base64 } record for JSON fixtures. */
export function storageAsBase64Record(
  entries: readonly (readonly [string, Uint8Array])[],
): Record<string, string> {
  const storage: Record<string, string> = {};

  for (const [key, value] of entries) {
    storage[key] = Buffer.from(value).toString('base64');
  }

  return storage;
}

function formatDeterministicRandomUuid(counter: number): RandomUuid {
  const suffix = counter.toString(16).padStart(12, '0').slice(-12);

  // The constructed value is a valid UUID-shaped string; TypeScript models
  // crypto.randomUUID() with a template-literal return type.
  return `00000000-0000-4000-8000-${suffix}` as RandomUuid;
}

/**
 * Runs `operation` with crypto.randomUUID() and Date.now() replaced by
 * deterministic stand-ins, restoring the originals in a finally block.
 */
export async function withDeterministicRuntime<T>(operation: () => Promise<T>): Promise<T> {
  const originalRandomUuid = globalThis.crypto.randomUUID.bind(globalThis.crypto);
  const originalDateNow = Date.now.bind(Date);
  let counter = 0;

  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    configurable: true,
    value: () => {
      counter += 1;
      return formatDeterministicRandomUuid(counter);
    },
  });
  Object.defineProperty(Date, 'now', {
    configurable: true,
    value: () => 0,
  });

  try {
    return await operation();
  } finally {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: originalRandomUuid,
    });
    Object.defineProperty(Date, 'now', {
      configurable: true,
      value: originalDateNow,
    });
  }
}
