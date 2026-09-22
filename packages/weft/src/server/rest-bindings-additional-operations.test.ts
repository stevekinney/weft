import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { defineOperation } from './operation-registry.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';

/**
 * A stand-in for `operative.runs.events` or `bureau.events`: an operation
 * declared outside this package, in a namespace the name pattern admits only
 * because it stopped requiring `weft.`.
 */
const foreignOperation = defineOperation({
  name: 'operative.runs.probe',
  mcpExposable: false,
  summary: 'probe',
  destructive: false,
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  access: { kind: 'public' as const },
  transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'reject' as const, jsonRpc: 'reject' as const },
  invoke: async () => ({ ok: true }),
});

describe('createLiveOperationRegistry with additional operations', () => {
  it('serves Weft’s own catalog unchanged when none are supplied', () => {
    const registry = createLiveOperationRegistry();

    expect(registry.get('operative.runs.probe')).toBeUndefined();
    expect(registry.list().length).toBeGreaterThan(0);
  });

  it('registers a foreign operation alongside Weft’s', () => {
    const baseline = createLiveOperationRegistry().list().length;

    const registry = createLiveOperationRegistry({ additionalOperations: [foreignOperation] });

    expect(registry.get('operative.runs.probe')).toBeDefined();
    expect(registry.list()).toHaveLength(baseline + 1);
    // Weft's own operations are still there — appending must not replace.
    expect(registry.get('weft.workflows.events')).toBeDefined();
  });

  it('refuses a foreign operation that shadows one of Weft’s', () => {
    // Construction-time and synchronous, so a host learns before it binds a
    // port rather than when a caller reaches the wrong implementation.
    const shadow = defineOperation({
      name: 'weft.workflows.events',
      mcpExposable: false,
      summary: 'shadow',
      destructive: false,
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      access: { kind: 'public' as const },
      transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject' as const, jsonRpc: 'reject' as const },
      invoke: async () => ({}),
    });

    expect(() => createLiveOperationRegistry({ additionalOperations: [shadow] })).toThrow(
      /duplicate operation name/,
    );
  });

  it('refuses a foreign operation whose name the catalog does not admit', () => {
    // `rpc.` stays reserved for JSON-RPC's own methods whoever declares it.
    const reserved = {
      ...foreignOperation,
      name: 'rpc.discover',
    } as typeof foreignOperation;

    expect(() => createLiveOperationRegistry({ additionalOperations: [reserved] })).toThrow(
      /operation name/,
    );
  });
});
