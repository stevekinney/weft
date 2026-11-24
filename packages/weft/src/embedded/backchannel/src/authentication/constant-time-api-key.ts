export type ConstantTimeApiKeyEntry<T> = {
  readonly digest: Uint8Array;
  readonly value: T;
};

export type ConstantTimeApiKeyMatcher<T> = {
  readonly entries: ReadonlyArray<ConstantTimeApiKeyEntry<T>>;
  matches(presentedKey: string): Promise<boolean>;
};

const encoder = new TextEncoder();

/** SHA-256 of the key's UTF-8 bytes, which is 32 bytes whatever the key's length. */
export async function digestApiKey(key: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(key)));
}

export async function createConstantTimeApiKeyEntry<T>(
  key: string,
  value: T,
): Promise<ConstantTimeApiKeyEntry<T>> {
  return { digest: await digestApiKey(key), value };
}

export async function createConstantTimeApiKeyMatcher(
  keys: ReadonlyArray<string>,
): Promise<ConstantTimeApiKeyMatcher<undefined>>;
export async function createConstantTimeApiKeyMatcher<T>(
  keys: ReadonlyArray<{ readonly key: string; readonly value: T }>,
): Promise<ConstantTimeApiKeyMatcher<T>>;
export async function createConstantTimeApiKeyMatcher<T>(
  keys: ReadonlyArray<string | { readonly key: string; readonly value: T }>,
): Promise<ConstantTimeApiKeyMatcher<T | undefined>> {
  const entries = await Promise.all(
    keys.map((entry) =>
      typeof entry === 'string'
        ? createConstantTimeApiKeyEntry(entry, undefined)
        : createConstantTimeApiKeyEntry(entry.key, entry.value),
    ),
  );

  return {
    entries,
    async matches(presentedKey) {
      return (await findConstantTimeApiKeyMatch(presentedKey, entries)) !== null;
    },
  };
}

/**
 * Compare a presented digest with every entry. Each entry's digest is read byte
 * by byte, in full, whichever entry matches, so the number of reads never
 * reveals which entry (if any) matched. A byte difference is folded into an
 * accumulator rather than ending the scan; the last matching entry wins.
 */
export function findConstantTimeDigestMatch<T>(
  presentedDigest: Uint8Array,
  entries: ReadonlyArray<ConstantTimeApiKeyEntry<T>>,
): ConstantTimeApiKeyEntry<T> | null {
  let matchedIndex = -1;

  for (let index = 0; index < entries.length; index += 1) {
    const storedDigest = entries[index]!.digest;
    let difference = presentedDigest.length ^ storedDigest.length;
    for (let byte = 0; byte < presentedDigest.length; byte += 1) {
      difference |= presentedDigest[byte]! ^ (storedDigest[byte] ?? 0);
    }
    if (difference === 0) matchedIndex = index;
  }

  return matchedIndex === -1 ? null : entries[matchedIndex]!;
}

export async function findConstantTimeApiKeyMatch<T>(
  presentedKey: string,
  entries: ReadonlyArray<ConstantTimeApiKeyEntry<T>>,
): Promise<ConstantTimeApiKeyEntry<T> | null> {
  // Hashing both sides first gives the comparison equal-length inputs for every
  // entry. Always scan every stored digest; never return on the first match.
  return findConstantTimeDigestMatch(await digestApiKey(presentedKey), entries);
}
