/**
 * Authorization scope vocabulary — extracted into its own module to avoid a
 * dependency cycle between `principal.ts` and `authorization.ts`.
 *
 * All authorization-scope-related types and runtime helpers live here. Access
 * policies, scope requirements, and the access-check pipeline live in
 * `authorization.ts`.
 */

/**
 * A scope another package defines and registers with one handler through
 * `additionalScopes`: a dotted namespace, a colon, and an action, such as
 * `bureau.tasks:read`. The `weft` namespace is reserved. At run time each
 * segment must also match {@link PACKAGE_AUTHORIZATION_SCOPE_PATTERN}.
 *
 * @example
 * ```ts
 * import { type PackageAuthorizationScope } from '@lostgradient/backchannel';
 *
 * const scope: PackageAuthorizationScope = 'bureau.tasks:read';
 * console.log(scope);
 * ```
 */
export type PackageAuthorizationScope = `${string}.${string}:${string}`;

/** The scopes one host vocabulary and its registered packages can name. */
export type AuthorizationScope<HostScope extends string = string> =
  HostScope | PackageAuthorizationScope;

/** An immutable list of the scopes a host grants to its trusted local principals. */
export type ScopeVocabulary<HostScope extends string = string> = {
  /** The scopes the host defines directly. */
  readonly scopes: readonly HostScope[];
  /** Returns whether a scope belongs to this host. */
  has(value: string): value is HostScope;
};

/** Build a vocabulary from the host's own scope strings. */
export function createScopeVocabulary<const HostScope extends string>(
  scopes: readonly HostScope[],
): ScopeVocabulary<HostScope> {
  const names = new Set<string>(scopes);
  return Object.freeze({
    scopes: Object.freeze([...scopes]),
    has(value: string): value is HostScope {
      return names.has(value);
    },
  });
}

export const EMPTY_SCOPE_VOCABULARY: ScopeVocabulary = createScopeVocabulary([]);

/**
 * Run-time shape of a {@link PackageAuthorizationScope}: lowercase segments
 * of letters, digits, `_`, and `-`, each starting with a letter; a namespace
 * and at least one more dot-separated segment; then `:` and an action. Whitespace can
 * never appear, so a registered scope always survives space-delimited JWT
 * `scope` claims intact.
 *
 * @example
 * ```ts
 * import { PACKAGE_AUTHORIZATION_SCOPE_PATTERN } from '@lostgradient/backchannel';
 *
 * console.log(PACKAGE_AUTHORIZATION_SCOPE_PATTERN.test('bureau.tasks:read'));
 * ```
 */
export const PACKAGE_AUTHORIZATION_SCOPE_PATTERN =
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+:[a-z][a-z0-9_-]*$/;

/** The namespace no package may register a scope under. */
const RESERVED_NAMESPACE = 'weft';

/** Whether the host defines this scope in its own vocabulary. */
export function isAuthorizationScope<HostScope extends string>(
  value: string,
  vocabulary: ScopeVocabulary<HostScope>,
): value is HostScope {
  return vocabulary.has(value);
}

/**
 * Runtime type guard for the shape of a {@link PackageAuthorizationScope}.
 * It checks the shape only; it does not say whether any handler registered
 * the scope, and it accepts the reserved `weft` namespace.
 *
 * @example
 * ```ts
 * import { isPackageAuthorizationScope } from '@lostgradient/backchannel';
 *
 * console.log(isPackageAuthorizationScope('bureau.tasks:read'));
 * console.log(isPackageAuthorizationScope('inventory:read'));
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
  vocabulary: ScopeVocabulary = EMPTY_SCOPE_VOCABULARY,
): value is AuthorizationScope {
  return vocabulary.has(value) || (additionalScopes as ReadonlySet<string>).has(value);
}

/**
 * Keep only the scopes a handler recognizes, dropping unknown and
 * unregistered entries the same way JWT claim parsing does.
 */
export function filterRecognizedScopes(
  scopes: ReadonlyArray<AuthorizationScope>,
  additionalScopes: AdditionalScopeSet = NO_ADDITIONAL_SCOPES,
  vocabulary: ScopeVocabulary = EMPTY_SCOPE_VOCABULARY,
): AuthorizationScope[] {
  return scopes.filter((scope) => isRecognizedScope(scope, additionalScopes, vocabulary));
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
 * host vocabulary, plus the package scopes the handler
 * registered in `additionalScopes`, is the single source of truth and a
 * misspelled or unregistered scope cannot grant unintended privileges.
 *
 * Credential *validation* (signature verification, expiry, revocation) happens
 * at the transport edge before the claims object reaches this function.
 */
export function extractScopesFromClaims(
  claims: Record<string, unknown>,
  additionalScopes: AdditionalScopeSet = NO_ADDITIONAL_SCOPES,
  vocabulary: ScopeVocabulary = EMPTY_SCOPE_VOCABULARY,
): ReadonlySet<AuthorizationScope> {
  const merged = new Set<AuthorizationScope>();
  addStringClaimScopes(claims['scope'], merged, additionalScopes, vocabulary);
  addStringClaimScopes(claims['scp'], merged, additionalScopes, vocabulary);

  const permissions = claims['permissions'];
  if (Array.isArray(permissions)) {
    for (const entry of permissions) {
      if (typeof entry === 'string' && isRecognizedScope(entry, additionalScopes, vocabulary)) {
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
  vocabulary: ScopeVocabulary,
): void {
  if (typeof value !== 'string') return;
  if (value.trim().length === 0) return;
  for (const token of value.split(/\s+/)) {
    if (token.length === 0) continue;
    if (isRecognizedScope(token, additionalScopes, vocabulary)) {
      target.add(token);
    }
  }
}
