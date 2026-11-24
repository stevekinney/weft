import { afterEach, describe, expect, it } from 'bun:test';
import { WEFT_SCOPE_VOCABULARY } from '../../authorization-scopes.ts';
import { getPrincipalOperation } from './get-principal.ts';

import {
  anonymousPrincipal,
  principalFromApiKey,
  principalFromJwtClaims,
} from "../../embedded/backchannel/src/index.ts";
import {
  createOperationRegistry,
  executeOperation,
  getPrincipalRestBinding,
  handleJsonRpcHttpRequest,
} from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { Engine } from '../../core/engine.ts';
import { handleRequest } from '../handler.ts';

function createEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

function apiKeyAuthContext() {
  return {
    authContext: {
      method: 'api-key' as const,
      // Deliberately unsorted so the sorted-wire-shape contract is observable.
      principal: principalFromApiKey({
        subject: 'introspection-caller',
        scopes: ['system:read', 'events:read', 'workflows:read'],
      }),
    },
  };
}

function jsonRpcRequest(): Request {
  return new Request('http://localhost/jsonrpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'weft.system.principal', id: 1 }),
  });
}

describe('weft.system.principal', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('echoes an authenticated principal with its scopes sorted', async () => {
    engine = createEngine();

    const output = await executeOperation(
      'weft.system.principal',
      {},
      {
        principal: apiKeyAuthContext().authContext.principal,
        host: engine,
        transport: 'jsonRpcStdio',
        registry: createOperationRegistry([getPrincipalOperation]),
      },
    );

    expect(output.ok).toBe(true);
    if (!output.ok) throw new Error('expected principal introspection to succeed');
    expect(output.value).toEqual({
      method: 'api-key',
      subject: 'introspection-caller',
      scopes: ['events:read', 'system:read', 'workflows:read'],
    });
  });

  it('reports the resolved workspace identity through JSON-RPC without sharing capability storage', async () => {
    engine = createEngine();
    const workspace = Object.freeze({
      version: 1 as const,
      workspaceId: 'workspace-one',
      actorId: 'actor-one',
      actorKind: 'user' as const,
      owner: 'opaque-owner-one',
      membershipRevision: 'revision-one',
      capabilities: Object.freeze(['workspace:use', 'workspace:manage'] as const),
    });
    const principal = { ...apiKeyAuthContext().authContext.principal, workspace };
    const output = await executeOperation(
      'weft.system.principal',
      {},
      {
        principal,
        host: engine,
        transport: 'jsonRpcStdio',
        registry: createOperationRegistry([getPrincipalOperation]),
      },
    );
    expect(output.ok).toBe(true);
    if (!output.ok) throw new Error('expected workspace introspection to succeed');
    const value = output.value;
    if (typeof value !== 'object' || value === null || !('workspace' in value)) {
      throw new Error('expected a workspace identity in the principal response');
    }
    const reportedWorkspace = value.workspace;
    expect(reportedWorkspace).toEqual(workspace);
    expect(reportedWorkspace).not.toBe(workspace);
    if (
      typeof reportedWorkspace !== 'object' ||
      reportedWorkspace === null ||
      !('capabilities' in reportedWorkspace)
    ) {
      throw new Error('expected workspace capabilities in the principal response');
    }
    expect(reportedWorkspace.capabilities).not.toBe(workspace.capabilities);

    const response = await handleJsonRpcHttpRequest(jsonRpcRequest(), {
      registry: createOperationRegistry([getPrincipalOperation]),
      host: engine,
      principal,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        method: 'api-key',
        subject: 'introspection-caller',
        scopes: ['events:read', 'system:read', 'workflows:read'],
        workspace,
      },
    });
  });

  it('reports an anonymous caller as unauthenticated with no scopes instead of failing', async () => {
    engine = createEngine();

    const output = await executeOperation(
      'weft.system.principal',
      {},
      {
        principal: anonymousPrincipal(),
        host: engine,
        transport: 'jsonRpcStdio',
        registry: createOperationRegistry([getPrincipalOperation]),
      },
    );

    expect(output.ok).toBe(true);
    if (!output.ok) throw new Error('expected anonymous introspection to succeed');
    expect(output.value).toEqual({
      method: 'unauthenticated',
      subject: null,
      scopes: [],
    });
  });

  it('reports a principal without a subject as subject: null', async () => {
    engine = createEngine();

    const output = await executeOperation(
      'weft.system.principal',
      {},
      {
        // A JWT without a `sub` claim is the legitimate subjectless
        // construction path (`principalFromApiKey` requires a subject).
        principal: principalFromJwtClaims(
          { scope: 'system:read' },
          { scopeVocabulary: WEFT_SCOPE_VOCABULARY },
        ),
        host: engine,
        transport: 'jsonRpcStdio',
        registry: createOperationRegistry([getPrincipalOperation]),
      },
    );

    expect(output.ok).toBe(true);
    if (!output.ok) throw new Error('expected subjectless introspection to succeed');
    expect(output.value).toEqual({
      method: 'jwt',
      subject: null,
      scopes: ['system:read'],
    });
  });

  it('serves the same shape through the REST binding', async () => {
    engine = createEngine();

    const response = await handleRequest(new Request('http://localhost/v1/principal'), engine, {
      operationRegistry: createOperationRegistry([getPrincipalOperation]),
      restBindings: [getPrincipalRestBinding],
      ...apiKeyAuthContext(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      method: 'api-key',
      subject: 'introspection-caller',
      scopes: ['events:read', 'system:read', 'workflows:read'],
    });
  });

  it('answers 200 with the anonymous shape through REST when no credential is presented', async () => {
    engine = createEngine();

    const response = await handleRequest(new Request('http://localhost/v1/principal'), engine, {
      operationRegistry: createOperationRegistry([getPrincipalOperation]),
      restBindings: [getPrincipalRestBinding],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      method: 'unauthenticated',
      subject: null,
      scopes: [],
    });
  });

  it('serves the same shape through JSON-RPC HTTP', async () => {
    engine = createEngine();

    const response = await handleJsonRpcHttpRequest(jsonRpcRequest(), {
      registry: createOperationRegistry([getPrincipalOperation]),
      host: engine,
      principal: apiKeyAuthContext().authContext.principal,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        method: 'api-key',
        subject: 'introspection-caller',
        scopes: ['events:read', 'system:read', 'workflows:read'],
      },
    });
  });
});
