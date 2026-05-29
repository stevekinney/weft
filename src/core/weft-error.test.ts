import { describe, expect, it } from 'bun:test';

import {
  ActivityReconciliationCapabilityError,
  ActivityReconciliationConflictError,
  ActivityReconciliationIndeterminateError,
  ActivityResolutionError,
  AsyncActivityTokenNotFoundError,
  AtomicStateConflictError,
  BulkDeleteRequiresTerminalWorkflowsError,
  BulkOperationConfirmationError,
  EffectReplayConflictError,
  EngineCreateNameMismatchError,
  HttpClientError,
  PayloadSizeExceededError,
  PersistedDataIncompatibleError,
  ReviewTimeoutError,
  UpdateTimeoutError,
  UpdateValidationError,
  VersionMismatchError,
  WorkerProtocolIncompatibleError,
  WorkflowAlreadyExistsError,
  WorkflowBuilderError,
  WorkflowNotFoundError,
  WorkflowNotRegisteredError,
  WorkflowTerminalError,
  WorkflowTimeoutError,
  WorkflowTypeNotRegisteredForRecoveryError,
} from '../index.ts';
// StandardSchemaValidationError is public via the `weft/json-schema` subpath,
// not the root entry — so it belongs in WeftErrorCode and is imported here.
import { StandardSchemaValidationError } from '../json-schema.ts';
import { WeftError, isWeftError, isWeftErrorCode, type WeftErrorCode } from './weft-error.ts';

/**
 * Exhaustive table over every public {@link WeftErrorCode}. Because the cases
 * object is typed `Record<WeftErrorCode, () => WeftError>`, omitting a code is
 * a compile error — this is the mechanical guarantee that every exported error
 * class is exercised, far stronger than a grep.
 */
const cases: Record<WeftErrorCode, () => WeftError> = {
  WorkflowAlreadyExistsError: () => new WorkflowAlreadyExistsError('wf-1'),
  BulkDeleteRequiresTerminalWorkflowsError: () => new BulkDeleteRequiresTerminalWorkflowsError(),
  BulkOperationConfirmationError: () => new BulkOperationConfirmationError(),
  WorkflowTypeNotRegisteredForRecoveryError: () =>
    new WorkflowTypeNotRegisteredForRecoveryError({
      registeredTypes: ['known'],
      missingWorkflows: [{ type: 'mystery', workflowId: 'wf-7' }],
    }),
  EngineCreateNameMismatchError: () =>
    new EngineCreateNameMismatchError('workflow', 'expected', 'actual'),
  WorkflowNotFoundError: () => new WorkflowNotFoundError('wf-404'),
  WorkflowNotRegisteredError: () => new WorkflowNotRegisteredError('checkout'),
  ActivityResolutionError: () => new ActivityResolutionError('checkout', 'charge'),
  PersistedDataIncompatibleError: () => new PersistedDataIncompatibleError(0, 1),
  WorkflowTimeoutError: () => new WorkflowTimeoutError('wf-1', 'execution', 1_000),
  HttpClientError: () => new HttpClientError(500, 'boom'),
  WorkerProtocolIncompatibleError: () =>
    new WorkerProtocolIncompatibleError({ expected: 2, received: 1 }),
  UpdateTimeoutError: () => new UpdateTimeoutError('update-1', 5_000),
  UpdateValidationError: () =>
    new UpdateValidationError('setAge', [{ message: 'must be non-negative' }]),
  WorkflowTerminalError: () => new WorkflowTerminalError('wf-1', 'completed'),
  WorkflowBuilderError: () => new WorkflowBuilderError('duplicate activities() call'),
  VersionMismatchError: () => new VersionMismatchError('wf-1', 'checkout', '1.0.0', '2.0.0'),
  EffectReplayConflictError: () => new EffectReplayConflictError('hash-abc', 'charge'),
  ReviewTimeoutError: () => new ReviewTimeoutError('review-1', 1_000),
  AtomicStateConflictError: () => new AtomicStateConflictError('counter', 3),
  ActivityReconciliationCapabilityError: () => new ActivityReconciliationCapabilityError(),
  ActivityReconciliationConflictError: () => new ActivityReconciliationConflictError('conflict'),
  ActivityReconciliationIndeterminateError: () =>
    new ActivityReconciliationIndeterminateError('indeterminate'),
  PayloadSizeExceededError: () => new PayloadSizeExceededError('activity result', 2_048, 1_024),
  StandardSchemaValidationError: () =>
    new StandardSchemaValidationError({
      fieldName: 'input',
      operation: 'start',
      issues: [{ message: 'Expected a string.', path: '/email' }],
    }),
  AsyncActivityTokenNotFoundError: () => new AsyncActivityTokenNotFoundError('token-abc'),
};

describe('WeftError', () => {
  for (const [code, construct] of Object.entries(cases) as Array<
    [WeftErrorCode, () => WeftError]
  >) {
    describe(code, () => {
      it('is a WeftError and an Error', () => {
        const error = construct();
        expect(error).toBeInstanceOf(WeftError);
        expect(error).toBeInstanceOf(Error);
      });

      it('carries its class name as a stable code', () => {
        const error = construct();
        expect(error.code).toBe(code);
        expect(error.name).toBe(code);
      });

      it('is recognized by both guards', () => {
        const error = construct();
        expect(isWeftError(error)).toBe(true);
        expect(isWeftErrorCode(error.code)).toBe(true);
      });

      it('retains a non-empty message', () => {
        const error = construct();
        expect(typeof error.message).toBe('string');
        expect(error.message.length).toBeGreaterThan(0);
      });
    });
  }
});

describe('WeftError subclasses preserve domain state', () => {
  it('keeps constructor-supplied properties on the instance', () => {
    expect(new WorkflowAlreadyExistsError('wf-1').workflowId).toBe('wf-1');
    expect(new WorkflowTerminalError('wf-1', 'completed').status).toBe('completed');
    expect(new HttpClientError(503, 'down').status).toBe(503);
  });

  it('interpolates dynamic values into the message', () => {
    expect(new WorkflowTimeoutError('wf-1', 'execution', 1_000).message).toContain('1000ms');
    expect(new ActivityResolutionError('checkout', 'charge').message).toContain('charge');
  });
});

describe('isWeftError', () => {
  it('rejects plain errors and non-errors', () => {
    expect(isWeftError(new Error('plain'))).toBe(false);
    expect(isWeftError('WorkflowNotFoundError')).toBe(false);
    expect(isWeftError(null)).toBe(false);
    expect(isWeftError(undefined)).toBe(false);
  });
});

describe('isWeftErrorCode', () => {
  it('accepts every public code', () => {
    for (const code of Object.keys(cases) as WeftErrorCode[]) {
      expect(isWeftErrorCode(code)).toBe(true);
    }
  });

  it('rejects internal codes, unknown strings, and non-strings', () => {
    // Internal (non-exported) error codes are intentionally absent from the
    // public union, so the guard must reject them.
    expect(isWeftErrorCode('McpProtocolError')).toBe(false);
    expect(isWeftErrorCode('CheckpointSchemaVersionError')).toBe(false);
    expect(isWeftErrorCode('NotAWeftCode')).toBe(false);
    expect(isWeftErrorCode(42)).toBe(false);
    expect(isWeftErrorCode(null)).toBe(false);
  });
});
