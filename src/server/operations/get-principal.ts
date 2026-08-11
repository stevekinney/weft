/**
 * `weft.system.principal` operation + REST binding.
 *
 * Reports the caller's own resolved principal: the authentication method,
 * the normalized subject, and the granted scope set. Public access by
 * design — introspection has to work for every credential state to be
 * useful (a dashboard probes its principal before it knows anything), and
 * an unauthenticated caller learns only what it already knows: that it is
 * anonymous with no scopes. The response is strictly principal-shaped —
 * nothing about the server's auth configuration (key inventory,
 * `unauthenticatedAccess` posture, JWT issuers) is exposed.
 */

import { z } from 'zod';

import { AUTHORIZATION_SCOPES } from '../authorization-scope.ts';
import { shapeOperationFaultAsJson } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const principalMethodSchema = z.enum(['jwt', 'api-key', 'mtls', 'stdio-local', 'unauthenticated']);
const getPrincipalInput = z.object({});
const getPrincipalOutput = z.object({
  method: principalMethodSchema,
  subject: z.string().nullable(),
  scopes: z.array(z.enum(AUTHORIZATION_SCOPES)),
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
 * import { type GetPrincipalOutput } from '@lostgradient/weft/server';
 *
 * const anonymous: GetPrincipalOutput = {
 *   method: 'unauthenticated',
 *   subject: null,
 *   scopes: [],
 * };
 * console.log(anonymous.method);
 * ```
 */
export type GetPrincipalOutput = z.infer<typeof getPrincipalOutput>;

export const getPrincipalOperation = defineOperation<GetPrincipalInput, GetPrincipalOutput>({
  name: 'weft.system.principal',
  mcpExposable: false,
  summary: "Report the caller's resolved principal and granted scopes",
  description:
    "Report the caller's own resolved principal: the authentication method ('jwt', 'api-key', " +
    "'mtls', 'stdio-local', or 'unauthenticated'), the normalized subject when one exists, and " +
    'the granted authorization scopes, sorted. Public access: an unauthenticated caller ' +
    "receives method 'unauthenticated' with an empty scope list rather than an error, so " +
    'clients can distinguish "no credential" from "credential with few scopes" without probing ' +
    'other operations. Reflects only the request credential — never server auth configuration.',
  destructive: false,
  tags: ['System'],
  inputSchema: getPrincipalInput,
  outputSchema: getPrincipalOutput,
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
      subject: principal.subject ?? null,
      // Sorted for a deterministic wire shape — `scopes` is a Set whose
      // iteration order is credential-construction order, which callers
      // must not come to depend on.
      scopes: [...principal.scopes].toSorted(),
    };
  },
});

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
