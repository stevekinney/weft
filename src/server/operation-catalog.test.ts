/**
 * Tests for `OperationDefinition`, `executeOperation` pipeline, and
 * `classifyEngineError`. The pipeline is the single dispatch point that
 * REST, JSON-RPC HTTP, JSON-RPC WebSocket, and stdio transports all call —
 * the structural enforcement that prevents drift between transports per
 * Track 8 design decision 2.
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

import {
  classifyEngineError,
  createOperationRegistry,
  executeOperation,
  type ErasedOperation,
  type OperationDefinition,
} from './operation-catalog.ts';
import type { OperationFault } from './operation-fault.ts';
import { anonymousPrincipal, principalFromApiKey } from './principal.ts';

// A trivial fake engine — these tests never need real workflow state.
const fakeEngine = {} as Parameters<typeof executeOperation>[2]['engine'];

function makeOp<Input, Output>(
  overrides: Partial<OperationDefinition<Input, Output>> & {
    name: string;
    inputSchema: z.ZodType<Input>;
    outputSchema: z.ZodType<Output>;
    invoke: OperationDefinition<Input, Output>['invoke'];
  },
): ErasedOperation {
  // Cast to the type-erased registry shape — the inputSchema's type
  // parameter is contravariant in `authorize`/`invoke` and exact-optional
  // checking blocks direct assignment without erasure. Tests are exempt
  // from the no-`as` rule per CLAUDE.md.
  return {
    summary: 'test op',
    tags: [],
    access: { kind: 'public' },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    ...overrides,
  } as unknown as ErasedOperation;
}

describe('executeOperation — happy path', () => {
  it('parses input, invokes, returns ok', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.echo',
        inputSchema: z.object({ value: z.string() }),
        outputSchema: z.object({ echoed: z.string() }),
        invoke: async ({ input }) => ({ echoed: input.value }),
      }),
    ]);
    const result = await executeOperation(
      'weft.test.echo',
      { value: 'hi' },
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    expect(result).toEqual({ ok: true, value: { echoed: 'hi' } });
  });
});

describe('executeOperation — step 1: resolve operation', () => {
  it('unknown operation -> MethodNotFound fault', async () => {
    const registry = createOperationRegistry([]);
    const result = await executeOperation(
      'weft.does-not-exist',
      {},
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('MethodNotFound');
    if (result.fault.code !== 'MethodNotFound') throw new Error('shape');
    expect(result.fault.data.method).toBe('weft.does-not-exist');
  });
});

describe('executeOperation — step 2: transport availability', () => {
  it('transport not in availability -> UnsupportedTransport fault', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.subscribeonly',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => ({}),
        transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: true },
      }),
    ]);
    const result = await executeOperation(
      'weft.test.subscribeonly',
      {},
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'jsonRpcHttp',
        registry,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('UnsupportedTransport');
    if (result.fault.code !== 'UnsupportedTransport') throw new Error('shape');
    expect(result.fault.data.transport).toBe('jsonRpcHttp');
    expect(result.fault.data.supported).toContain('jsonRpcWebSocket');
    expect(result.fault.data.supported).not.toContain('jsonRpcHttp');
  });
});

describe('executeOperation — step 3: access check', () => {
  const registry = createOperationRegistry([
    makeOp({
      name: 'weft.test.scoped',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
      access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['workflows:read'] } },
    }),
  ]);

  it('unauthenticated principal on scoped op -> Unauthorized fault', async () => {
    const result = await executeOperation(
      'weft.test.scoped',
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

  it('authenticated principal without scope -> Forbidden fault', async () => {
    const result = await executeOperation(
      'weft.test.scoped',
      {},
      {
        principal: principalFromApiKey({ subject: 'k', scopes: [] }),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('Forbidden');
  });

  it('authenticated principal with scope -> proceeds', async () => {
    const result = await executeOperation(
      'weft.test.scoped',
      {},
      {
        principal: principalFromApiKey({ subject: 'k', scopes: ['workflows:read'] }),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    expect(result.ok).toBe(true);
  });
});

describe('executeOperation — step 4: zod parse', () => {
  const registry = createOperationRegistry([
    makeOp({
      name: 'weft.test.typed',
      inputSchema: z.object({ id: z.string(), count: z.number() }),
      outputSchema: z.object({}),
      invoke: async () => ({}),
    }),
  ]);

  it('invalid input -> InvalidParams fault with flattened issues', async () => {
    const result = await executeOperation(
      'weft.test.typed',
      { id: 'x', count: 'not-a-number' },
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('InvalidParams');
    if (result.fault.code !== 'InvalidParams') throw new Error('shape');
    expect(result.fault.data.issues.length).toBeGreaterThan(0);
    expect(result.fault.data.issues[0]?.path).toContain('count');
  });

  it('null input is rejected as InvalidParams', async () => {
    const result = await executeOperation('weft.test.typed', null, {
      principal: anonymousPrincipal(),
      engine: fakeEngine,
      transport: 'http-rest',
      registry,
    });
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('InvalidParams');
  });
});

describe('executeOperation — step 5: unknown-key policy', () => {
  function regWithPolicy(http: 'reject' | 'strip' | 'passthrough') {
    return createOperationRegistry([
      makeOp({
        name: 'weft.test.unknownkey',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ receivedKeys: z.array(z.string()) }),
        invoke: async ({ input }) => ({
          receivedKeys: Object.keys(input as object).toSorted(),
        }),
        unknownKeyPolicy: { http, jsonRpc: 'reject' },
      }),
    ]);
  }

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
          prototypes.push(Object.getPrototypeOf(input as object));
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
    const value = result.value as { receivedKeys: string[] };
    expect(value.receivedKeys.toSorted()).toEqual(['extra', 'id']);
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
          receivedKeys: Object.keys(input as object).toSorted(),
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
    const value = result.value as { receivedKeys: string[] };
    expect(value.receivedKeys.toSorted()).toEqual(['extra', 'id']);
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
    const result = await executeOperation(
      'weft.test.unknownkey',
      arrayWithExtra as unknown as Record<string, unknown>,
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
          receivedKeys: Object.keys(input as object).toSorted(),
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

describe('executeOperation — step 6: authorize hook', () => {
  it('hook denial -> Forbidden fault with reason', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.hooked',
        inputSchema: z.object({ workflowId: z.string() }),
        outputSchema: z.object({}),
        invoke: async () => ({}),
        access: { kind: 'authenticated' },
        authorize: async ({ input }) => {
          if (input.workflowId === 'forbidden') {
            return { allowed: false, reason: 'workflow not in tenant' };
          }
          return { allowed: true };
        },
      }),
    ]);
    const principal = principalFromApiKey({ subject: 'k', scopes: [] });

    const allowed = await executeOperation(
      'weft.test.hooked',
      { workflowId: 'allowed' },
      { principal, engine: fakeEngine, transport: 'http-rest', registry },
    );
    expect(allowed.ok).toBe(true);

    const denied = await executeOperation(
      'weft.test.hooked',
      { workflowId: 'forbidden' },
      { principal, engine: fakeEngine, transport: 'http-rest', registry },
    );
    if (denied.ok) throw new Error('expected fault');
    expect(denied.fault.code).toBe('Forbidden');
    if (denied.fault.code !== 'Forbidden') throw new Error('shape');
    expect(denied.fault.data.reason).toContain('workflow not in tenant');
  });

  it('hook throw -> EngineFailure (no internal detail leaked)', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.hookthrows',
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
      'weft.test.hookthrows',
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
    expect(result.fault.message).not.toContain('hunter2');
  });
});

describe('executeOperation — step 7+8: invoke + classify', () => {
  it('invoke throws Error -> classified as EngineFailure', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.boom',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => {
          throw new Error('something went wrong');
        },
      }),
    ]);
    const result = await executeOperation(
      'weft.test.boom',
      {},
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('EngineFailure');
  });

  it('invoke throws an OperationFault -> passed through unchanged', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.notfoundthrow',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => {
          throw {
            code: 'NotFound',
            message: 'workflow "wf-1" not found',
            data: { resource: 'workflow', identifier: 'wf-1' },
          };
        },
      }),
    ]);
    const result = await executeOperation(
      'weft.test.notfoundthrow',
      {},
      {
        principal: anonymousPrincipal(),
        engine: fakeEngine,
        transport: 'http-rest',
        registry,
      },
    );
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('NotFound');
    if (result.fault.code !== 'NotFound') throw new Error('shape');
    expect(result.fault.data.identifier).toBe('wf-1');
  });
});

describe('classifyEngineError', () => {
  it('classifies a thrown OperationFault by passing it through', () => {
    const fault = classifyEngineError({
      code: 'Conflict',
      message: 'dup',
      data: { reason: 'duplicate id' },
    });
    expect(fault.code).toBe('Conflict');
  });

  it('classifies an Error with "not found" message as NotFound with a generic public message', () => {
    const fault = classifyEngineError(new Error('workflow "wf-x" not found at /var/secret/path'));
    expect(fault.code).toBe('NotFound');
    // The original error message MUST NOT propagate to the wire — it can
    // contain internal details like file paths, query text, or secrets.
    expect(fault.message).toBe('not found');
    expect(fault.message).not.toContain('/var/secret/path');
  });

  it('classifies an Error with "already exists" message as Conflict with a generic message', () => {
    const fault = classifyEngineError(
      new Error('schedule with id "sched-1" already exists in tenant secret-tenant'),
    );
    expect(fault.code).toBe('Conflict');
    expect(fault.message).toBe('conflict');
    expect(fault.message).not.toContain('secret-tenant');
  });

  it('classifies an Error with "timeout" message as Timeout with a generic message', () => {
    const fault = classifyEngineError(new Error('update timeout exceeded after 30s'));
    expect(fault.code).toBe('Timeout');
    expect(fault.message).toBe('operation timed out');
  });

  it('classifies any unrecognized Error as EngineFailure with a generic message', () => {
    const fault = classifyEngineError(new Error('mysterious failure with internals'));
    expect(fault.code).toBe('EngineFailure');
    expect(fault.message).toBe('internal error');
  });

  it('classifies a thrown non-Error value as EngineFailure', () => {
    const fault = classifyEngineError('a string thrown for some reason');
    expect(fault.code).toBe('EngineFailure');
  });

  it('classifies a thrown null/undefined as EngineFailure', () => {
    expect(classifyEngineError(null).code).toBe('EngineFailure');
    expect(classifyEngineError(undefined).code).toBe('EngineFailure');
  });

  it('classifies "timed out" substring (separate from "timeout") as Timeout with generic message', () => {
    const fault = classifyEngineError(new Error('database call timed out after 30 seconds'));
    expect(fault.code).toBe('Timeout');
    expect(fault.message).toBe('operation timed out');
  });

  it('rejects a fault-shaped object with no `data` field', () => {
    // Without `data`, downstream serializers would crash. Treat as a
    // malformed fault and fall through to EngineFailure.
    const fault = classifyEngineError({ code: 'NotFound', message: 'no data' });
    expect(fault.code).toBe('EngineFailure');
  });

  it('classifies an Error subclass with a throwing message getter as EngineFailure', () => {
    // Defense against an `Error` subclass that overrides `message` with a
    // throwing accessor. Without try/catch around `error.message`, the
    // throw would escape `executeOperation` and break its contract of
    // always returning a `DispatchResult`.
    class HostileError extends Error {
      constructor() {
        super('initial');
        Object.defineProperty(this, 'message', {
          get() {
            throw new Error('secret detail');
          },
        });
      }
    }
    const fault = classifyEngineError(new HostileError());
    expect(fault.code).toBe('EngineFailure');
    expect(fault.message).toBe('internal error');
  });

  it('rejects a fault-shaped object whose `data` is an array', () => {
    // Arrays satisfy `typeof === 'object' && !== null`, but every
    // `OperationFault` variant declares `data` as a plain object. A
    // thrown `{ code: 'InvalidParams', message: 'x', data: [] }` would
    // crash downstream serializers (e.g. `data.issues.map(...)`). The
    // guard must reject it.
    const fault = classifyEngineError({ code: 'InvalidParams', message: 'x', data: [] });
    expect(fault.code).toBe('EngineFailure');
  });

  it('rejects a fault-shaped value with a poisoned getter', () => {
    const poisoned = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'code') throw new Error('secret');
          return undefined;
        },
      },
    );
    const fault = classifyEngineError(poisoned);
    expect(fault.code).toBe('EngineFailure');
  });

  it('passes through every FaultCode variant (runtime smoke check)', () => {
    // The compile-time `Record<FaultCode, true>` constraint on the internal
    // `FAULT_CODES` table is the actual exhaustiveness guard — a missing
    // union member would fail to typecheck. This test is a runtime smoke
    // check over the variants currently known to the test file: it catches
    // accidents like the runtime check being reverted from `Object.hasOwn`
    // back to a partial array, or the classifier silently mishandling a
    // specific existing code. Adding a new `FaultCode` will not auto-extend
    // this list, so the compile-time `Record` remains the source of truth.
    const allCodes: OperationFault['code'][] = [
      'Unauthorized',
      'Forbidden',
      'NotFound',
      'Conflict',
      'Unprocessable',
      'Timeout',
      'RateLimited',
      'NotImplemented',
      'UnsupportedTransport',
      'SubscriptionOverflow',
      'InvalidParams',
      'MethodNotFound',
      'EngineFailure',
    ];
    for (const code of allCodes) {
      const fault = classifyEngineError({ code, message: 'm', data: {} });
      expect(fault.code).toBe(code);
    }
  });
});

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
          seen['inheritedPolluted'] = (input as Record<string, unknown>)['polluted'];
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
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('catches schema refinements/transforms that throw', async () => {
    const throwingSchema = z.object({ id: z.string() }).refine((input) => {
      if (input.id === 'boom') throw new Error('refinement secret detail');
      return true;
    });
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.schemathrows',
        inputSchema: throwingSchema as unknown as z.ZodType,
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

  it('rejects malformed authorize hook return values', async () => {
    // Operation that returns undefined from its hook (simulating a buggy
    // implementation). Spread separately to dodge optional-property
    // contravariance under exactOptionalPropertyTypes.
    const op = {
      ...makeOp({
        name: 'weft.test.badhook',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => ({}),
        access: { kind: 'authenticated' },
      }),
      authorize: async () => undefined,
    } as unknown as ErasedOperation;
    const registry = createOperationRegistry([op]);
    const result = await executeOperation(
      'weft.test.badhook',
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
  });

  it('output that violates outputSchema does not leak secret fields', async () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.test.badoutput',
        inputSchema: z.object({}),
        outputSchema: z.object({ public: z.string() }).strict(),
        invoke: async () => ({ public: 'ok', secret: 'hunter2' }) as unknown as { public: string },
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
});

describe('createOperationRegistry', () => {
  it('rejects duplicate operation names at construction time', () => {
    const op1 = makeOp({
      name: 'weft.test.dup',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
    });
    const op2 = makeOp({
      name: 'weft.test.dup',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
    });
    expect(() => createOperationRegistry([op1, op2])).toThrow(/duplicate operation name/i);
  });

  it('lookup returns undefined for unknown names (executeOperation handles the fault)', () => {
    const registry = createOperationRegistry([]);
    expect(registry.get('weft.unknown')).toBeUndefined();
  });

  it('rejects operations whose inputSchema is not a z.ZodObject', () => {
    const op = makeOp({
      name: 'weft.test.notobject',
      // A string schema isn't an object — unknown-key policy can't apply.
      inputSchema: z.string() as unknown as z.ZodType,
      outputSchema: z.object({}),
      invoke: async () => ({}),
    });
    expect(() => createOperationRegistry([op])).toThrow(/must be a z\.ZodObject/);
  });

  it('rejects operations whose inputSchema declares unsafe top-level keys', () => {
    // The runtime UNSAFE_PROTOTYPE_KEYS filter only inspects UNKNOWN keys
    // (the unknown-key-policy step). A schema author could otherwise
    // declare `__proto__` as a legitimate field and bypass that filter.
    // The registry must reject such schemas at construction time.
    for (const unsafe of ['__proto__', 'constructor', 'prototype']) {
      const op = makeOp({
        name: `weft.test.unsafe.${unsafe.replace(/[^a-z]/g, '')}`,
        inputSchema: z.object({ [unsafe]: z.string() }),
        outputSchema: z.object({}),
        invoke: async () => ({}),
      });
      expect(() => createOperationRegistry([op])).toThrow(/unsafe top-level keys/);
    }
  });

  it('list returns all operations in registration order', () => {
    const op1 = makeOp({
      name: 'weft.test.a',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
    });
    const op2 = makeOp({
      name: 'weft.test.b',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
    });
    const registry = createOperationRegistry([op1, op2]);
    expect(registry.list().map((op) => op.name)).toEqual(['weft.test.a', 'weft.test.b']);
  });
});
