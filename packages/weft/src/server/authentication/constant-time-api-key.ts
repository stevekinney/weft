import { createHash, timingSafeEqual } from 'node:crypto';

export type ConstantTimeApiKeyEntry<T> = {
  readonly digest: Uint8Array;
  readonly value: T;
};

export type ConstantTimeApiKeyMatcher<T> = {
  readonly entries: ReadonlyArray<ConstantTimeApiKeyEntry<T>>;
  matches(presentedKey: string): boolean;
};

function digestApiKey(key: string): Uint8Array {
  return createHash('sha256').update(key, 'utf8').digest();
}

export function createConstantTimeApiKeyEntry<T>(
  key: string,
  value: T,
): ConstantTimeApiKeyEntry<T> {
  return { digest: digestApiKey(key), value };
}

export function createConstantTimeApiKeyMatcher(
  keys: ReadonlyArray<string>,
): ConstantTimeApiKeyMatcher<undefined>;
export function createConstantTimeApiKeyMatcher<T>(
  keys: ReadonlyArray<{ readonly key: string; readonly value: T }>,
): ConstantTimeApiKeyMatcher<T>;
export function createConstantTimeApiKeyMatcher<T>(
  keys: ReadonlyArray<string | { readonly key: string; readonly value: T }>,
): ConstantTimeApiKeyMatcher<T | undefined> {
  const entries = keys.map((entry) =>
    typeof entry === 'string'
      ? createConstantTimeApiKeyEntry(entry, undefined)
      : createConstantTimeApiKeyEntry(entry.key, entry.value),
  );

  return {
    entries,
    matches(presentedKey) {
      return findConstantTimeApiKeyMatch(presentedKey, entries) !== null;
    },
  };
}

export function findConstantTimeApiKeyMatch<T>(
  presentedKey: string,
  entries: ReadonlyArray<ConstantTimeApiKeyEntry<T>>,
): ConstantTimeApiKeyEntry<T> | null {
  const presentedDigest = digestApiKey(presentedKey);
  let matchedIndex = -1;

  // Hashing both sides first gives timingSafeEqual equal-length inputs for every
  // comparison. Always scan every stored digest; never return on the first match.
  for (let index = 0; index < entries.length; index += 1) {
    if (timingSafeEqual(presentedDigest, entries[index]!.digest)) {
      matchedIndex = index;
    }
  }

  return matchedIndex === -1 ? null : entries[matchedIndex]!;
}
