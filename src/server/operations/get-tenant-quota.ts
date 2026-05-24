/**
 * `weft.tenants.quota.get` operation + REST binding.
 *
 * Returns quota usage for a tenant. When the caller presents a JWT, access
 * is scoped to the tenant whose id matches the JWT's tenant claim — this
 * shapes the tenant quota response for the REST surface.
 *
 * @module server/operations/get-tenant-quota
 */

import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { TenantQuotaUsage } from '../../core/types.ts';
import { raiseFault } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { invalidParamsFault, shapeRestFault } from './operation-helpers.ts';

const getTenantQuotaInput = z.object({
  tenantId: z.string().min(1),
});

const getTenantQuotaOutput = z.unknown();

export type GetTenantQuotaInput = z.infer<typeof getTenantQuotaInput>;
export type GetTenantQuotaOutput = TenantQuotaUsage;

export const getTenantQuotaOperation = defineOperation<GetTenantQuotaInput, GetTenantQuotaOutput>({
  name: 'weft.tenants.quota.get',
  mcpExposable: false,
  summary: 'Get quota usage for a tenant',
  tags: ['Budget'],
  inputSchema: getTenantQuotaInput,
  outputSchema: getTenantQuotaOutput as z.ZodType<GetTenantQuotaOutput>,
  access: {
    kind: 'scoped',
    scopes: { kind: 'anyOf', scopes: ['quota:read'] },
  },
  producibleFaults: ['Conflict'],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }): Promise<GetTenantQuotaOutput> => {
    const e = engine as Engine;

    const normalizedTenantId = input.tenantId.trim();
    if (normalizedTenantId.length === 0) {
      throw invalidParamsFault('Tenant id must be a non-empty string');
    }

    if (principal.method === 'jwt') {
      if (principal.tenantId === undefined) {
        raiseFault(getTenantQuotaOperation, {
          code: 'Forbidden',
          message:
            'JWT-authenticated tenant quota requests require a tenantId, tenant_id, or tenant claim',
          data: {
            reason:
              'JWT-authenticated tenant quota requests require a tenantId, tenant_id, or tenant claim',
          },
        });
      }
      if (principal.tenantId !== normalizedTenantId) {
        raiseFault(getTenantQuotaOperation, {
          code: 'Forbidden',
          message: 'Tenant quota access is limited to the authenticated tenant',
          data: { reason: 'Tenant quota access is limited to the authenticated tenant' },
        });
      }
    }

    return e.getQuotaUsage(normalizedTenantId);
  },
});

function shapeGetTenantQuotaFault(fault: OperationFault): Response {
  return shapeRestFault(fault);
}

export const getTenantQuotaRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/tenants/:id/quota',
  pathParamNames: ['id'],
  operationName: 'weft.tenants.quota.get',
  inputSources: {
    tenantId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => ({
    tenantId: pathParams['id'] ?? '',
  }),
  success: { kind: 'json', status: 200 },
  shapeFault: shapeGetTenantQuotaFault,
};
