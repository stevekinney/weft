/**
 * Name collisions between declared entries. A signal, update, or query has two
 * names: its builder key, which types `ctx.waitForSignal('key')` and handlers,
 * and its runtime `name`, which registration re-keys by and the wire uses.
 * Activities have one, because their key is their name. An entry occupies
 * every name it has, so two entries collide when any of their names match,
 * whichever kind of name each one is.
 */

/** A name two entries both occupy, and the key of the entry that came second. */
export interface MessageNameCollision {
  readonly key: string;
  readonly name: string;
}

function occupiedNames(key: string, entry: unknown): string[] {
  const name = (entry as { readonly name?: unknown }).name;
  return typeof name === 'string' && name !== key ? [key, name] : [key];
}

/**
 * The first entry of `added` that occupies a name some entry of `current`
 * occupies, or `undefined`. Collisions inside `added` are not this check's
 * concern: registration reports those for any workflow.
 */
export function findMessageNameCollision(
  current: Readonly<Record<string, unknown>>,
  added: Readonly<Record<string, unknown>>,
): MessageNameCollision | undefined {
  const taken = new Set(
    Object.entries(current).flatMap(([key, entry]) => occupiedNames(key, entry)),
  );
  for (const [key, entry] of Object.entries(added)) {
    const name = occupiedNames(key, entry).find((candidate) => taken.has(candidate));
    if (name !== undefined) return { key, name };
  }
  return undefined;
}

/**
 * The first entry of `map` that occupies a name an earlier entry of `map`
 * occupies, or `undefined` when every name is unique.
 */
export function findMessageNameCollisionWithin(
  map: Readonly<Record<string, unknown>>,
): MessageNameCollision | undefined {
  const taken = new Set<string>();
  for (const [key, entry] of Object.entries(map)) {
    const names = occupiedNames(key, entry);
    const name = names.find((candidate) => taken.has(candidate));
    if (name !== undefined) return { key, name };
    for (const candidate of names) taken.add(candidate);
  }
  return undefined;
}
