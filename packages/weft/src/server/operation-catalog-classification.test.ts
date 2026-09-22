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

import { WorkflowNotRegisteredError } from '../core/engine/errors.ts';
import { classifyEngineError } from './operation-catalog.ts';
import type { OperationFault } from './operation-fault.ts';

describe('classifyEngineError', () => {
  it('classifies a thrown OperationFault by passing it through', () => {
    const fault = classifyEngineError({
      code: 'Conflict',
      message: 'dup',
      data: { reason: 'duplicate id' },
    });
    expect(fault.code).toBe('Conflict');
  });

  it('classifies an Error with "not found" message as NotFound with a generic public message', () => {
    const fault = classifyEngineError(new Error('workflow "wf-x" not found at /var/secret/path'));
    expect(fault.code).toBe('NotFound');
    // The original error message MUST NOT propagate to the wire — it can
    // contain internal details like file paths, query text, or secrets.
    expect(fault.message).toBe('not found');
    expect(fault.message).not.toContain('/var/secret/path');
  });

  it('classifies an Error with "already exists" message as Conflict with a generic message', () => {
    const fault = classifyEngineError(
      new Error('schedule with id "sched-1" already exists at /var/secret/path'),
    );
    expect(fault.code).toBe('Conflict');
    expect(fault.message).toBe('conflict');
    expect(fault.message).not.toContain('/var/secret/path');
  });

  it('classifies WorkflowNotRegisteredError as InvalidParams instead of NotFound', () => {
    const fault = classifyEngineError(new WorkflowNotRegisteredError('missing-workflow'));

    expect(fault.code).toBe('InvalidParams');
    expect(fault.message).toContain('missing-workflow');
  });

  it('classifies an Error with "timeout" message as Timeout with a generic message', () => {
    const fault = classifyEngineError(new Error('update timeout exceeded after 30s'));
    expect(fault.code).toBe('Timeout');
    expect(fault.message).toBe('operation timed out');
  });

  it('classifies any unrecognized Error as EngineFailure with a generic message', () => {
    const fault = classifyEngineError(new Error('mysterious failure with internals'));
    expect(fault.code).toBe('EngineFailure');
    expect(fault.message).toBe('internal error');
  });

  it('classifies a thrown non-Error value as EngineFailure', () => {
    const fault = classifyEngineError('a string thrown for some reason');
    expect(fault.code).toBe('EngineFailure');
  });

  it('classifies a thrown null/undefined as EngineFailure', () => {
    expect(classifyEngineError(null).code).toBe('EngineFailure');
    expect(classifyEngineError(undefined).code).toBe('EngineFailure');
  });

  it('classifies "timed out" substring (separate from "timeout") as Timeout with generic message', () => {
    const fault = classifyEngineError(new Error('database call timed out after 30 seconds'));
    expect(fault.code).toBe('Timeout');
    expect(fault.message).toBe('operation timed out');
  });

  it('rejects a fault-shaped object with no `data` field', () => {
    // Without `data`, downstream serializers would crash. Treat as a
    // malformed fault and fall through to EngineFailure.
    const fault = classifyEngineError({ code: 'NotFound', message: 'no data' });
    expect(fault.code).toBe('EngineFailure');
  });

  it('classifies an Error subclass with a throwing message getter as EngineFailure', () => {
    // Defense against an `Error` subclass that overrides `message` with a
    // throwing accessor. Without try/catch around `error.message`, the
    // throw would escape `executeOperation` and break its contract of
    // always returning a `DispatchResult`.
    class HostileError extends Error {
      constructor() {
        super('initial');
        Object.defineProperty(this, 'message', {
          get() {
            throw new Error('secret detail');
          },
        });
      }
    }
    const fault = classifyEngineError(new HostileError());
    expect(fault.code).toBe('EngineFailure');
    expect(fault.message).toBe('internal error');
  });

  it('rejects a fault-shaped object whose `data` is an array', () => {
    // Arrays satisfy `typeof === 'object' && !== null`, but every
    // `OperationFault` variant declares `data` as a plain object. A
    // thrown `{ code: 'InvalidParams', message: 'x', data: [] }` would
    // crash downstream serializers (e.g. `data.issues.map(...)`). The
    // guard must reject it.
    const fault = classifyEngineError({ code: 'InvalidParams', message: 'x', data: [] });
    expect(fault.code).toBe('EngineFailure');
  });

  it('rejects a fault-shaped value with a poisoned getter', () => {
    const poisoned = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'code') throw new Error('secret');
          return undefined;
        },
      },
    );
    const fault = classifyEngineError(poisoned);
    expect(fault.code).toBe('EngineFailure');
  });

  it('passes through every FaultCode variant (runtime smoke check)', () => {
    // The compile-time `Record<FaultCode, true>` constraint on the internal
    // `FAULT_CODES` table is the actual exhaustiveness guard — a missing
    // union member would fail to typecheck. This test is a runtime smoke
    // check over the variants currently known to the test file: it catches
    // accidents like the runtime check being reverted from `Object.hasOwn`
    // back to a partial array, or the classifier silently mishandling a
    // specific existing code. Adding a new `FaultCode` will not auto-extend
    // this list, so the compile-time `Record` remains the source of truth.
    const allCodes: OperationFault['code'][] = [
      'Unauthorized',
      'Forbidden',
      'NotFound',
      'Conflict',
      'Unprocessable',
      'Timeout',
      'NotImplemented',
      'UnsupportedTransport',
      'SubscriptionOverflow',
      'InvalidParams',
      'MethodNotFound',
      'EngineFailure',
    ];
    for (const code of allCodes) {
      const fault = classifyEngineError({ code, message: 'm', data: {} });
      expect(fault.code).toBe(code);
    }
  });
});
