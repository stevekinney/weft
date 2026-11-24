import { createScopeVocabulary } from "./embedded/backchannel/src/index.ts";

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

/** The vocabulary used by Weft's built-in operations and local callers. */
export const WEFT_SCOPE_VOCABULARY = createScopeVocabulary(AUTHORIZATION_SCOPES);
