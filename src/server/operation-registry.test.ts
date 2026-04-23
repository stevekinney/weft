/**
 * Tests for `validateOperationName` and the `defineOperation` typed builder.
 *
 * Phase 4 supplied the registry constructor (`createOperationRegistry`) and
 * the dispatch pipeline (`executeOperation`). Phase 5 adds the JSON-RPC
 * naming-convention validator the OpenRPC generator depends on, and a
 * type-safe builder so callers can construct individual operations without
 * the `as unknown as ErasedOperation` cast that the registry boundary
 * required for storage.
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createOperationRegistry } from './operation-catalog.ts';
import {
  defineOperation,
  isValidOperationName,
  validateOperationName,
} from './operation-registry.ts';

describe('validateOperationName', () => {
  it('accepts the canonical weft.<domain>.<action> shape', () => {
    expect(() => validateOperationName('weft.workflows.start')).not.toThrow();
    expect(() => validateOperationName('weft.schedules.list')).not.toThrow();
    expect(() => validateOperationName('weft.events.deliver')).not.toThrow();
  });

  it('accepts deeper namespaces (weft.workflows.signals.list)', () => {
    expect(() => validateOperationName('weft.workflows.signals.list')).not.toThrow();
  });

  it('rejects names without the weft prefix', () => {
    expect(() => validateOperationName('workflows.start')).toThrow(/operation name/);
    expect(() => validateOperationName('myapp.workflows.start')).toThrow(/operation name/);
  });

  it('rejects names with only one segment after the weft prefix', () => {
    // Both `weft.workflows` and `weft.start` lack the second segment
    // required by `(?:\.[a-z][a-z0-9]*)+`. The earlier wording of this
    // test ("no dots after weft") was factually wrong — there IS a dot,
    // just not enough segments.
    expect(() => validateOperationName('weft.workflows')).toThrow(/operation name/);
    expect(() => validateOperationName('weft.start')).toThrow(/operation name/);
  });

  it('accepts segments with trailing digits and single-letter segments', () => {
    // Segments may continue with lowercase ASCII letters or digits after
    // the first character. Single-letter segments are allowed because
    // the regex requires at least one letter, not at least two.
    expect(() => validateOperationName('weft.workflows.list2')).not.toThrow();
    expect(() => validateOperationName('weft.workflows.signal2.start')).not.toThrow();
    expect(() => validateOperationName('weft.w.start')).not.toThrow();
  });

  it('rejects segments that start with a digit', () => {
    // The character class is `[a-z][a-z0-9]*` — the first character of
    // each segment MUST be a lowercase letter.
    expect(() => validateOperationName('weft.2start.action')).toThrow(/operation name/);
    expect(() => validateOperationName('weft.workflows.2start')).toThrow(/operation name/);
  });

  it('rejects uppercase, dashes, or underscores', () => {
    expect(() => validateOperationName('weft.Workflows.start')).toThrow(/operation name/);
    expect(() => validateOperationName('weft.workflows.start-here')).toThrow(/operation name/);
    expect(() => validateOperationName('weft.workflows.start_here')).toThrow(/operation name/);
  });

  it('rejects empty string and bare prefixes', () => {
    expect(() => validateOperationName('')).toThrow(/operation name/);
    expect(() => validateOperationName('weft')).toThrow(/operation name/);
    expect(() => validateOperationName('weft.')).toThrow(/operation name/);
  });

  it('rejects trailing or leading dots', () => {
    expect(() => validateOperationName('weft.workflows.start.')).toThrow(/operation name/);
    expect(() => validateOperationName('.weft.workflows.start')).toThrow(/operation name/);
  });

  it('rejects empty segments (consecutive dots)', () => {
    expect(() => validateOperationName('weft..start')).toThrow(/operation name/);
    expect(() => validateOperationName('weft.workflows..start')).toThrow(/operation name/);
  });
});

describe('isValidOperationName (non-throwing variant)', () => {
  it('returns true for valid names', () => {
    expect(isValidOperationName('weft.workflows.start')).toBe(true);
  });

  it('returns false for invalid names', () => {
    expect(isValidOperationName('workflows.start')).toBe(false);
    expect(isValidOperationName('')).toBe(false);
  });
});

describe('defineOperation + createOperationRegistry (compile-time interop)', () => {
  it('passes a typed defineOperation result into createOperationRegistry without a cast', () => {
    // This test asserts at COMPILE TIME that the registry accepts the typed
    // builder's return value directly. If TypeScript ever requires an
    // `as unknown as ErasedOperation` cast at the call site, that's a
    // regression of the variance trick in createOperationRegistry's signature.
    const op = defineOperation({
      name: 'weft.test.echo',
      summary: 'echo',
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
      access: { kind: 'public' },
      transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async ({ input }) => ({ echoed: input.value }),
    });
    // No cast on the array literal — variance trick must let this compile.
    const registry = createOperationRegistry([op]);
    expect(registry.get('weft.test.echo')).toBeDefined();
  });

  it('rejects an operation with an invalid name at registry assembly (defense in depth)', () => {
    // Construct an erased operation that bypasses defineOperation's name
    // validation, then assert the registry catches it. Phase 5 added this
    // check so manual / pre-erased entries can't slip past OpenRPC and
    // JSON-RPC dispatch.
    const sneaky = {
      name: 'BadName',
      summary: 's',
      tags: [],
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      access: { kind: 'public' },
      transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => ({}),
    } as unknown as Parameters<typeof createOperationRegistry>[0][number];
    expect(() => createOperationRegistry([sneaky])).toThrow(/operation name/);
  });
});

describe('defineOperation (typed builder)', () => {
  it('returns a fully-typed OperationDefinition with sensible defaults', () => {
    const op = defineOperation({
      name: 'weft.test.echo',
      summary: 'echo the input',
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
      access: { kind: 'public' },
      transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async ({ input }) => ({ echoed: input.value }),
    });
    expect(op.name).toBe('weft.test.echo');
    expect(op.tags).toEqual([]);
    expect(op.summary).toBe('echo the input');
  });

  it('validates the operation name at construction', () => {
    expect(() =>
      defineOperation({
        name: 'BadName',
        summary: 's',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        access: { kind: 'public' },
        transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
        unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
        invoke: async () => ({}),
      }),
    ).toThrow(/operation name/);
  });

  it('preserves tags when supplied', () => {
    const op = defineOperation({
      name: 'weft.test.tagged',
      summary: 's',
      tags: ['workflows', 'beta'],
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      access: { kind: 'public' },
      transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => ({}),
    });
    expect(op.tags).toEqual(['workflows', 'beta']);
  });

  it('defensively copies the tags array (caller mutation cannot affect stored op)', () => {
    const callerTags = ['workflows', 'beta'];
    const op = defineOperation({
      name: 'weft.test.tagscopy',
      summary: 's',
      tags: callerTags,
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      access: { kind: 'public' },
      transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => ({}),
    });
    callerTags.push('mutated');
    expect(op.tags).toEqual(['workflows', 'beta']);
    expect(op.tags).not.toBe(callerTags);
  });

  it('preserves the optional authorize hook when supplied', () => {
    const op = defineOperation({
      name: 'weft.test.authorized',
      summary: 's',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      access: { kind: 'authenticated' },
      transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      authorize: async () => ({ allowed: true }),
      invoke: async () => ({}),
    });
    expect(typeof op.authorize).toBe('function');
  });

  it('deep-copies the access policy so nested scopes array is isolated', () => {
    // Bugbot regression: `{ ...input.access }` was shallow, leaving
    // `scoped`/`optionalAuth` policies with their nested ScopeRequirement
    // object AND scopes array aliased to the caller's reference. A
    // mutation of the caller's array between builder return and registry
    // insertion would silently change the operation's authorization
    // requirements.
    const callerScopes: [string, ...string[]] = ['workflows:read'];
    const op = defineOperation({
      name: 'weft.test.scopedcopy',
      summary: 's',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      access: {
        kind: 'scoped',
        scopes: { kind: 'anyOf', scopes: callerScopes as ['workflows:read'] },
      },
      transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => ({}),
    });
    callerScopes.push('workflows:write');
    if (op.access.kind !== 'scoped') throw new Error('expected scoped');
    expect(op.access.scopes.scopes).toEqual(['workflows:read']);
    expect(op.access.scopes.scopes).not.toBe(callerScopes);
  });

  it('deep-copies optionalAuth authenticatedScopes too', () => {
    // Mirror coverage for the `optionalAuth` variant — same aliasing
    // risk, same fix.
    const callerScopes: [string, ...string[]] = ['workflows:write'];
    const op = defineOperation({
      name: 'weft.test.optauthcopy',
      summary: 's',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      access: {
        kind: 'optionalAuth',
        authenticatedScopes: {
          kind: 'allOf',
          scopes: callerScopes as ['workflows:write'],
        },
      },
      transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => ({}),
    });
    callerScopes.push('schedules:write');
    if (op.access.kind !== 'optionalAuth') throw new Error('expected optionalAuth');
    expect(op.access.authenticatedScopes.scopes).toEqual(['workflows:write']);
    expect(op.access.authenticatedScopes.scopes).not.toBe(callerScopes);
  });
});
