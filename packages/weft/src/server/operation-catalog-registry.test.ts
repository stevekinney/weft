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
import { createOperationRegistry } from './operation-catalog.ts';

async function* registryEventFixture() {
  yield { chunk: 'a' };
}

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

  it('rejects operations whose inputSchema is not a z.ZodObject', () => {
    const base = makeOp({
      name: 'weft.test.notobject',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
    });
    const malformed = Object.assign({}, base, { inputSchema: z.string() });
    expect(() => Reflect.apply(createOperationRegistry, undefined, [[malformed]])).toThrow(
      /must be a z\.ZodObject/,
    );
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

  describe('kind / eventSchema invariants', () => {
    // Closes a Codex finding from round 3: the discriminated union on
    // OperationDefinition prevents callers using `defineOperation` from
    // declaring a streaming op without `eventSchema`, but a hand-rolled
    // RegistrableOperation literal can bypass that check. The registry
    // must reject the malformed shape at construction so the failure
    // surfaces immediately, not on the first request.

    it('accepts kind: stream with eventSchema', () => {
      const wellFormed = makeOp({
        name: 'weft.test.streamok',
        kind: 'stream',
        eventSchema: z.object({ chunk: z.string() }),
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => registryEventFixture(),
      });
      expect(() => createOperationRegistry([wellFormed])).not.toThrow();
    });

    it('rejects kind: stream without eventSchema', () => {
      const base = makeOp({
        name: 'weft.test.streamnoschema',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => ({}),
      });
      const malformed = Object.assign({}, base, { kind: 'stream' as const });
      expect(() => Reflect.apply(createOperationRegistry, undefined, [[malformed]])).toThrow(
        /kind: 'stream'.*no eventSchema/,
      );
    });

    it('rejects kind: subscription without eventSchema', () => {
      const base = makeOp({
        name: 'weft.test.subscriptionnoschema',
        inputSchema: z.object({}),
        outputSchema: z.object({ subscriptionId: z.string(), cursor: z.string() }),
        invoke: async () => ({ subscriptionId: 'unused', cursor: 'unused' }),
      });
      const malformed = Object.assign({}, base, { kind: 'subscription' as const });
      expect(() => Reflect.apply(createOperationRegistry, undefined, [[malformed]])).toThrow(
        /kind: 'subscription'.*no eventSchema/,
      );
    });

    it('rejects kind: unary with an eventSchema (or kind absent + eventSchema)', () => {
      const base = makeOp({
        name: 'weft.test.unarywitheventschema',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        invoke: async () => ({}),
      });
      const malformed = Object.assign({}, base, { eventSchema: z.unknown() });
      expect(() => Reflect.apply(createOperationRegistry, undefined, [[malformed]])).toThrow(
        /kind: 'unary'.*declares an eventSchema/,
      );
    });
  });
});
