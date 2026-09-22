/**
 * Tests for `OperationDefinition`, `executeOperation` pipeline, and
 * `classifyEngineError`. The pipeline is the single dispatch point that
 * REST, JSON-RPC HTTP, JSON-RPC WebSocket, and stdio transports all call —
 * the structural enforcement that prevents drift between transports in the
 * stable operation-catalog contract.
 *
 * Pipeline order under test (each step has at least one passing and one
 * failing case):
 *   1. resolve operation by name
 *   2. transport availability
 *   3. access check (driven by AccessPolicy)
 *   4. zod parse (shape only, .passthrough() semantics)
 *   5. unknown-key policy enforcement
 *   6. authorize hook
 *   7. invoke
 *   8. catch + classify
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { makeOperation as makeOp } from './json-rpc-operation.test-support.ts';
import {
  classifyEngineError,
  createOperationRegistry,
  executeOperation,
  type ErasedOperation,
  type OperationRegistry,
} from './operation-catalog.ts';
import type { AuthorizationDecision } from './operation-catalog/types.ts';
import type { OperationFault } from './operation-fault.ts';
import { anonymousPrincipal } from './principal.ts';

// A trivial fake engine — these tests never need real workflow state.
const fakeEngine = {} as Parameters<typeof executeOperation>[2]['engine'];

function registryFor(operation: ErasedOperation): OperationRegistry {
  return {
    get: (name) => (name === operation.name ? operation : undefined),
    list: () => [operation],
  };
}

const ENGINE_FAILURE_FAULT = {
  code: 'EngineFailure',
  message: 'internal error',
  data: {},
} satisfies OperationFault;

describe('executeOperation — additional coverage', () => {
  it('authenticated access policy with anonymous principal returns Unauthorized', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.authonly',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => ({}),
        access: { kind: 'authenticated' },
      }),
    ]);
    const result = await executeOperation(
      'weft.test.authonly',
      {},
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('Unauthorized');
  });

  it('http-rest transport rejection works (not just jsonRpcHttp)', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.nohttp',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => ({}),
        transports: {
          http: false,
          jsonRpcHttp: true,
          jsonRpcWebSocket: true,
          jsonRpcStdio: true,
        },
      }),
    ]);
    const result = await executeOperation(
      'weft.test.nohttp',
      {},
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('UnsupportedTransport');
    if (result.fault.code !== 'UnsupportedTransport') throw new Error('shape');
    expect(result.fault.data.transport).toBe('http-rest');
  });

  it('registry list() is frozen and returns a stable reference', () => {
    const op = makeOp({
      name: 'weft.test.frozen',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
    });
    const registry = createOperationRegistry([op]);
    const list1 = registry.list();
    const list2 = registry.list();
    expect(list1).toBe(list2);
    expect(Object.isFrozen(list1)).toBe(true);
  });

  it('registry deep-freezes load-bearing nested policy objects', () => {
    // Without nested freezes, a caller that built a shared `transports` /
    // `access` / `unknownKeyPolicy` literal could mutate it post-
    // registration and silently change the registered operation's
    // authorization or dispatch behavior. Each of these fields flows into
    // a security-relevant decision and must be frozen at the registry
    // boundary regardless of how the caller constructed them.
    const op = makeOp({
      name: 'weft.test.deepfrozen',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
    });
    const registry = createOperationRegistry([op]);
    const stored = registry.get('weft.test.deepfrozen');
    if (!stored) throw new Error('expected stored op');
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.tags)).toBe(true);
    expect(Object.isFrozen(stored.access)).toBe(true);
    expect(Object.isFrozen(stored.transports)).toBe(true);
    expect(Object.isFrozen(stored.unknownKeyPolicy)).toBe(true);
  });

  it('registry isolates the stored operation from caller-side mutations', () => {
    // The aliasing risk the comment on `createOperationRegistry`'s
    // freeze block describes: a caller mutates the original literal
    // they handed in, expecting that to change the registered op. The
    // registry must store COPIES, not the same references — so mutation
    // of the caller's object is invisible to the registry.
    const transports = {
      http: true,
      jsonRpcHttp: true,
      jsonRpcWebSocket: true,
      jsonRpcStdio: false,
    };
    const op = makeOp({
      name: 'weft.test.aliasing',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
      transports,
    });
    const registry = createOperationRegistry([op]);
    const stored = registry.get('weft.test.aliasing');
    if (!stored) throw new Error('expected stored op');

    // Mutate the caller's reference AFTER registration.
    transports.jsonRpcStdio = true;

    // The stored op must reflect the value at registration time, not
    // the post-mutation value — proving the registry copied the object.
    expect(stored.transports.jsonRpcStdio).toBe(false);
    expect(stored.transports).not.toBe(transports);
  });

  it('registry deep-freezes the nested ScopeRequirement.scopes array on scoped policies', () => {
    // The `scoped` AccessPolicy variant nests a `ScopeRequirement` whose
    // `scopes` array is mutable on entry. A shallow freeze of `access`
    // would leave that array aliased to the caller's reference — a
    // mutation there would silently change which scopes are required.
    // `freezeAccessPolicy` must recursively freeze it.
    const callerScopes = ['workflows:read'] as const;
    const op = makeOp({
      name: 'weft.test.scopedfreeze',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
      access: {
        kind: 'scoped',
        scopes: { kind: 'anyOf', scopes: [...callerScopes] },
      },
    });
    const registry = createOperationRegistry([op]);
    const stored = registry.get('weft.test.scopedfreeze');
    if (!stored) throw new Error('expected stored op');
    if (stored.access.kind !== 'scoped') throw new Error('expected scoped access');
    expect(Object.isFrozen(stored.access)).toBe(true);
    expect(Object.isFrozen(stored.access.scopes)).toBe(true);
    expect(Object.isFrozen(stored.access.scopes.scopes)).toBe(true);
  });

  it('registry deep-freezes the nested authenticatedScopes.scopes array on optionalAuth policies', () => {
    // Mirror coverage for the `optionalAuth` variant — its
    // `authenticatedScopes` is structurally the same as `scoped.scopes`
    // and the freeze must reach the inner array there too.
    const op = makeOp({
      name: 'weft.test.optauthfreeze',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
      access: {
        kind: 'optionalAuth',
        authenticatedScopes: { kind: 'allOf', scopes: ['workflows:write'] },
      },
    });
    const registry = createOperationRegistry([op]);
    const stored = registry.get('weft.test.optauthfreeze');
    if (!stored) throw new Error('expected stored op');
    if (stored.access.kind !== 'optionalAuth') throw new Error('expected optionalAuth access');
    expect(Object.isFrozen(stored.access.authenticatedScopes)).toBe(true);
    expect(Object.isFrozen(stored.access.authenticatedScopes.scopes)).toBe(true);
  });

  it('registry deep-freezes scopedAlternatives requirements', () => {
    const op = makeOp({
      name: 'weft.test.alternativesfreeze',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
      access: {
        kind: 'scopedAlternatives',
        alternatives: [
          { kind: 'allOf', scopes: ['workflows:read', 'workflows:write'] },
          { kind: 'anyOf', scopes: ['workflows:admin'] },
        ],
      },
    });
    const registry = createOperationRegistry([op]);
    const stored = registry.get('weft.test.alternativesfreeze');
    if (!stored) throw new Error('expected stored op');
    if (stored.access.kind !== 'scopedAlternatives') {
      throw new Error('expected scopedAlternatives access');
    }
    expect(Object.isFrozen(stored.access.alternatives)).toBe(true);
    expect(Object.isFrozen(stored.access.alternatives[0])).toBe(true);
    expect(Object.isFrozen(stored.access.alternatives[0].scopes)).toBe(true);
  });

  it('returns EngineFailure when defensive authorization guards trip', async () => {
    const baseOperation = makeOp({
      name: 'weft.test.defensive',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
    });

    let result = await executeOperation(
      'weft.test.defensive',
      {},
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry: registryFor(
          makeOp({
            name: baseOperation.name,
            inputSchema: z.object({}),
            outputSchema: z.object({}),
            invoke: async () => ({}),
            authorize: async () => {
              const decision: AuthorizationDecision = { allowed: true };
              Object.defineProperty(decision, 'allowed', {
                get() {
                  throw new Error('allowed getter exploded');
                },
              });
              return decision;
            },
          }),
        ),
      },
    );
    if (result.ok) throw new Error('expected fault');
    expect(result.fault).toEqual(ENGINE_FAILURE_FAULT);

    result = await executeOperation(
      'weft.test.defensive',
      {},
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry: registryFor(
          makeOp({
            name: baseOperation.name,
            inputSchema: z.object({}),
            outputSchema: z.object({}),
            invoke: async () => ({}),
            authorize: async () => {
              const decision: AuthorizationDecision = { allowed: false, reason: 'denied' };
              Object.defineProperty(decision, 'reason', {
                get() {
                  throw new Error('reason getter exploded');
                },
              });
              return decision;
            },
          }),
        ),
      },
    );
    if (result.ok) throw new Error('expected fault');
    expect(result.fault).toEqual(ENGINE_FAILURE_FAULT);

    result = await executeOperation(
      'weft.test.defensive',
      {},
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry: registryFor(
          makeOp({
            name: baseOperation.name,
            inputSchema: z.object({}),
            outputSchema: z.object({}),
            invoke: async () => ({}),
            authorize: async () => {
              const decision: AuthorizationDecision = { allowed: false, reason: 'denied' };
              Object.defineProperty(decision, 'classification', {
                get() {
                  throw new Error('classification getter exploded');
                },
              });
              return decision;
            },
          }),
        ),
      },
    );
    if (result.ok) throw new Error('expected fault');
    expect(result.fault).toEqual(ENGINE_FAILURE_FAULT);
  });

  it('classifies Error instances with non-string message values as EngineFailure', () => {
    const error = new Error('original');
    Object.defineProperty(error, 'message', {
      get() {
        return 42;
      },
    });

    expect(classifyEngineError(error)).toEqual({
      code: 'EngineFailure',
      message: 'internal error',
      data: {},
    });
  });
});
