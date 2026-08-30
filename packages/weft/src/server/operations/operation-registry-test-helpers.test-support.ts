import { expect } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { executeOperation, type OperationRegistry } from '../operation-catalog.ts';
import {
  principalFromApiKey,
  principalFromJwtClaims,
  type AuthenticatedPrincipal,
} from '../principal.ts';

/** Engine backed by `MemoryStorage` for operation tests. */
export function createOperationTestEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

/** `handleRequest` auth-context spread for an api-key caller with `system:read`. */
export function systemReadAuthContext(): {
  authContext: { method: 'api-key'; principal: AuthenticatedPrincipal };
} {
  return {
    authContext: {
      method: 'api-key',
      principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
    },
  };
}

type AuthorizationAssertionOptions = {
  operationName: string;
  engine: Engine;
  liveRegistry: OperationRegistry;
};

/** Assert the operation rejects an unauthenticated JSON-RPC caller with `Unauthorized`. */
export async function assertOperationRejectsUnauthenticated(
  options: AuthorizationAssertionOptions,
): Promise<void> {
  const result = await executeOperation(
    options.operationName,
    {},
    {
      principal: { method: 'unauthenticated' },
      engine: options.engine,
      transport: 'jsonRpcStdio',
      registry: options.liveRegistry,
    },
  );

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected rejection');
  expect(result.fault.code).toBe('Unauthorized');
}

/** Assert the operation rejects a caller whose scopes do not satisfy `system:read`. */
export async function assertOperationRejectsInsufficientScope(
  options: AuthorizationAssertionOptions,
): Promise<void> {
  const result = await executeOperation(
    options.operationName,
    {},
    {
      principal: principalFromJwtClaims({ sub: 'user', scope: 'workflows:read' }),
      engine: options.engine,
      transport: 'jsonRpcStdio',
      registry: options.liveRegistry,
    },
  );

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected rejection');
  expect(result.fault.code).toBe('Forbidden');
}
