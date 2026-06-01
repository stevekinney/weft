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
 * Lookups are constant-time map reads; the comparison is the map key itself,
 * not a per-byte string compare, so no early-exit timing channel is introduced
 * beyond what the JS engine's map hashing already does.
 *
 * @module server/authentication/rotating-api-key-store
 */

import type { AuthorizationScope } from '../authorization-scope.ts';
import { principalFromApiKey, type AuthenticatedPrincipal } from '../principal.ts';

/**
 * Registration options for a single key in a {@link RotatingApiKeyStore}.
 *
 * @example
 * ```ts
 * import { type ApiKeyRegistration } from '@lostgradient/weft/server';
 *
 * const registration: ApiKeyRegistration = {
 *   subject: 'service-account-7',
 *   scopes: ['workflows:read', 'workflows:write'],
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
 * import { createRotatingApiKeyStore, type RotatingApiKeyStore } from '@lostgradient/weft/server';
 *
 * const store: RotatingApiKeyStore = createRotatingApiKeyStore();
 * store.add('key-old', { subject: 'svc', scopes: ['workflows:read'] });
 * store.add('key-new', { subject: 'svc', scopes: ['workflows:read'] });
 * // Both authenticate during the overlap window.
 * store.revoke('key-old');
 * ```
 */
export type RotatingApiKeyStore = {
  /** Register or replace a key. Replacing an existing key updates its registration in place. */
  add(key: string, registration: ApiKeyRegistration): void;
  /** Remove a key immediately. Returns `true` if the key was present. */
  revoke(key: string): boolean;
  /** Whether `key` is currently registered and not expired (evaluated against `now()`). */
  has(key: string): boolean;
  /** Number of currently-registered keys (including not-yet-expired ones). */
  readonly size: number;
  /**
   * Resolve a presented key to a principal, or `null` when the key is unknown,
   * revoked, or expired. Shaped to drop directly into
   * `AuthConfig.resolveApiKeyPrincipal`.
   */
  resolve(presentedKey: string): Promise<AuthenticatedPrincipal | null>;
};

type StoredKey = {
  subject: string;
  scopes: ReadonlyArray<AuthorizationScope>;
  expiresAt: number | undefined;
};

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
 * import { createRotatingApiKeyStore } from '@lostgradient/weft/server';
 * import { serve } from '@lostgradient/weft/server';
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 *
 * const store = createRotatingApiKeyStore();
 * store.add('initial-key', { subject: 'svc', scopes: ['workflows:read'] });
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
  const keys = new Map<string, StoredKey>();

  // `resolve` closes over `keys` directly (not `this`), so it stays correct
  // when detached and passed as `AuthConfig.resolveApiKeyPrincipal`.
  const store: RotatingApiKeyStore = {
    add(key, registration) {
      if (key.length === 0) {
        throw new Error('Cannot register an empty API key');
      }
      keys.set(key, {
        subject: registration.subject,
        scopes: registration.scopes ?? [],
        expiresAt: registration.expiresAt,
      });
    },
    revoke(key) {
      return keys.delete(key);
    },
    has(key) {
      const stored = keys.get(key);
      if (stored === undefined) return false;
      if (isExpired(stored, now())) {
        // Lazily drop expired entries so the map does not accumulate them.
        keys.delete(key);
        return false;
      }
      return true;
    },
    get size() {
      return keys.size;
    },
    resolve(presentedKey) {
      const stored = keys.get(presentedKey);
      if (stored === undefined || isExpired(stored, now())) {
        if (stored !== undefined) keys.delete(presentedKey);
        return Promise.resolve(null);
      }
      return Promise.resolve(
        principalFromApiKey({ subject: stored.subject, scopes: stored.scopes }),
      );
    },
  };

  return store;
}
