import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { isDiscoverable } from './discovery-filter.ts';
import type { ErasedOperation } from './operation-catalog.ts';

function operation(overrides: Partial<ErasedOperation>): ErasedOperation {
  // Test-only cast: invoke parameter variance is intentionally relaxed in test fixtures.
  return {
    name: 'weft.test.discovery',
    summary: 'test operation',
    tags: [],
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    access: { kind: 'public' },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    invoke: async () => ({}),
    ...overrides,
  } as ErasedOperation;
}

describe('isDiscoverable', () => {
  it('includes public operations by default', () => {
    expect(isDiscoverable(operation({ access: { kind: 'public' } }))).toBe(true);
  });

  it('keeps public operations discoverable even when discoverable is false', () => {
    // Deliberate: public-access operations cannot opt out of discovery.
    // This prevents "stealth public APIs" that accept requests but hide from clients.
    // If an operation must be undiscoverable, it must use a non-public access policy.
    expect(isDiscoverable(operation({ access: { kind: 'public' }, discoverable: false }))).toBe(
      true,
    );
  });

  it('includes scoped operations that explicitly opt in', () => {
    expect(
      isDiscoverable(
        operation({
          access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['workflows:read'] } },
          discoverable: true,
        }),
      ),
    ).toBe(true);
  });

  it('excludes scoped operations by default', () => {
    expect(
      isDiscoverable(
        operation({
          access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['workflows:read'] } },
        }),
      ),
    ).toBe(false);
  });

  it('excludes authenticated operations by default', () => {
    expect(isDiscoverable(operation({ access: { kind: 'authenticated' } }))).toBe(false);
  });
});
