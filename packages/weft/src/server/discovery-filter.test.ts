import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AccessPolicy } from './authorization.ts';
import { isDiscoverable } from './discovery-filter.ts';
import { makeOperation } from './json-rpc-operation.test-support.ts';

type DiscoveryOverrides = {
  readonly access?: AccessPolicy;
  readonly discoverable?: boolean;
};

function operation(overrides: DiscoveryOverrides) {
  return makeOperation({
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
  });
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
