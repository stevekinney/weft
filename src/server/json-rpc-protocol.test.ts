/**
 * Tests for JSON-RPC 2.0 protocol constants and shared types.
 *
 * This module defines the wire-level error codes, request/response
 * shapes, and id-type helpers that both the parser (Phase 8), the
 * dispatcher (Phase 8), and the transport adapters (Phases 11-13)
 * share. It is the single source of truth for "what the JSON-RPC wire
 * looks like" in this codebase.
 */

import { describe, expect, it } from 'bun:test';

import {
  JSON_RPC_ERROR_CODES,
  JSON_RPC_VERSION,
  isValidJsonRpcId,
  type JsonRpcId,
} from './json-rpc-protocol.ts';

describe('JSON_RPC_VERSION', () => {
  it('is the literal "2.0" string the spec mandates', () => {
    expect(JSON_RPC_VERSION).toBe('2.0');
  });
});

describe('JSON_RPC_ERROR_CODES', () => {
  it('defines every reserved-by-spec error code at its spec value', () => {
    expect(JSON_RPC_ERROR_CODES.PARSE_ERROR).toBe(-32700);
    expect(JSON_RPC_ERROR_CODES.INVALID_REQUEST).toBe(-32600);
    expect(JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND).toBe(-32601);
    expect(JSON_RPC_ERROR_CODES.INVALID_PARAMS).toBe(-32602);
    expect(JSON_RPC_ERROR_CODES.INTERNAL_ERROR).toBe(-32603);
  });

  it('defines the Weft domain-error band at the plan-documented values', () => {
    // Values are pinned in the plan (Track 8 design decision 4 JSON-RPC
    // specifics section). Changing them is a wire-compat break.
    expect(JSON_RPC_ERROR_CODES.UNAUTHORIZED).toBe(-32010);
    expect(JSON_RPC_ERROR_CODES.FORBIDDEN).toBe(-32011);
    expect(JSON_RPC_ERROR_CODES.NOT_FOUND).toBe(-32020);
    expect(JSON_RPC_ERROR_CODES.CONFLICT).toBe(-32021);
    expect(JSON_RPC_ERROR_CODES.UNPROCESSABLE).toBe(-32022);
    expect(JSON_RPC_ERROR_CODES.TIMEOUT).toBe(-32023);
    expect(JSON_RPC_ERROR_CODES.RATE_LIMITED).toBe(-32024);
    expect(JSON_RPC_ERROR_CODES.NOT_IMPLEMENTED).toBe(-32025);
    expect(JSON_RPC_ERROR_CODES.UNSUPPORTED_TRANSPORT).toBe(-32030);
    expect(JSON_RPC_ERROR_CODES.SUBSCRIPTION_OVERFLOW).toBe(-32031);
    expect(JSON_RPC_ERROR_CODES.ENGINE_FAILURE).toBe(-32099);
  });

  it('is frozen so importers cannot mutate a shared constant', () => {
    expect(Object.isFrozen(JSON_RPC_ERROR_CODES)).toBe(true);
  });
});

describe('isValidJsonRpcId', () => {
  it('accepts strings', () => {
    expect(isValidJsonRpcId('abc')).toBe(true);
    expect(isValidJsonRpcId('')).toBe(true);
  });

  it('accepts finite numbers', () => {
    expect(isValidJsonRpcId(0)).toBe(true);
    expect(isValidJsonRpcId(-1)).toBe(true);
    expect(isValidJsonRpcId(42)).toBe(true);
    expect(isValidJsonRpcId(3.14)).toBe(true);
  });

  it('accepts null (spec allows null id for notifications that failed to parse)', () => {
    expect(isValidJsonRpcId(null)).toBe(true);
  });

  it('rejects NaN and Infinity (not finite, not a valid id)', () => {
    expect(isValidJsonRpcId(Number.NaN)).toBe(false);
    expect(isValidJsonRpcId(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidJsonRpcId(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it('rejects booleans, objects, arrays, undefined', () => {
    expect(isValidJsonRpcId(true)).toBe(false);
    expect(isValidJsonRpcId(false)).toBe(false);
    expect(isValidJsonRpcId({})).toBe(false);
    expect(isValidJsonRpcId([])).toBe(false);
    expect(isValidJsonRpcId(undefined)).toBe(false);
  });

  it('narrows the type to JsonRpcId on the success branch', () => {
    const value: unknown = 'hello';
    if (isValidJsonRpcId(value)) {
      // Type-system check: the narrowed `value` must be assignable to
      // `JsonRpcId`. Runtime assertion is redundant but pins the check.
      const id: JsonRpcId = value;
      expect(id).toBe('hello');
    } else {
      throw new Error('expected narrow');
    }
  });
});
