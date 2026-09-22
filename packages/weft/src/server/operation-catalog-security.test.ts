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
import { createOperationRegistry, executeOperation } from './operation-catalog.ts';
import { anonymousPrincipal, principalFromApiKey } from './principal.ts';

const fakeEngine: Parameters<typeof executeOperation>[2]['engine'] = {};

describe('executeOperation — security regressions', () => {
  it('rejects __proto__ in passthrough mode (prevents prototype pollution)', async () => {
    const seen: Record<string, unknown> = {};
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.protopollution',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({}),
        invoke: async ({ input }) => {
          // The pipeline must filter __proto__ from passthrough re-attachment
          // so the input's prototype chain is not polluted.
          seen['hasProtoOwn'] = Object.prototype.hasOwnProperty.call(input, '__proto__');
          // And the parsed input must not have inherited the malicious value
          // (a sentinel attacker tried to inject).
          seen['inheritedPolluted'] = Reflect.get(input, 'polluted');
          return {};
        },
        unknownKeyPolicy: { http: 'passthrough', jsonRpc: 'passthrough' },
      }),
    ]);
    // JSON.parse hard-codes the __proto__ key as a literal own property, which
    // is the canonical attack shape for prototype pollution.
    const malicious = JSON.parse('{"id":"x","__proto__":{"polluted":true}}');
    const result = await executeOperation('weft.test.protopollution', malicious, {
      principal: anonymousPrincipal(),
      engine: fakeEngine,
      transport: 'http-rest',
      registry,
    });
    expect(result.ok).toBe(true);
    // __proto__ MUST NOT survive as a passthrough extra.
    expect(seen['hasProtoOwn']).toBe(false);
    expect(seen['inheritedPolluted']).toBeUndefined();
    // And the global Object.prototype must not have been polluted.
    expect(Reflect.get({}, 'polluted')).toBeUndefined();
  });

  it('catches schema refinements/transforms that throw', async () => {
    const throwingSchema = z.object({ id: z.string() }).refine((input) => {
      if (input.id === 'boom') throw new Error('refinement secret detail');
      return true;
    });
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.schemathrows',
        inputSchema: throwingSchema,
        outputSchema: z.object({}),
        invoke: async () => ({}),
      }),
    ]);
    const result = await executeOperation(
      'weft.test.schemathrows',
      { id: 'boom' },
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('EngineFailure');
    expect(JSON.stringify(result.fault)).not.toContain('refinement secret');
  });

  it('output that violates outputSchema does not leak secret fields', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.badoutput',
        inputSchema: z.object({}),
        outputSchema: z.object({ public: z.string() }).strict(),
        invoke: async () => Object.assign({ public: 'ok' }, { secret: 'hunter2' }),
      }),
    ]);
    const result = await executeOperation(
      'weft.test.badoutput',
      {},
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    // Either the strict schema rejects (fault) or strips (ok with no secret).
    // Both paths must not leak the secret.
    const serialized = JSON.stringify(result.ok ? result.value : result.fault);
    expect(serialized).not.toContain('hunter2');
  });

  it('hook-throw secret-leak invariant covers the entire fault, not just message', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.hooksecretleak',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => ({}),
        access: { kind: 'authenticated' },
        authorize: async () => {
          throw new Error('database password: hunter2');
        },
      }),
    ]);
    const result = await executeOperation(
      'weft.test.hooksecretleak',
      {},
      {
        principal: principalFromApiKey({ subject: 'k', scopes: [] }),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('EngineFailure');
    expect(JSON.stringify(result.fault)).not.toContain('hunter2');
  });
});
