/**
 * Phase 15 — REST_BINDINGS registry invariants.
 *
 * Tests the structural invariants the HTTP router relies on:
 *
 *   - No two bindings may share `(method, path)` — that would make
 *     routing ambiguous.
 *   - Every binding's `operationName` must match the `weft.x.y` naming
 *     form enforced by the operation registry.
 *   - `pathParamNames` must agree with the `:name` tokens in `path`.
 *
 * An empty registry satisfies every invariant by construction; the
 * suite still runs so Phase 15c's first migration immediately exercises
 * the guards without having to re-derive them.
 */

import { describe, expect, it } from 'bun:test';

import { isValidOperationName } from './operation-registry.ts';
import { REST_BINDINGS } from './rest-bindings.ts';

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
