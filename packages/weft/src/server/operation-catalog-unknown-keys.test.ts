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
import { anonymousPrincipal } from './principal.ts';
import { isRecord, record } from './protocol.test-support.ts';

const fakeEngine: Parameters<typeof executeOperation>[2]['engine'] = {};

function keysOfInput(input: unknown): string[] {
  if (!isRecord(input)) throw new Error('expected object input');
  return Object.keys(input).toSorted();
}

function regWithPolicy(http: 'reject' | 'strip' | 'passthrough') {
  return createOperationRegistry([
    makeOp({
      name: 'weft.test.unknownkey',
      inputSchema: z.object({ id: z.string() }),
      outputSchema: z.object({ receivedKeys: z.array(z.string()) }),
      invoke: async ({ input }) => ({
        receivedKeys: keysOfInput(input),
      }),
      unknownKeyPolicy: { http, jsonRpc: 'reject' },
    }),
  ]);
}

describe('executeOperation — step 5: unknown-key policy', () => {
  it('reject -> InvalidParams with unrecognized_keys', async () => {
    const result = await executeOperation(
      'weft.test.unknownkey',
      { id: 'x', extra: 'snuck-in' },
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry: regWithPolicy('reject'),
      },
    );
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('InvalidParams');
    if (result.fault.code !== 'InvalidParams') throw new Error('shape');
    const issue = result.fault.data.issues[0];
    expect(issue?.code).toBe('unrecognized_keys');
  });

  it('strip -> unknown keys dropped, invoke sees only schema fields', async () => {
    const result = await executeOperation(
      'weft.test.unknownkey',
      { id: 'x', extra: 'snuck-in' },
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry: regWithPolicy('strip'),
      },
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).toEqual({ receivedKeys: ['id'] });
  });

  it('passthrough -> input has stable null-prototype shape with OR without extras', async () => {
    // Regression: the input object handed to `invoke` under `passthrough`
    // policy must have the SAME prototype regardless of whether the
    // caller sent extras. Previously, the no-extras path returned zod's
    // output (Object.prototype) and the with-extras path returned a
    // null-prototype object, so an `invoke` calling `input.hasOwnProperty`
    // would crash intermittently. Both paths now return a null-prototype
    // object so the shape is stable.
    let prototypes: (object | null)[] = [];
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.passthroughshape',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({}),
        invoke: async ({ input }) => {
          prototypes.push(Object.getPrototypeOf(input));
          return {};
        },
        unknownKeyPolicy: { http: 'passthrough', jsonRpc: 'reject' },
      }),
    ]);
    const ctx = {
      principal: anonymousPrincipal(),
      engine: fakeEngine,
      transport: 'http-rest' as const,
      registry,
    };
    await executeOperation('weft.test.passthroughshape', { id: 'x' }, ctx);
    await executeOperation('weft.test.passthroughshape', { id: 'x', extra: 'y' }, ctx);
    expect(prototypes).toHaveLength(2);
    expect(prototypes[0]).toBe(null);
    expect(prototypes[1]).toBe(null);
  });

  it('passthrough -> unknown keys preserved into invoke', async () => {
    const result = await executeOperation(
      'weft.test.unknownkey',
      { id: 'x', extra: 'snuck-in' },
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry: regWithPolicy('passthrough'),
      },
    );
    if (!result.ok) throw new Error('expected ok');
    const value = record(result.value, 'result');
    const receivedKeys = value['receivedKeys'];
    if (!Array.isArray(receivedKeys) || !receivedKeys.every((key) => typeof key === 'string')) {
      throw new Error('expected received keys');
    }
    expect(receivedKeys.toSorted()).toEqual(['extra', 'id']);
  });

  it('passthrough policy is authoritative even when schema is .strict()', async () => {
    // Regression: previously, the `passthrough` policy fed unknown keys
    // straight to `safeParse`, so a schema declared with `.strict()` would
    // reject them and override the catalog's directive. The catalog's
    // policy MUST win at the top level — strip extras before parsing,
    // re-attach them after a successful parse.
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.passthroughstrict',
        inputSchema: z.object({ id: z.string() }).strict(),
        outputSchema: z.object({ receivedKeys: z.array(z.string()) }),
        invoke: async ({ input }) => ({
          receivedKeys: keysOfInput(input),
        }),
        unknownKeyPolicy: { http: 'passthrough', jsonRpc: 'reject' },
      }),
    ]);
    const result = await executeOperation(
      'weft.test.passthroughstrict',
      { id: 'x', extra: 'snuck-in' },
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    if (!result.ok) throw new Error('expected ok');
    const value = record(result.value, 'result');
    const receivedKeys = value['receivedKeys'];
    if (!Array.isArray(receivedKeys) || !receivedKeys.every((key) => typeof key === 'string')) {
      throw new Error('expected received keys');
    }
    expect(receivedKeys.toSorted()).toEqual(['extra', 'id']);
  });

  it('array input is handed straight to the schema (not coerced to object)', async () => {
    // Arrays satisfy `typeof === 'object'` but are not the `params` shape
    // we support. Without an `Array.isArray` guard, the unknown-key
    // pre-pass would treat the enumerable extra property as "unrecognized
    // key" (under `reject`) or coerce the array to a stripped null-
    // prototype object (under `strip`/`passthrough`). Either path is
    // wrong — let the schema produce its native shape error.
    //
    // The array is decorated with an enumerable own property to give the
    // (broken) pre-pass an actual unknown key to choke on; this proves
    // the guard fires, not that the array happens to have no extras.
    const arrayWithExtra = Object.assign([1, 2, 3], { snuckIn: 'extra' });
    const result = await executeOperation('weft.test.unknownkey', arrayWithExtra, {
      principal: anonymousPrincipal(),
      engine: fakeEngine,
      transport: 'http-rest',
      registry: regWithPolicy('reject'),
    });
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('InvalidParams');
    if (result.fault.code !== 'InvalidParams') throw new Error('shape');
    // The Zod-native shape error wins (issue code is `invalid_type` for
    // an array fed to an object schema). The synthetic
    // `unrecognized_keys` code MUST NOT appear — that would mean the
    // pre-pass swallowed the array.
    const codes = result.fault.data.issues.map((issue) => issue.code);
    expect(codes).toContain('invalid_type');
    expect(codes).not.toContain('unrecognized_keys');
  });

  it('strip policy is authoritative even when schema is .strict()', async () => {
    // Mirror regression: `strip` must also short-circuit `.strict()` since
    // the catalog policy is the single authoritative source for top-level
    // unknown-key disposition. Without the early sanitize, `.strict()`
    // would reject the call before strip could take effect.
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.stripstrict',
        inputSchema: z.object({ id: z.string() }).strict(),
        outputSchema: z.object({ receivedKeys: z.array(z.string()) }),
        invoke: async ({ input }) => ({
          receivedKeys: keysOfInput(input),
        }),
        unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
      }),
    ]);
    const result = await executeOperation(
      'weft.test.stripstrict',
      { id: 'x', extra: 'snuck-in' },
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).toEqual({ receivedKeys: ['id'] });
  });
});
