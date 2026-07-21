/** `weft.system.lease` operation, authorization, and REST binding coverage. */

import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey, principalFromJwtClaims } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import { getSystemLeaseOperation, getSystemLeaseRestBinding } from './get-system-lease.ts';

function systemReadAuthContext() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'operator', scopes: ['system:read'] }),
    },
  };
}

describe('weft.system.lease', () => {
  it('declares a scoped, non-destructive operation on REST and every JSON-RPC transport', () => {
    expect(getSystemLeaseOperation.access).toEqual({
      kind: 'scoped',
      scopes: { kind: 'anyOf', scopes: ['system:read'] },
    });
    expect(getSystemLeaseOperation.destructive).toBe(false);
    expect(getSystemLeaseOperation.transports).toEqual({
      http: true,
      jsonRpcHttp: true,
      jsonRpcWebSocket: true,
      jsonRpcStdio: true,
    });
    expect(getSystemLeaseRestBinding).toMatchObject({
      method: 'GET',
      path: '/v1/system/lease',
      operationName: 'weft.system.lease',
    });
  });

  it('keeps ownership-disabled state distinct over REST', async () => {
    using engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(new Request('http://localhost/v1/system/lease'), engine, {
      operationRegistry: createOperationRegistry([getSystemLeaseOperation]),
      restBindings: [getSystemLeaseRestBinding],
      ...systemReadAuthContext(),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      mode: 'none',
      status: 'disabled',
      holdsLease: false,
    });
  });

  it('keeps a fresh lease-mode non-owner distinct over JSON-RPC stdio', async () => {
    using engine = new Engine({ ownership: 'lease', storage: new MemoryStorage() });

    const result = await executeOperation(
      'weft.system.lease',
      {},
      {
        principal: principalFromJwtClaims({ sub: 'operator', scope: 'system:read' }),
        engine,
        transport: 'jsonRpcStdio',
        registry: createOperationRegistry([getSystemLeaseOperation]),
      },
    );

    expect(result).toEqual({
      ok: true,
      value: { mode: 'lease', status: 'no-lease', holdsLease: false },
    });
  });

  it('preserves a detached manager deposition without disclosing a successor holder', async () => {
    const engine = {
      getLeaseHealth: () => ({
        mode: 'lease',
        status: 'contested',
        holdsLease: false,
        lossReason: 'deposed',
      }),
    };

    const result = await executeOperation(
      'weft.system.lease',
      {},
      {
        principal: principalFromJwtClaims({ sub: 'operator', scope: 'system:read' }),
        engine,
        transport: 'jsonRpcHttp',
        registry: createOperationRegistry([getSystemLeaseOperation]),
      },
    );

    expect(result).toEqual({
      ok: true,
      value: {
        mode: 'lease',
        status: 'contested',
        holdsLease: false,
        lossReason: 'deposed',
      },
    });
  });

  it('rejects anonymous and insufficiently scoped callers', async () => {
    using engine = new Engine({ storage: new MemoryStorage() });
    const registry = createLiveOperationRegistry();

    const anonymous = await executeOperation(
      'weft.system.lease',
      {},
      {
        principal: { method: 'unauthenticated' },
        engine,
        transport: 'jsonRpcStdio',
        registry,
      },
    );
    const insufficientScope = await executeOperation(
      'weft.system.lease',
      {},
      {
        principal: principalFromJwtClaims({ sub: 'viewer', scope: 'workflows:read' }),
        engine,
        transport: 'jsonRpcStdio',
        registry,
      },
    );

    expect(anonymous.ok).toBe(false);
    if (anonymous.ok) throw new Error('expected anonymous rejection');
    expect(anonymous.fault.code).toBe('Unauthorized');
    expect(insufficientScope.ok).toBe(false);
    if (insufficientScope.ok) throw new Error('expected scope rejection');
    expect(insufficientScope.fault.code).toBe('Forbidden');
  });
});
