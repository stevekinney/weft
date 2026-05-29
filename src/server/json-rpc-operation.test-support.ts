/**
 * Shared operation factory for JSON-RPC transport tests.
 *
 * The transport-neutral dispatcher and the HTTP / stdio adapters all need to
 * register `ErasedOperation`s with permissive defaults. This factory builds one
 * from the required `name`/schemas/`invoke` plus any per-test overrides, so each
 * suite keeps its operation name and behavior visible at the call site while the
 * boilerplate defaults live in one place.
 */

import type { z } from 'zod';

import { type ErasedOperation, type OperationDefinition } from './operation-catalog.ts';

/**
 * Build an `ErasedOperation` with permissive defaults for transport tests.
 *
 * Defaults all metadata (`summary`, `tags`, `access`, `transports`,
 * `unknownKeyPolicy`, `mcpExposable`) so a test only supplies the parts it
 * exercises. Any field may be overridden, including `transports` for suites
 * that pin a single transport.
 */
export function makeOperation<I, O>(
  overrides: Partial<OperationDefinition<I, O>> & {
    name: string;
    inputSchema: z.ZodType<I>;
    outputSchema: z.ZodType<O>;
    invoke: OperationDefinition<I, O>['invoke'];
  },
): ErasedOperation {
  return {
    mcpExposable: false,
    destructive: false,
    summary: 'test op',
    tags: [],
    access: { kind: 'public' },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    ...overrides,
    // Test-only: defaults plus overrides cover every required field, but the
    // generic Input/Output cannot be reconciled with the erased shape without a
    // cast. Trusted construction in test support.
  } as unknown as ErasedOperation;
}
