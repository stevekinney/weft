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

import { classifyEngineError } from './operation-catalog.ts';
import type { OperationFault } from './operation-fault.ts';

describe('classifyEngineError — producibleFaults enforcement', () => {
  it('strict mode: undeclared fault becomes EngineFailure with the diagnostic message', () => {
    // Default test environment is strict (NODE_ENV !== 'production').
    const fault: OperationFault = {
      code: 'NotFound',
      message: 'workflow "wf-1" not found',
      data: { resource: 'workflow' },
    };
    const result = classifyEngineError(fault, {
      name: 'weft.test.directthrow',
      // no producibleFaults declaration
    });
    expect(result.code).toBe('EngineFailure');
    expect(result.message).toContain('weft.test.directthrow');
    expect(result.message).toContain('NotFound');
  });

  it('strict mode: declared fault passes through unchanged', () => {
    const fault: OperationFault = {
      code: 'Conflict',
      message: 'workflow already exists',
      data: { reason: 'workflow already exists' },
    };
    const result = classifyEngineError(fault, {
      name: 'weft.test.declared',
      producibleFaults: ['Conflict'],
    });
    expect(result.code).toBe('Conflict');
    expect(result.message).toBe('workflow already exists');
  });

  it('strict mode: universal-default fault passes through unchanged without explicit declaration', () => {
    const fault: OperationFault = {
      code: 'Unauthorized',
      message: 'no token',
      data: { reason: 'no token' },
    };
    const result = classifyEngineError(fault, {
      name: 'weft.test.universal',
      // Unauthorized is in the universal-default set (Unauthorized,
      // Forbidden, InvalidParams, EngineFailure) — no declaration needed.
    });
    expect(result.code).toBe('Unauthorized');
  });

  it('production mode: undeclared fault preserved on the wire AND console.warn fires', () => {
    const originalNodeEnv = Bun.env['NODE_ENV'];
    const originalStrict = Bun.env['WEFT_STRICT_FAULTS'];
    Bun.env['NODE_ENV'] = 'production';
    delete Bun.env['WEFT_STRICT_FAULTS'];
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const fault: OperationFault = {
        code: 'Timeout',
        message: 'too slow',
        data: { operationName: 'weft.test.production' },
      };
      const result = classifyEngineError(fault, {
        name: 'weft.test.production',
      });
      // Production preserves the original fault on the wire so clients
      // keep their actionable semantics.
      expect(result.code).toBe('Timeout');
      expect(result.message).toBe('too slow');
      // ...AND the warning fires for monitoring.
      const matching = warnings.filter(
        (w) => w.includes('weft.test.production') && w.includes('Timeout'),
      );
      expect(matching).toHaveLength(1);
    } finally {
      console.warn = originalWarn;
      if (originalNodeEnv !== undefined) Bun.env['NODE_ENV'] = originalNodeEnv;
      else delete Bun.env['NODE_ENV'];
      if (originalStrict !== undefined) Bun.env['WEFT_STRICT_FAULTS'] = originalStrict;
    }
  });

  it('WEFT_STRICT_FAULTS=1 forces strict behavior even when NODE_ENV=production', () => {
    const originalNodeEnv = Bun.env['NODE_ENV'];
    const originalStrict = Bun.env['WEFT_STRICT_FAULTS'];
    Bun.env['NODE_ENV'] = 'production';
    Bun.env['WEFT_STRICT_FAULTS'] = '1';
    try {
      const fault: OperationFault = {
        code: 'NotFound',
        message: 'gone',
        data: { resource: 'thing' },
      };
      const result = classifyEngineError(fault, {
        name: 'weft.test.forcestrict',
      });
      // Strict mode applies: result is EngineFailure with the diagnostic
      // message, NOT the original NotFound.
      expect(result.code).toBe('EngineFailure');
      expect(result.message).toContain('weft.test.forcestrict');
    } finally {
      if (originalNodeEnv !== undefined) Bun.env['NODE_ENV'] = originalNodeEnv;
      else delete Bun.env['NODE_ENV'];
      if (originalStrict !== undefined) Bun.env['WEFT_STRICT_FAULTS'] = originalStrict;
      else delete Bun.env['WEFT_STRICT_FAULTS'];
    }
  });
});
