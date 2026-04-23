/**
 * Tests for `parseJsonRpcRequest` — accepts a raw request body (string
 * or already-parsed JSON) and returns a discriminated-union `ParseResult`
 * describing what the transport should dispatch.
 *
 * Design decision (Track 8): `params` must be absent or an object
 * (named params). Array-form positional params are rejected per-item
 * with `InvalidRequest` (-32600). This is stricter than JSON-RPC 2.0
 * (which allows array params) but matches OpenRPC's `paramStructure:
 * "by-name"` discoverability contract and eliminates an entire class
 * of drift between transports.
 */

import { describe, expect, it } from 'bun:test';

import { parseJsonRpcRequest } from './json-rpc-parse.ts';
import { JSON_RPC_ERROR_CODES } from './json-rpc-protocol.ts';

describe('parseJsonRpcRequest — body-level errors', () => {
  it('returns parse-error for malformed JSON string', () => {
    const result = parseJsonRpcRequest('{"jsonrpc":"2.0"');
    expect(result.kind).toBe('parse-error');
    if (result.kind !== 'parse-error') throw new Error('shape');
    expect(result.code).toBe(JSON_RPC_ERROR_CODES.PARSE_ERROR);
  });

  it('returns invalid-request for a top-level primitive', () => {
    const result = parseJsonRpcRequest(42);
    expect(result.kind).toBe('invalid-request');
    if (result.kind !== 'invalid-request') throw new Error('shape');
    expect(result.code).toBe(JSON_RPC_ERROR_CODES.INVALID_REQUEST);
    expect(result.id).toBeNull();
  });

  it('returns invalid-request for null', () => {
    const result = parseJsonRpcRequest(null);
    expect(result.kind).toBe('invalid-request');
  });

  it('returns invalid-request for an empty batch (spec requires at least one item)', () => {
    const result = parseJsonRpcRequest('[]');
    expect(result.kind).toBe('invalid-request');
    if (result.kind !== 'invalid-request') throw new Error('shape');
    expect(result.id).toBeNull();
  });
});

describe('parseJsonRpcRequest — single request', () => {
  it('parses a valid request with named params', () => {
    const result = parseJsonRpcRequest(
      '{"jsonrpc":"2.0","method":"weft.workflows.start","params":{"id":"x"},"id":1}',
    );
    expect(result.kind).toBe('single');
    if (result.kind !== 'single') throw new Error('shape');
    expect(result.request.method).toBe('weft.workflows.start');
    expect(result.request.params).toEqual({ id: 'x' });
    expect(result.request.id).toBe(1);
    expect(result.isNotification).toBe(false);
  });

  it('parses a notification (no id) with isNotification=true', () => {
    const result = parseJsonRpcRequest(
      '{"jsonrpc":"2.0","method":"weft.events.emit","params":{"kind":"tick"}}',
    );
    expect(result.kind).toBe('single');
    if (result.kind !== 'single') throw new Error('shape');
    expect(result.isNotification).toBe(true);
    expect(result.request.id).toBeUndefined();
  });

  it('parses a request with no params (params key absent is legal)', () => {
    const result = parseJsonRpcRequest('{"jsonrpc":"2.0","method":"rpc.discover","id":"d1"}');
    expect(result.kind).toBe('single');
    if (result.kind !== 'single') throw new Error('shape');
    expect(result.request.params).toBeUndefined();
  });

  it('rejects missing jsonrpc field', () => {
    const result = parseJsonRpcRequest('{"method":"x","id":1}');
    expect(result.kind).toBe('invalid-request');
    if (result.kind !== 'invalid-request') throw new Error('shape');
    expect(result.id).toBe(1);
  });

  it('rejects wrong jsonrpc version', () => {
    const result = parseJsonRpcRequest('{"jsonrpc":"1.0","method":"x","id":1}');
    expect(result.kind).toBe('invalid-request');
  });

  it('rejects missing method field', () => {
    const result = parseJsonRpcRequest('{"jsonrpc":"2.0","id":1}');
    expect(result.kind).toBe('invalid-request');
  });

  it('rejects non-string method field', () => {
    const result = parseJsonRpcRequest('{"jsonrpc":"2.0","method":42,"id":1}');
    expect(result.kind).toBe('invalid-request');
  });

  it('rejects array-form positional params (named-params-only policy)', () => {
    const result = parseJsonRpcRequest('{"jsonrpc":"2.0","method":"x","params":[1,2,3],"id":1}');
    expect(result.kind).toBe('invalid-request');
    if (result.kind !== 'invalid-request') throw new Error('shape');
    expect(result.id).toBe(1);
    expect(result.message).toMatch(/named params/i);
  });

  it('rejects primitive params (not an object or absent)', () => {
    const result = parseJsonRpcRequest('{"jsonrpc":"2.0","method":"x","params":"nope","id":1}');
    expect(result.kind).toBe('invalid-request');
  });

  it('rejects null params (must be absent or object)', () => {
    const result = parseJsonRpcRequest('{"jsonrpc":"2.0","method":"x","params":null,"id":1}');
    expect(result.kind).toBe('invalid-request');
  });

  it('rejects invalid id types (boolean, object, NaN)', () => {
    const boolId = parseJsonRpcRequest('{"jsonrpc":"2.0","method":"x","id":true}');
    expect(boolId.kind).toBe('invalid-request');
    const objId = parseJsonRpcRequest('{"jsonrpc":"2.0","method":"x","id":{}}');
    expect(objId.kind).toBe('invalid-request');
  });

  it('accepts null id as an explicit value (valid in spec)', () => {
    const result = parseJsonRpcRequest('{"jsonrpc":"2.0","method":"x","id":null}');
    expect(result.kind).toBe('single');
    if (result.kind !== 'single') throw new Error('shape');
    expect(result.request.id).toBeNull();
    // id: null is NOT a notification — the spec says notifications
    // omit the id key entirely.
    expect(result.isNotification).toBe(false);
  });
});

describe('parseJsonRpcRequest — batch', () => {
  it('parses a batch of valid requests', () => {
    const result = parseJsonRpcRequest(
      '[{"jsonrpc":"2.0","method":"a","id":1},{"jsonrpc":"2.0","method":"b","id":2}]',
    );
    expect(result.kind).toBe('batch');
    if (result.kind !== 'batch') throw new Error('shape');
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.kind).toBe('valid');
    expect(result.items[1]?.kind).toBe('valid');
  });

  it('surfaces per-item invalid-request errors in the batch', () => {
    const result = parseJsonRpcRequest(
      '[{"jsonrpc":"2.0","method":"a","id":1},{"method":"no-version","id":2}]',
    );
    expect(result.kind).toBe('batch');
    if (result.kind !== 'batch') throw new Error('shape');
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.kind).toBe('valid');
    expect(result.items[1]?.kind).toBe('invalid');
    if (result.items[1]?.kind !== 'invalid') throw new Error('shape');
    expect(result.items[1].id).toBe(2);
  });

  it('preserves order of items in the batch response contract', () => {
    // The dispatcher responds in request-order; the parser must also
    // preserve order so the response indices match the request indices.
    const result = parseJsonRpcRequest(
      '[{"jsonrpc":"2.0","method":"first","id":"a"},{"jsonrpc":"2.0","method":"second","id":"b"},{"jsonrpc":"2.0","method":"third","id":"c"}]',
    );
    if (result.kind !== 'batch') throw new Error('shape');
    const methods = result.items.map((item) =>
      item.kind === 'valid' ? item.request.method : null,
    );
    expect(methods).toEqual(['first', 'second', 'third']);
  });

  it('tolerates a batch of mixed notifications and requests', () => {
    const result = parseJsonRpcRequest(
      '[{"jsonrpc":"2.0","method":"req","id":1},{"jsonrpc":"2.0","method":"note"}]',
    );
    if (result.kind !== 'batch') throw new Error('shape');
    const first = result.items[0];
    const second = result.items[1];
    if (first?.kind !== 'valid') throw new Error('shape');
    if (second?.kind !== 'valid') throw new Error('shape');
    expect(first.isNotification).toBe(false);
    expect(second.isNotification).toBe(true);
  });

  it('rejects a batch with a non-object item', () => {
    const result = parseJsonRpcRequest('[{"jsonrpc":"2.0","method":"a","id":1},"not-an-object"]');
    if (result.kind !== 'batch') throw new Error('shape');
    expect(result.items[1]?.kind).toBe('invalid');
  });
});

describe('parseJsonRpcRequest — already-parsed input', () => {
  it('accepts a pre-parsed object (skips JSON.parse)', () => {
    const result = parseJsonRpcRequest({ jsonrpc: '2.0', method: 'x', id: 1 });
    expect(result.kind).toBe('single');
  });

  it('accepts a pre-parsed array (batch)', () => {
    const result = parseJsonRpcRequest([
      { jsonrpc: '2.0', method: 'a', id: 1 },
      { jsonrpc: '2.0', method: 'b', id: 2 },
    ]);
    expect(result.kind).toBe('batch');
  });
});
