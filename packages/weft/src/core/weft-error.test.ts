import { describe, expect, it } from 'bun:test';

import {
  ActivityPerAttemptTimeoutError,
  ActivityReconciliationCapabilityError,
  ActivityReconciliationConflictError,
  ActivityReconciliationIndeterminateError,
  ActivityResolutionError,
  ActivityScheduleToCloseTimeoutError,
  ApplicationCommandValidationError,
  ApplicationMailboxContentionError,
  AsyncActivityTokenNotFoundError,
  AtomicStateConflictError,
  BranchTopologyChangedError,
  BulkDeleteRequiresTerminalWorkflowsError,
  BulkOperationConfirmationError,
  DurableActivityScopeError,
  DurableActivityUnsupportedError,
  EffectReplayConflictError,
  EngineCreateNameMismatchError,
  EngineDisposalError,
  EngineDisposedError,
  HttpClientError,
  IdempotencyKeyPurgedError,
  OwnershipModeMismatchError,
  PayloadSizeExceededError,
  PersistedDataCorruptError,
  PersistedDataIncompatibleError,
  ReviewTimeoutError,
  StartOrSignalConflictError,
  UpdateTimeoutError,
  UpdateValidationError,
  VersionMismatchError,
  WaitBudgetElapsedError,
  WorkerManifestBuildError,
  WorkerProtocolIncompatibleError,
  WorkflowAlreadyExistsError,
  WorkflowBuilderError,
  WorkflowConcurrencyLimitExceededError,
  WorkflowNotFoundError,
  WorkflowNotRegisteredError,
  WorkflowSuspendNotSupportedError,
  WorkflowTeardownPendingError,
  WorkflowTerminalError,
  WorkflowTimeoutError,
  WorkflowTypeNotRegisteredForRecoveryError,
} from '../index.ts';
// StandardSchemaValidationError is public via the `@lostgradient/weft/json-schema` subpath,
// not the root entry — so it belongs in WeftErrorCode and is imported here.
import { StandardSchemaValidationError } from '../json-schema.ts';
import {
  WeftError,
  isWeftError,
  isWeftErrorCode,
  isWeftErrorLike,
  isWeftFault,
  type WeftErrorCode,
} from './weft-error.ts';

/**
 * A WeftError produced by a *second copy* of the module — exactly what a
 * duplicate-module boundary creates (Weft as a transitive dependency resolved
 * to two physical copies in a monorepo). It is structurally a public Weft error
 * but is NOT an instance of this realm's {@link WeftError} class, so `instanceof`
 * (and therefore {@link isWeftError}) returns `false` for it. This is the trap
 * the structural guards exist to defeat.
 */
function foreignWeftError(code: WeftErrorCode, message = 'from another module copy'): unknown {
  return { code, message, name: code };
}

/**
 * Exhaustive table over every public {@link WeftErrorCode}. Because the cases
 * object is typed `Record<WeftErrorCode, () => WeftError>`, omitting a code is
 * a compile error — this is the mechanical guarantee that every exported error
 * class is exercised, far stronger than a grep.
 */
const cases: Record<WeftErrorCode, () => WeftError> = {
  WorkflowAlreadyExistsError: () => new WorkflowAlreadyExistsError('wf-1'),
  WorkflowConcurrencyLimitExceededError: () =>
    new WorkflowConcurrencyLimitExceededError({
      workflowType: 'checkout',
      limit: 1,
      partitionKey: 'checkout',
    }),
  BulkDeleteRequiresTerminalWorkflowsError: () => new BulkDeleteRequiresTerminalWorkflowsError(),
  BulkOperationConfirmationError: () => new BulkOperationConfirmationError(),
  WorkflowTypeNotRegisteredForRecoveryError: () =>
    new WorkflowTypeNotRegisteredForRecoveryError({
      registeredTypes: ['known'],
      missingWorkflows: [{ type: 'mystery', workflowId: 'wf-7' }],
    }),
  EngineCreateNameMismatchError: () =>
    new EngineCreateNameMismatchError('workflow', 'expected', 'actual'),
  EngineDisposalError: () => new EngineDisposalError(new Error('drain failed'), true),
  EngineDisposedError: () => new EngineDisposedError(),
  WorkflowNotFoundError: () => new WorkflowNotFoundError('wf-404'),
  WorkflowNotRegisteredError: () => new WorkflowNotRegisteredError('checkout'),
  WorkflowSuspendNotSupportedError: () =>
    new WorkflowSuspendNotSupportedError('suspend is only supported in inline execution mode'),
  ActivityResolutionError: () => new ActivityResolutionError('checkout', 'charge'),
  BranchTopologyChangedError: () =>
    new BranchTopologyChangedError('branch topology changed across retry'),
  PersistedDataIncompatibleError: () => new PersistedDataIncompatibleError(0, 1),
  PersistedDataCorruptError: () => new PersistedDataCorruptError('fleet-event:1'),
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
  DurableActivityScopeError: () => new DurableActivityScopeError('durable activity scope closed'),
  DurableActivityUnsupportedError: () =>
    new DurableActivityUnsupportedError('durable activity unsupported feature'),
  PayloadSizeExceededError: () => new PayloadSizeExceededError('activity result', 2_048, 1_024),
  StandardSchemaValidationError: () =>
    new StandardSchemaValidationError({
      fieldName: 'input',
      operation: 'start',
      issues: [{ message: 'Expected a string.', path: '/email' }],
    }),
  AsyncActivityTokenNotFoundError: () => new AsyncActivityTokenNotFoundError('token-abc'),
  ActivityScheduleToCloseTimeoutError: () =>
    new ActivityScheduleToCloseTimeoutError('charge', 2_000, 1_000),
  ActivityPerAttemptTimeoutError: () => new ActivityPerAttemptTimeoutError('charge', 2, 1_000),
  StartOrSignalConflictError: () => new StartOrSignalConflictError('wf-1', 'completed'),
  WorkflowTeardownPendingError: () => new WorkflowTeardownPendingError('wf-1'),
  IdempotencyKeyPurgedError: () => new IdempotencyKeyPurgedError('wf-1'),
  WorkerManifestBuildError: () =>
    new WorkerManifestBuildError('workflow "checkout" not registered'),
  OwnershipModeMismatchError: () =>
    new OwnershipModeMismatchError('workflow-lease', 'lease', 1_700_000_000_000),
  ApplicationCommandValidationError: () =>
    new ApplicationCommandValidationError('caller must be a non-empty string.'),
  ApplicationMailboxContentionError: () => new ApplicationMailboxContentionError('admit', null),
  WaitBudgetElapsedError: () => new WaitBudgetElapsedError(),
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

      it('is recognized by every guard', () => {
        const error = construct();
        expect(isWeftError(error)).toBe(true);
        expect(isWeftErrorCode(error.code)).toBe(true);
        expect(isWeftErrorLike(error)).toBe(true);
      });

      it('is recognized structurally even when it crossed a module boundary', () => {
        // A foreign-module copy fails `instanceof`, but the structural guard
        // must still accept it — this is the whole point of `isWeftErrorLike`.
        const foreign = foreignWeftError(code);
        expect(isWeftError(foreign)).toBe(false);
        expect(isWeftErrorLike(foreign)).toBe(true);
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

describe('isWeftErrorLike', () => {
  it('accepts a same-realm WeftError instance', () => {
    expect(isWeftErrorLike(new WorkflowNotFoundError('wf-404'))).toBe(true);
  });

  it('accepts a foreign-module error object that fails instanceof', () => {
    const foreign = foreignWeftError('EngineDisposedError');
    expect(isWeftError(foreign)).toBe(false);
    expect(isWeftErrorLike(foreign)).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(isWeftErrorLike(null)).toBe(false);
    expect(isWeftErrorLike(undefined)).toBe(false);
    expect(isWeftErrorLike('EngineDisposedError')).toBe(false);
    expect(isWeftErrorLike(42)).toBe(false);
  });

  it('rejects an object with no code property', () => {
    expect(isWeftErrorLike({ message: 'no code here' })).toBe(false);
  });

  it('rejects an object whose code is not a public Weft code', () => {
    expect(isWeftErrorLike({ code: 'McpProtocolError', message: 'internal' })).toBe(false);
    expect(isWeftErrorLike({ code: 42, message: 'not a string code' })).toBe(false);
  });

  it('rejects a public code without a string message', () => {
    expect(isWeftErrorLike({ code: 'EngineDisposedError' })).toBe(false);
    expect(isWeftErrorLike({ code: 'EngineDisposedError', message: 123 })).toBe(false);
  });

  it('returns false (does not throw) for an object with a throwing getter', () => {
    // A type guard must be total and side-effect-free even for hostile input.
    const hostile = {
      get code(): string {
        throw new Error('boom');
      },
      message: 'x',
    };
    expect(() => isWeftErrorLike(hostile)).not.toThrow();
    expect(isWeftErrorLike(hostile)).toBe(false);
  });

  it('returns false (does not throw) for a Proxy that throws on property access', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('proxy trap boom');
        },
        has() {
          throw new Error('proxy has boom');
        },
      },
    );
    expect(() => isWeftErrorLike(hostile)).not.toThrow();
    expect(isWeftErrorLike(hostile)).toBe(false);
  });

  it('narrows code to WeftErrorCode in the branch body', () => {
    const error: unknown = foreignWeftError('WorkflowNotFoundError');
    if (isWeftErrorLike(error)) {
      const code: WeftErrorCode = error.code;
      expect(code).toBe('WorkflowNotFoundError');
    } else {
      throw new Error('expected isWeftErrorLike to accept the foreign error');
    }
  });

  it('supports matching a specific code by comparing the narrowed code', () => {
    // The inline replacement for a dedicated by-code guard: narrow structurally,
    // then compare. TypeScript narrows `error.code` to the matched literal.
    const match: unknown = foreignWeftError('EngineDisposedError');
    if (isWeftErrorLike(match) && match.code === 'EngineDisposedError') {
      const code: 'EngineDisposedError' = match.code;
      expect(code).toBe('EngineDisposedError');
    } else {
      throw new Error('expected the foreign EngineDisposedError to match');
    }
    // A Weft error of a different code does not match the specific comparison.
    const other: unknown = new WorkflowNotFoundError('wf-404');
    expect(isWeftErrorLike(other) && other.code === 'EngineDisposedError').toBe(false);
  });
});

describe('isWeftFault', () => {
  it('matches an in-process typed Weft error by code', () => {
    expect(isWeftFault(new WorkflowNotFoundError('wf-404'), 'WorkflowNotFoundError')).toBe(true);
  });

  it('matches a foreign (cross-realm) Weft error by code via the structural path', () => {
    const foreign = foreignWeftError('WorkflowNotFoundError');
    expect(isWeftFault(foreign, 'WorkflowNotFoundError')).toBe(true);
  });

  it('matches an HTTP-wrapped error carrying weftCode, without instanceof', () => {
    // Shape of an `HttpClientError` after the REST fault rehydrated the code:
    // `code` is 'HttpClientError', the fine-grained code rides on `weftCode`.
    const httpError = {
      code: 'HttpClientError',
      message: 'not found',
      weftCode: 'WorkflowNotFoundError',
    };
    expect(isWeftFault(httpError, 'WorkflowNotFoundError')).toBe(true);
  });

  it('does not match when the code differs (discriminates)', () => {
    expect(isWeftFault(new WorkflowNotFoundError('wf-404'), 'WorkflowNotRegisteredError')).toBe(
      false,
    );
    const httpError = { code: 'HttpClientError', message: 'x', weftCode: 'WorkflowNotFoundError' };
    expect(isWeftFault(httpError, 'WorkflowNotRegisteredError')).toBe(false);
  });

  it('returns false for non-errors and unrelated objects', () => {
    expect(isWeftFault(null, 'WorkflowNotFoundError')).toBe(false);
    expect(isWeftFault(undefined, 'WorkflowNotFoundError')).toBe(false);
    expect(isWeftFault('WorkflowNotFoundError', 'WorkflowNotFoundError')).toBe(false);
    expect(isWeftFault({ weftCode: 42 }, 'WorkflowNotFoundError')).toBe(false);
    expect(isWeftFault({ message: 'no codes' }, 'WorkflowNotFoundError')).toBe(false);
  });

  it('returns false (does not throw) for an object with a throwing weftCode getter', () => {
    const hostile = {
      get weftCode(): string {
        throw new Error('boom');
      },
    };
    expect(() => isWeftFault(hostile, 'WorkflowNotFoundError')).not.toThrow();
    expect(isWeftFault(hostile, 'WorkflowNotFoundError')).toBe(false);
  });
});
