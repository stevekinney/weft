/**
 * Authorization scope vocabulary — extracted into its own module to avoid a
 * dependency cycle between `principal.ts` and `authorization.ts`.
 *
 * All authorization-scope-related types and runtime helpers live here. Access
 * policies, scope requirements, and the access-check pipeline live in
 * `authorization.ts`.
 */

/**
 * All authorization scopes recognized by the runtime. Full-word, colon-separated,
 * one entry per (domain, action) pair. Add new scopes here when introducing a
 * new domain; never derive scope strings dynamically.
 *
 * Scope semantics are deliberately FLAT for v1 — `workflows:admin` does NOT
 * imply `workflows:read` or `workflows:write`. Operation authors must declare
 * the exact scope they require. Scope-implication semantics (if any) are a
 * future track.
 *
 * Public export so dashboards and API-key provisioning tooling can consume
 * the canonical vocabulary instead of hand-copying it.
 *
 * @example
 * ```ts
 * import { AUTHORIZATION_SCOPES } from '@lostgradient/weft';
 *
 * console.log(AUTHORIZATION_SCOPES.includes('workflows:read'));
 * ```
 */
export const AUTHORIZATION_SCOPES = [
  'workflows:read',
  'workflows:write',
  'workflows:admin',
  'schedules:read',
  'schedules:write',
  'signals:write',
  'updates:write',
  'queries:read',
  'reviews:read',
  'reviews:write',
  'attributes:read',
  'attributes:write',
  'tags:write',
  'streams:read',
  'events:read',
  'storage:read',
  'storage:write',
  'storage:admin',
  'workers:write',
  'system:read',
  'system:admin',
] as const;

/**
 * String-literal union of every scope Weft itself defines.
 *
 * @example
 * ```ts
 * import { type BuiltInAuthorizationScope } from '@lostgradient/weft';
 *
 * const scope: BuiltInAuthorizationScope = 'workflows:read';
 * console.log(scope);
 * ```
 */
export type BuiltInAuthorizationScope = (typeof AUTHORIZATION_SCOPES)[number];

/**
 * A scope another package defines and registers with one handler through
 * `additionalScopes`: a dotted namespace, a colon, and an action, such as
 * `bureau.tasks:read`. The `weft` namespace is reserved. At run time each
 * segment must also match {@link PACKAGE_AUTHORIZATION_SCOPE_PATTERN}.
 *
 * @example
 * ```ts
 * import { type PackageAuthorizationScope } from '@lostgradient/weft';
 *
 * const scope: PackageAuthorizationScope = 'bureau.tasks:read';
 * console.log(scope);
 * ```
 */
export type PackageAuthorizationScope = `${string}.${string}:${string}`;

/**
 * Every authorization scope an access policy or principal can name: Weft's
 * built-in vocabulary plus package-registered scopes. A package scope is only
 * ever granted by a handler that registered it.
 *
 * @example
 * ```ts
 * import { type AuthorizationScope } from '@lostgradient/weft';
 *
 * const builtIn: AuthorizationScope = 'workflows:read';
 * const registered: AuthorizationScope = 'bureau.tasks:read';
 * console.log(builtIn, registered);
 * ```
 */
export type AuthorizationScope = BuiltInAuthorizationScope | PackageAuthorizationScope;

/**
 * Run-time shape of a {@link PackageAuthorizationScope}: lowercase segments
 * of letters, digits, `_`, and `-`, each starting with a letter; a namespace
 * and at least one more dot-separated segment; then `:` and an action. Whitespace can
 * never appear, so a registered scope always survives space-delimited JWT
 * `scope` claims intact.
 *
 * @example
 * ```ts
 * import { PACKAGE_AUTHORIZATION_SCOPE_PATTERN } from '@lostgradient/weft';
 *
 * console.log(PACKAGE_AUTHORIZATION_SCOPE_PATTERN.test('bureau.tasks:read'));
 * ```
 */
export const PACKAGE_AUTHORIZATION_SCOPE_PATTERN =
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+:[a-z][a-z0-9_-]*$/;

/** The namespace no package may register a scope under. */
const RESERVED_NAMESPACE = 'weft';

const SCOPE_LOOKUP = new Set<string>(AUTHORIZATION_SCOPES);

/**
 * Runtime type guard for Weft's built-in scope vocabulary. A package scope is
 * not built in, so it returns `false` for `bureau.tasks:read`; whether a
 * package scope is granted depends on the handler that registered it.
 *
 * @example
 * ```ts
 * import { isAuthorizationScope } from '@lostgradient/weft';
 *
 * console.log(isAuthorizationScope('workflows:read'));
 * console.log(isAuthorizationScope('not-a-scope'));
 * ```
 */
export function isAuthorizationScope(value: string): value is BuiltInAuthorizationScope {
  return SCOPE_LOOKUP.has(value);
}

/**
 * Runtime type guard for the shape of a {@link PackageAuthorizationScope}.
 * It checks the shape only; it does not say whether any handler registered
 * the scope, and it accepts the reserved `weft` namespace.
 *
 * @example
 * ```ts
 * import { isPackageAuthorizationScope } from '@lostgradient/weft';
 *
 * console.log(isPackageAuthorizationScope('bureau.tasks:read'));
 * console.log(isPackageAuthorizationScope('workflows:read'));
 * ```
 */
export function isPackageAuthorizationScope(value: string): value is PackageAuthorizationScope {
  return PACKAGE_AUTHORIZATION_SCOPE_PATTERN.test(value);
}

/**
 * The scopes one handler recognizes beyond the built-in vocabulary. Built by
 * {@link createAdditionalScopeSet}; never shared between handlers.
 */
export type AdditionalScopeSet = ReadonlySet<PackageAuthorizationScope>;

const NO_ADDITIONAL_SCOPES: AdditionalScopeSet = new Set();

/**
 * Validate a handler's `additionalScopes` option and return the set that
 * handler recognizes. Throws when an entry does not match
 * {@link PACKAGE_AUTHORIZATION_SCOPE_PATTERN} or names the reserved `weft`
 * namespace, so a misregistration fails when the handler is constructed.
 */
export function createAdditionalScopeSet(
  additionalScopes: readonly PackageAuthorizationScope[] | undefined,
): AdditionalScopeSet {
  if (additionalScopes === undefined || additionalScopes.length === 0) return NO_ADDITIONAL_SCOPES;
  const registered = new Set<PackageAuthorizationScope>();
  for (const scope of additionalScopes as readonly unknown[]) {
    if (typeof scope !== 'string' || !isPackageAuthorizationScope(scope)) {
      throw new TypeError(
        `additionalScopes entry ${JSON.stringify(scope)} must look like ` +
          '"<namespace>.<resource>:<action>", for example "bureau.tasks:read"',
      );
    }
    if (scope.slice(0, scope.indexOf('.')) === RESERVED_NAMESPACE) {
      throw new TypeError(
        `additionalScopes entry "${scope}" uses the reserved "${RESERVED_NAMESPACE}" namespace`,
      );
    }
    registered.add(scope);
  }
  return registered;
}

/**
 * Whether a handler recognizes `value`: a built-in scope, or a package scope
 * that handler registered.
 */
export function isRecognizedScope(
  value: string,
  additionalScopes: AdditionalScopeSet = NO_ADDITIONAL_SCOPES,
): value is AuthorizationScope {
  return SCOPE_LOOKUP.has(value) || (additionalScopes as ReadonlySet<string>).has(value);
}

/**
 * Keep only the scopes a handler recognizes, dropping unknown and
 * unregistered entries the same way JWT claim parsing does.
 */
export function filterRecognizedScopes(
  scopes: ReadonlyArray<AuthorizationScope>,
  additionalScopes: AdditionalScopeSet = NO_ADDITIONAL_SCOPES,
): AuthorizationScope[] {
  return scopes.filter((scope) => isRecognizedScope(scope, additionalScopes));
}

/**
 * Extract the full set of scopes granted by a JWT payload by *merging* every
 * recognized claim source. Real-world tokens commonly carry OIDC scopes (e.g.
 * `openid profile`) in `scope` while application scopes live in `permissions`;
 * a short-circuit on the first present claim would silently drop privileges.
 *
 * Sources merged (all consulted, all unioned):
 *   - `scope` — RFC 8693-style space-delimited string
 *   - `scp` — alternate space-delimited string used by some IdPs
 *   - `permissions` — array of strings
 *
 * Whitespace-only values are treated as absent so they never block fallback to
 * other sources. Unknown scope strings are silently filtered out — the
 * vocabulary in `AUTHORIZATION_SCOPES`, plus the package scopes the handler
 * registered in `additionalScopes`, is the single source of truth and a
 * misspelled or unregistered scope cannot grant unintended privileges.
 *
 * Credential *validation* (signature verification, expiry, revocation) happens
 * at the transport edge before the claims object reaches this function.
 */
export function extractScopesFromClaims(
  claims: Record<string, unknown>,
  additionalScopes: AdditionalScopeSet = NO_ADDITIONAL_SCOPES,
): ReadonlySet<AuthorizationScope> {
  const merged = new Set<AuthorizationScope>();
  addStringClaimScopes(claims['scope'], merged, additionalScopes);
  addStringClaimScopes(claims['scp'], merged, additionalScopes);

  const permissions = claims['permissions'];
  if (Array.isArray(permissions)) {
    for (const entry of permissions) {
      if (typeof entry === 'string' && isRecognizedScope(entry, additionalScopes)) {
        merged.add(entry);
      }
    }
  }

  return merged;
}

/**
 * Add every recognized scope token from a space-delimited claim string into
 * `target`. No-op for non-strings, empty strings, and whitespace-only strings.
 */
function addStringClaimScopes(
  value: unknown,
  target: Set<AuthorizationScope>,
  additionalScopes: AdditionalScopeSet,
): void {
  if (typeof value !== 'string') return;
  if (value.trim().length === 0) return;
  for (const token of value.split(/\s+/)) {
    if (token.length === 0) continue;
    if (isRecognizedScope(token, additionalScopes)) {
      target.add(token);
    }
  }
}
