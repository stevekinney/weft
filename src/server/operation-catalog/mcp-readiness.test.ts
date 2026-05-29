import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createOperationRegistry } from '../operation-catalog.ts';
import { defineOperation } from '../operation-registry.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';

/**
 * Schema-readiness check that the live registry test exercises against
 * each cataloged operation. Extracted so the fixture-level tests below can
 * exercise the same logic directly against synthetic operations and
 * verify both pass and fail paths.
 *
 * The intent: an MCP-exposable operation must declare a real shape — either
 * named properties OR a strict-no-unknown-keys empty object that explicitly
 * accepts no input. The opt-in `z.object({}).passthrough()` default fails.
 */
function isInputSchemaNonTrivial(inputSchema: unknown): boolean {
  if (!(inputSchema instanceof z.ZodObject)) return false;
  const objectSchema = inputSchema;
  const shape = objectSchema.shape as Record<string, unknown>;
  if (Object.keys(shape).length > 0) return true;
  // Zod 4 represents the `.strict()` mode as a `catchall` of `z.never()`.
  const def = objectSchema._def as { catchall?: unknown };
  return def.catchall instanceof z.ZodNever;
}

describe('mcpExposable ratchet', () => {
  it('every operation has an explicit mcpExposable boolean (not undefined)', () => {
    const registry = createLiveOperationRegistry();
    for (const operation of registry.list()) {
      expect(typeof operation.mcpExposable).toBe('boolean');
    }
  });

  it('all v1 operations are mcpExposable: false', () => {
    const registry = createLiveOperationRegistry();
    for (const operation of registry.list()) {
      expect(operation.mcpExposable).toBe(false);
    }
  });

  it('operations with mcpExposable: true must have a non-trivial inputSchema', () => {
    const registry = createLiveOperationRegistry();
    for (const operation of registry.list()) {
      if (!operation.mcpExposable) continue;
      expect(isInputSchemaNonTrivial(operation.inputSchema)).toBe(true);
    }
  });

  describe('schema-readiness fixtures', () => {
    // The third live-registry test above iterates only over operations
    // whose `mcpExposable` is truthy. In v1 there are none, so the
    // assertion never runs against real data. These fixture-level tests
    // exercise the readiness logic directly against synthetic operations
    // so the ratchet has both pass and fail coverage today; when the
    // first operation flips `mcpExposable: true` in the future the live
    // suite will exercise the same predicate against real schemas.

    it('accepts an mcpExposable: true operation with explicit fields', () => {
      const operation = defineOperation({
        name: 'weft.test.mcpexposablepass',
        summary: 'fixture',
        mcpExposable: true,
        destructive: false,
        mcpTool: { workflowType: 'fixture-workflow' },
        inputSchema: z.object({ field: z.string() }),
        outputSchema: z.object({}),
        access: { kind: 'public' },
        transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
        unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
        invoke: async () => ({}),
      });

      expect(isInputSchemaNonTrivial(operation.inputSchema)).toBe(true);
    });

    it('accepts an mcpExposable: true operation with strict-unknown-keys empty object schema', () => {
      const operation = defineOperation({
        name: 'weft.test.mcpexposablestrict',
        summary: 'fixture',
        mcpExposable: true,
        destructive: false,
        mcpTool: { workflowType: 'fixture-workflow' },
        inputSchema: z.object({}).strict(),
        outputSchema: z.object({}),
        access: { kind: 'public' },
        transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
        unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
        invoke: async () => ({}),
      });

      expect(isInputSchemaNonTrivial(operation.inputSchema)).toBe(true);
    });

    it('rejects an mcpExposable: true operation that uses the opt-in passthrough default', () => {
      const operation = defineOperation({
        name: 'weft.test.mcpexposablefail',
        summary: 'fixture',
        mcpExposable: true,
        destructive: false,
        mcpTool: { workflowType: 'fixture-workflow' },
        // The opt-in default — fields wide-open, no declared shape. An
        // MCP-exposed operation must declare its actual contract.
        inputSchema: z.object({}).passthrough(),
        outputSchema: z.object({}),
        access: { kind: 'public' },
        transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
        unknownKeyPolicy: { http: 'passthrough', jsonRpc: 'passthrough' },
        invoke: async () => ({}),
      });

      expect(isInputSchemaNonTrivial(operation.inputSchema)).toBe(false);
    });

    it('rejects an mcpExposable: true operation without workflow tool metadata', () => {
      const operation = defineOperation({
        name: 'weft.test.mcpexposablemissingmetadata',
        summary: 'fixture',
        mcpExposable: true,
        destructive: false,
        inputSchema: z.object({ field: z.string() }),
        outputSchema: z.object({}),
        access: { kind: 'public' },
        transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
        unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
        invoke: async () => ({}),
      });

      expect(() => createOperationRegistry([operation])).toThrow(/mcpTool\.workflowType/);
    });
  });
});
