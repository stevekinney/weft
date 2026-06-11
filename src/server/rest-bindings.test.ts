/**
 * REST_BINDINGS registry invariants.
 *
 * Tests the structural invariants the HTTP router relies on:
 *
 *   - No two bindings may share `(method, path)` — that would make
 *     routing ambiguous.
 *   - Every binding's `operationName` must match the `weft.x.y` naming
 *     form enforced by the operation registry.
 *   - `pathParamNames` must agree with the `:name` tokens in `path`.
 *
 * An empty registry satisfies every invariant by construction, and the
 * live registry assertion keeps the route table and operation factory
 * aligned.
 */

import { describe, expect, it } from 'bun:test';

import { isValidOperationName } from './operation-registry.ts';
import { REST_BINDINGS, createLiveOperationRegistry } from './rest-bindings.ts';

describe('REST_BINDINGS', () => {
  it('has no duplicate (method, path) entries', () => {
    const seen = new Set<string>();
    for (const binding of REST_BINDINGS) {
      const key = `${binding.method} ${binding.path}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('references operation names that match the weft.x.y naming rule', () => {
    for (const binding of REST_BINDINGS) {
      expect(isValidOperationName(binding.operationName)).toBe(true);
    }
  });

  it('keeps pathParamNames aligned with the :name tokens in path', () => {
    for (const binding of REST_BINDINGS) {
      const tokenParamNames = binding.path
        .split('/')
        .filter((segment) => segment.startsWith(':'))
        .map((segment) => segment.slice(1));
      expect([...binding.pathParamNames]).toEqual(tokenParamNames);
    }
  });
});

describe('createLiveOperationRegistry', () => {
  it('registers every operation referenced by REST_BINDINGS', () => {
    const registry = createLiveOperationRegistry();
    for (const binding of REST_BINDINGS) {
      // Without this, a binding could be added to REST_BINDINGS but
      // omitted from the factory — every request to that route would
      // fail with MethodNotFound in production.
      expect(registry.get(binding.operationName)).toBeDefined();
    }
  });

  it('returns a fresh registry on each call (state isolation)', () => {
    const a = createLiveOperationRegistry();
    const b = createLiveOperationRegistry();
    expect(a).not.toBe(b);
    // Both must resolve the same canonical operation.
    expect(a.get('weft.workflows.get')).toBeDefined();
    expect(b.get('weft.workflows.get')).toBeDefined();
  });
});
