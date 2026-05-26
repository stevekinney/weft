import type { AuthorizationScope } from '../authorization-scope.ts';
import { principalFromApiKey, type AuthenticatedPrincipal } from '../principal.ts';
import type { AuthConfig, AuthResult, JWTPayload } from './types.ts';

/**
 * Method-mismatch guard. A resolver can return a principal with any
 * `method` string; admitting under `method: 'api-key'` while the
 * principal declares `method: 'jwt'` creates contradictory auth state.
 * Returns `true` when the principal passes (method === 'api-key');
 * logs + returns `false` otherwise. Separated from `deepFreezeApiKeyPrincipal`
 * so each function has one responsibility — guard or copy/freeze.
 */
function validateApiKeyPrincipalMethod(principal: AuthenticatedPrincipal): boolean {
  if (principal.method !== 'api-key') {
    console.warn(
      `resolveApiKeyPrincipal returned principal with method "${principal.method}"; expected "api-key". Rejecting.`,
    );
    return false;
  }
  return true;
}

/**
 * Throws when a guarded scope set sees a mutation attempt. Named at
 * module scope so the function is allocated once, not per-set.
 */
function rejectScopeSetMutation(name: string): () => never {
  return () => {
    throw new TypeError(`Cannot mutate scope set on admitted principal (attempted ${name})`);
  };
}

function immutableScopeSet(
  source: ReadonlySet<AuthorizationScope>,
): ReadonlySet<AuthorizationScope> {
  const inner = new Set<AuthorizationScope>(source);
  const guarded = {
    has: (scope: AuthorizationScope) => inner.has(scope),
    get size() {
      return inner.size;
    },
    forEach: (
      callback: (
        value: AuthorizationScope,
        value2: AuthorizationScope,
        set: ReadonlySet<AuthorizationScope>,
      ) => void,
      thisArg?: unknown,
    ) =>
      inner.forEach((v, v2) =>
        callback.call(thisArg, v, v2, guarded as unknown as ReadonlySet<AuthorizationScope>),
      ),
    keys: () => inner.keys(),
    values: () => inner.values(),
    entries: () => inner.entries(),
    [Symbol.iterator]: () => inner[Symbol.iterator](),
    // Mutation surface — exposed only so downstream leaks hit a loud
    // error rather than silently succeeding against an unfrozen Set.
    add: rejectScopeSetMutation('add'),
    delete: rejectScopeSetMutation('delete'),
    clear: rejectScopeSetMutation('clear'),
  };
  return Object.freeze(guarded) as unknown as ReadonlySet<AuthorizationScope>;
}

function cloneClaims(claims: JWTPayload | undefined): JWTPayload | undefined {
  if (claims === undefined) return undefined;
  return deepFreeze(structuredClone(claims));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    const child = (value as Record<string, unknown>)[key];
    if (typeof child === 'object' && child !== null && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

function deepFreezeApiKeyPrincipal(principal: AuthenticatedPrincipal): AuthenticatedPrincipal {
  const guardedScopes = immutableScopeSet(principal.scopes);
  const frozen: AuthenticatedPrincipal = {
    method: 'api-key',
    scopes: guardedScopes,
    claims: cloneClaims(principal.claims),
    subject: principal.subject,
    hasScope(scope) {
      return guardedScopes.has(scope);
    },
  };
  return Object.freeze(frozen);
}

export async function tryAdmitApiKey(
  presentedKey: string,
  resolver: AuthConfig['resolveApiKeyPrincipal'],
  apiKeySet: Set<string> | null,
  defaultApiKeyScopes: ReadonlyArray<AuthorizationScope>,
): Promise<AuthResult | 'continue'> {
  if (resolver !== undefined) {
    let resolved: AuthenticatedPrincipal | null;
    try {
      resolved = await resolver(presentedKey);
    } catch (error) {
      // Resolver throw: log server-side, reject client. Never leak the
      // thrown error's message to the wire — it may contain DB queries,
      // secrets, or other sensitive context.
      console.warn('resolveApiKeyPrincipal threw:', error instanceof Error ? error.message : error);
      resolved = null;
    }
    if (resolved !== null && validateApiKeyPrincipalMethod(resolved)) {
      const admitted = deepFreezeApiKeyPrincipal(resolved);
      return { authenticated: true, method: 'api-key', principal: admitted };
    }
    return { authenticated: false, error: 'No valid credentials provided' };
  }
  if (apiKeySet?.has(presentedKey)) {
    const principal = principalFromApiKey({
      subject: 'api-key-caller',
      scopes: defaultApiKeyScopes,
    });
    const admitted = deepFreezeApiKeyPrincipal(principal);
    return { authenticated: true, method: 'api-key', principal: admitted };
  }
  return 'continue';
}
