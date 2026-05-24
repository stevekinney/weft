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

import type { MemoryStorage } from '../storage/memory.ts';

type RandomUuid = ReturnType<Crypto['randomUUID']>;

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
