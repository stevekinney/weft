/**
 * Rotatable API-key store with overlapping-validity windows.
 *
 * Static `apiKeys` are fixed for the lifetime of a `serve()` call — rotating
 * them means a config change and a restart, which forces downtime or a
 * flag-day cutover. This store closes that gap: it is a mutable, in-process key
 * registry that the authenticator consults on every request through the
 * existing `resolveApiKeyPrincipal` hook, so an operator can introduce a new
 * key, let it run alongside the old one, and revoke the old key — all without
 * restarting the server.
 *
 * Overlapping validity is the core rotation primitive: add the replacement key
 * (clients begin presenting it), keep the outgoing key valid until traffic has
 * migrated, then revoke the outgoing key. During the overlap window both keys
 * authenticate. Each key may also carry an absolute `expiresAt`, after which it
 * is rejected automatically without an explicit revoke.
 *
 * Registration hashes stored keys to fixed-length digests once. Authentication
 * lookups hash the presented key, then compare it with every stored digest
 * without early exit. The digest step avoids raw length checks, and scanning
 * every digest avoids key-position leaks during the overlap window.
 *
 * Hashing is asynchronous, so every method returns a promise. The store runs
 * its calls one at a time, in call order, so a call behaves as if the calls
 * before it had finished: a key revoked after an `add` is never admitted, and
 * `size` counts only the calls that have completed.
 *
 * @module server/authentication/rotating-api-key-store
 */

import type { AuthorizationScope } from '../authorization-scope.ts';
import { principalFromApiKey, type AuthenticatedPrincipal } from '../principal.ts';
import {
  createConstantTimeApiKeyEntry,
  findConstantTimeApiKeyMatch,
  type ConstantTimeApiKeyEntry,
} from './constant-time-api-key.ts';

/**
 * Registration options for a single key in a {@link RotatingApiKeyStore}.
 *
 * @example
 * ```ts
 * import { type ApiKeyRegistration } from '@lostgradient/backchannel';
 *
 * const registration: ApiKeyRegistration = {
 *   subject: 'service-account-7',
 *   scopes: ['inventory:read', 'inventory:write'],
 *   expiresAt: Date.now() + 86_400_000,
 * };
 * void registration;
 * ```
 */
export type ApiKeyRegistration = {
  /** Principal subject minted for callers presenting this key. */
  subject: string;
  /** Authorization scopes granted to this key's principal. Defaults to `[]`. */
  scopes?: ReadonlyArray<AuthorizationScope>;
  /**
   * Absolute expiry timestamp (epoch ms). After this instant the key is
   * rejected automatically. Omit for a key with no scheduled expiry.
   */
  expiresAt?: number;
};

/**
 * A mutable, rotatable API-key registry. Wire it into authentication by passing
 * its {@link RotatingApiKeyStore.resolve} method as `resolveApiKeyPrincipal`.
 * Mutate the live set with {@link RotatingApiKeyStore.add} and
 * {@link RotatingApiKeyStore.revoke} to rotate keys without restarting.
 *
 * @example
 * ```ts
 * import { createRotatingApiKeyStore, type RotatingApiKeyStore } from '@lostgradient/backchannel';
 *
 * const store: RotatingApiKeyStore = createRotatingApiKeyStore();
 * await store.add('key-old', { subject: 'svc', scopes: ['inventory:read'] });
 * await store.add('key-new', { subject: 'svc', scopes: ['inventory:read'] });
 * // Both authenticate during the overlap window.
 * await store.revoke('key-old');
 * ```
 */
export interface ApiKeyStore {
  /**
   * Register or replace a key. Replacing an existing key updates its
   * registration in place. Rejects an empty key by throwing synchronously,
   * before it returns a promise. The promise settles once the key is
   * registered.
   */
  add(key: string, registration: ApiKeyRegistration): Promise<void>;
  /** Remove a key. Resolves to `true` if the key was present. */
  revoke(key: string): Promise<boolean>;
  /** Whether `key` is currently registered and not expired (evaluated against `now()`). */
  has(key: string): Promise<boolean>;
  /** Number of registered keys after pending changes settle. */
  count(): Promise<number>;
  /**
   * Resolve a presented key to a principal, or `null` when the key is unknown,
   * revoked, or expired. Shaped to drop directly into
   * `AuthConfig.resolveApiKeyPrincipal`.
   */
  resolve(presentedKey: string): Promise<AuthenticatedPrincipal | null>;
}

/** In-memory {@link ApiKeyStore} with synchronous inspection of committed registrations. */
export type RotatingApiKeyStore = ApiKeyStore & {
  /**
   * Number of currently-registered keys (including not-yet-expired ones),
   * counting only the calls that have completed.
   */
  readonly size: number;
};

type StoredKey = {
  subject: string;
  scopes: ReadonlyArray<AuthorizationScope>;
  expiresAt: number | undefined;
};

type StoredKeyMatch = {
  key: string;
  stored: StoredKey;
};

type StoredKeyEntry = ConstantTimeApiKeyEntry<StoredKeyMatch>;

/** Whether a stored key has passed its absolute expiry as of `currentTime`. */
function isExpired(stored: StoredKey, currentTime: number): boolean {
  return stored.expiresAt !== undefined && currentTime >= stored.expiresAt;
}

/**
 * Create an empty {@link RotatingApiKeyStore}. The optional `now` clock is for
 * deterministic testing of expiry; production callers omit it and the store
 * reads `Date.now()`.
 *
 * @example
 * ```ts
 * import { createRotatingApiKeyStore } from '@lostgradient/backchannel';
 * import { serve } from '@lostgradient/weft';
 * import { Engine } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/storage';
 *
 * const store = createRotatingApiKeyStore();
 * await store.add('initial-key', { subject: 'svc', scopes: ['inventory:read'] });
 *
 * await using engine = new Engine({ storage: new MemoryStorage() });
 * await using server = serve({
 *   engine,
 *   auth: { resolveApiKeyPrincipal: store.resolve },
 * });
 * void server;
 * ```
 */
export function createRotatingApiKeyStore(now: () => number = Date.now): RotatingApiKeyStore {
  const keys = new Map<string, StoredKeyEntry>();
  // Every call joins this chain, so each one runs to completion before the next
  // begins, in call order. A call that fails settles its own promise and leaves
  // the chain usable.
  let tail: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const result = tail.then(task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function findStoredKey(presentedKey: string): Promise<StoredKeyMatch | null> {
    const match = await findConstantTimeApiKeyMatch(presentedKey, [...keys.values()]);
    return match?.value ?? null;
  }

  // The methods close over `keys` and `tail` directly (not `this`), so they stay
  // correct when detached and passed as `AuthConfig.resolveApiKeyPrincipal`.
  const store: RotatingApiKeyStore = {
    add(key, registration) {
      if (key.length === 0) {
        throw new Error('Cannot register an empty API key');
      }
      // Snapshot the caller's registration now: the call runs later.
      const stored = {
        subject: registration.subject,
        scopes: [...(registration.scopes ?? [])],
        expiresAt: registration.expiresAt,
      };
      return enqueue(async () => {
        keys.set(key, await createConstantTimeApiKeyEntry(key, { key, stored }));
      });
    },
    revoke(key) {
      return enqueue(() => keys.delete(key));
    },
    has(key) {
      return enqueue(async () => {
        const match = await findStoredKey(key);
        if (match === null) return false;
        if (isExpired(match.stored, now())) {
          // Lazily drop expired entries so the map does not accumulate them.
          keys.delete(match.key);
          return false;
        }
        return true;
      });
    },
    count() {
      return enqueue(() => keys.size);
    },
    get size() {
      return keys.size;
    },
    resolve(presentedKey) {
      return enqueue(async () => {
        const match = await findStoredKey(presentedKey);
        if (match === null || isExpired(match.stored, now())) {
          if (match !== null) keys.delete(match.key);
          return null;
        }
        return principalFromApiKey({ subject: match.stored.subject, scopes: match.stored.scopes });
      });
    },
  };

  return store;
}
