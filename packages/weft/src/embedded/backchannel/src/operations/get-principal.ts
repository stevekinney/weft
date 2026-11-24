/**
 * `weft.system.principal` operation + REST binding.
 *
 * Reports the caller's own resolved principal: the authentication method,
 * the normalized subject, the granted scope set, and any host-resolved workspace identity. Public access by
 * design — introspection has to work for every credential state to be
 * useful (a dashboard probes its principal before it knows anything), and
 * an unauthenticated caller learns only what it already knows: that it is
 * anonymous with no scopes. The response is strictly principal-shaped —
 * nothing about the server's auth configuration (key inventory,
 * `unauthenticatedAccess` posture, JWT issuers) is exposed.
 */

import { z } from 'zod';

import {
  type ScopeVocabulary,
  PACKAGE_AUTHORIZATION_SCOPE_PATTERN,
} from '../authorization-scope.ts';
import { shapeOperationFaultAsJson } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-binding.ts';

const principalMethodSchema = z.enum([
  'jwt',
  'api-key',
  'mtls',
  'stdio-local',
  'unauthenticated-local',
  'unauthenticated',
]);
const getPrincipalInput = z.object({});
const packageScopeSchema = z.string().regex(PACKAGE_AUTHORIZATION_SCOPE_PATTERN);
const getPrincipalOutput = (vocabulary: ScopeVocabulary) =>
  z.object({
    workspace: z
      .object({
        version: z.literal(1),
        workspaceId: z.string(),
        actorId: z.string(),
        actorKind: z.enum(['user', 'service', 'local']),
        owner: z.string(),
        membershipRevision: z.string(),
        capabilities: z.array(z.enum(['workspace:use', 'workspace:manage', 'deployment:operate'])),
      })
      .optional(),
    method: principalMethodSchema,
    subject: z.string().nullable(),
    // Built-in scopes, or a package scope a handler registered through
    // `additionalScopes`. The schema is shared by every handler, so it accepts
    // any well-formed package scope; the authenticator is what limits a
    // principal to the scopes its own handler registered.
    scopes: z.array(
      vocabulary.scopes.length === 0
        ? packageScopeSchema
        : z.union([z.enum(vocabulary.scopes), packageScopeSchema]),
    ),
  });

export type GetPrincipalInput = z.infer<typeof getPrincipalInput>;

/**
 * Output of `weft.system.principal`: the caller's authentication method,
 * normalized subject (`null` when the credential carries none), and granted
 * scopes, sorted. Anonymous callers receive `method: 'unauthenticated'`
 * with an empty scope list.
 *
 * @example
 * ```ts
 * import { type GetPrincipalOutput } from '@lostgradient/backchannel';
 *
 * const anonymous: GetPrincipalOutput = {
 *   method: 'unauthenticated',
 *   subject: null,
 *   scopes: [],
 * };
 * console.log(anonymous.method);
 * ```
 */
export type GetPrincipalOutput = z.infer<ReturnType<typeof getPrincipalOutput>>;

/** The operation that reports the caller's resolved principal and granted scopes; public, so an unauthenticated caller gets the `unauthenticated` method rather than an error. */
export function createGetPrincipalOperation(vocabulary: ScopeVocabulary) {
  return defineOperation({
    name: 'weft.system.principal',
    mcpExposable: false,
    summary: "Report the caller's resolved principal and granted scopes",
    description:
      "Report the caller's own resolved principal: the authentication method ('jwt', 'api-key', " +
      "'mtls', 'stdio-local', 'unauthenticated-local', or 'unauthenticated'), the normalized subject " +
      'when one exists, and ' +
      'the granted authorization scopes, sorted. Public access: an unauthenticated caller ' +
      "receives method 'unauthenticated' with an empty scope list rather than an error, so " +
      'clients can distinguish "no credential" from "credential with few scopes" without probing ' +
      "other operations. A server with no authentication reports 'unauthenticated-local' holding " +
      'every scope. A workspace-aware host also reports its resolved workspace identity, stable actor, ' +
      'opaque owner, membership revision and capabilities. Never exposes server auth configuration.',
    destructive: false,
    tags: ['System'],
    inputSchema: getPrincipalInput,
    outputSchema: getPrincipalOutput(vocabulary),
    access: { kind: 'public' },
    discoverable: true,
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ principal }): Promise<GetPrincipalOutput> => {
      if (principal.method === 'unauthenticated') {
        return { method: 'unauthenticated', subject: null, scopes: [] };
      }
      return {
        method: principal.method,
        ...(principal.workspace === undefined
          ? {}
          : {
              workspace: {
                ...principal.workspace,
                capabilities: [...principal.workspace.capabilities],
              },
            }),
        subject: principal.subject ?? null,
        // Sorted for a deterministic wire shape — `scopes` is a Set whose
        // iteration order is credential-construction order, which callers
        // must not come to depend on.
        scopes: [...principal.scopes].toSorted(),
      };
    },
  });
}

/** The REST binding of {@link createGetPrincipalOperation}. */
export const getPrincipalRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/principal',
  pathParamNames: [],
  operationName: 'weft.system.principal',
  inputSources: {},
  extractInput: async () => ({}),
  success: { kind: 'json', status: 200 },
  shapeFault: shapeOperationFaultAsJson,
};
