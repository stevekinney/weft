import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/keys.ts';
import { encode } from '../codec.ts';
import {
  ACTIVITY_RETRY_STATE_LOCAL_KEY,
  forgetActivityRetryName,
  readRetryingActivity,
  withoutRetryingActivityNames,
  writeActivityRetryAttempt,
} from '../context/activity-retry-state.ts';
import { attachErrorCode, errorCodeOf } from '../error-code-of.ts';
import type { WorkflowState, WorkflowTimelineEntry } from '../types.ts';
import {
  buildActivityRetryingOperations,
  decodeActivityRetrying,
} from './activity-retrying-record.ts';
import { WorkflowNotFoundError } from './errors.ts';
import {
  FAILED_STEP_LABEL_MAX_LENGTH,
  failedStepOf,
  sanitizeDecodedFailureRecord,
} from './failure-record.ts';
import type { EngineInternals } from './internals.ts';

function entry(overrides: Partial<WorkflowTimelineEntry>): WorkflowTimelineEntry {
  return {
    step: 3,
    operationType: 'activity',
    operationLabel: 'charge',
    inputSummary: '',
    timestamp: 0,
    status: 'failed',
    ...overrides,
  };
}

/** What the retry-state writers take: a holder of the run's checkpoint locals. */
type LocalsHolder = Parameters<typeof writeActivityRetryAttempt>[0];

function internalsWith(locals: Record<string, unknown> = {}): LocalsHolder {
  return { checkpointLocals: locals } as unknown as LocalsHolder;
}

describe('errorCodeOf', () => {
  it('reads the code of a Weft error, of a rebuilt error named for one, and of an attached code', () => {
    expect(errorCodeOf(new WorkflowNotFoundError('x'))).toBe('WorkflowNotFoundError');

    const rebuilt = new Error('Workflow "x" not found');
    rebuilt.name = 'WorkflowNotFoundError';
    expect(errorCodeOf(rebuilt)).toBe('WorkflowNotFoundError');

    const carried = new Error('boom');
    attachErrorCode(carried, 'EngineDisposedError');
    expect(errorCodeOf(carried)).toBe('EngineDisposedError');
  });

  it('answers undefined for any other error or value', () => {
    expect(errorCodeOf(new Error('boom'))).toBeUndefined();
    const named = new Error('boom');
    named.name = 'NotAWeftCode';
    expect(errorCodeOf(named)).toBeUndefined();
    expect(errorCodeOf('WorkflowNotFoundError')).toBeUndefined();
    expect(errorCodeOf(undefined)).toBeUndefined();
  });
});

describe('failedStepOf', () => {
  it('uses the durable step index, and the checkpoint step for an entry that has none', () => {
    expect(failedStepOf(entry({ stepIndex: 1 }))).toEqual({ index: 1, label: 'charge' });
    expect(failedStepOf(entry({}))).toEqual({ index: 3, label: 'charge' });
  });

  it('writes the text of a label that is not a string, rather than failing the failure write', () => {
    const label = (value: unknown) =>
      failedStepOf(entry({ operationLabel: value as string }))?.label;

    expect(label(123)).toBe('123');
    expect(label(undefined)).toBe('undefined');
  });

  it('is undefined when the run started no step', () => {
    expect(failedStepOf(undefined)).toBeUndefined();
  });

  it('cuts a label to 200 characters and never ends on half a surrogate pair', () => {
    const cut = failedStepOf(entry({ operationLabel: 'a'.repeat(500) }));
    expect(cut?.label).toBe('a'.repeat(FAILED_STEP_LABEL_MAX_LENGTH));

    const label = `${'a'.repeat(FAILED_STEP_LABEL_MAX_LENGTH - 1)}😀`;
    expect(failedStepOf(entry({ operationLabel: label }))?.label).toBe(
      'a'.repeat(FAILED_STEP_LABEL_MAX_LENGTH - 1),
    );
  });
});

describe('sanitizeDecodedFailureRecord', () => {
  const state = (fields: Record<string, unknown>) => ({ id: 'wf', ...fields }) as WorkflowState;

  it('keeps a well-formed code and step', () => {
    const kept = state({
      errorCode: 'WorkflowNotFoundError',
      failedStep: { index: 0, label: 'a' },
    });
    sanitizeDecodedFailureRecord(kept);
    expect(kept.errorCode).toBe('WorkflowNotFoundError');
    expect(kept.failedStep).toEqual({ index: 0, label: 'a' });
  });

  it('drops a malformed code or step, including an inherited key', () => {
    for (const bad of [
      { errorCode: 'constructor' },
      { errorCode: 7 },
      { failedStep: { index: -1, label: 'a' } },
      { failedStep: { index: 1.5, label: 'a' } },
      { failedStep: { index: 0, label: 'a'.repeat(FAILED_STEP_LABEL_MAX_LENGTH + 1) } },
      { failedStep: { index: 0 } },
      { failedStep: 'step' },
      { failedStep: [] },
    ]) {
      const decoded = state(bad);
      sanitizeDecodedFailureRecord(decoded);
      expect(Object.hasOwn(decoded, 'errorCode')).toBe(false);
      expect(Object.hasOwn(decoded, 'failedStep')).toBe(false);
    }
  });
});

describe('retrying activity in the retry-state slot', () => {
  it('names the step on the highest attempt, and none below attempt 2 or without a name', () => {
    const internals = internalsWith();
    writeActivityRetryAttempt(internals, 4, 2, 'fetch');
    writeActivityRetryAttempt(internals, 7, 3, 'charge');
    expect(readRetryingActivity(internals.checkpointLocals)).toEqual({
      activity: 'charge',
      attempt: 3,
    });

    // An attempt with no recorded name (written before names existed) is not reported.
    const unnamed = internalsWith();
    writeActivityRetryAttempt(unnamed, 4, 2);
    expect(readRetryingActivity(unnamed.checkpointLocals)).toBeUndefined();
    expect(readRetryingActivity(undefined)).toBeUndefined();
    expect(readRetryingActivity({})).toBeUndefined();
  });

  it('stops reporting an activity that ran out of retries, and leaves its attempt alone', () => {
    const internals = internalsWith();
    writeActivityRetryAttempt(internals, 4, 3, 'fetch');
    forgetActivityRetryName(internals, 4);

    expect(readRetryingActivity(internals.checkpointLocals)).toBeUndefined();
    const slot = internals.checkpointLocals[ACTIVITY_RETRY_STATE_LOCAL_KEY] as {
      attempts: Record<string, number>;
    };
    expect(slot.attempts).toEqual({ '4': 3 });
    // A second call, and a step with no name, change nothing.
    forgetActivityRetryName(internals, 4);
    forgetActivityRetryName(internals, 9);
    expect(slot.attempts).toEqual({ '4': 3 });
  });

  it('reads nothing from a malformed slot or an inherited key', () => {
    expect(
      readRetryingActivity({
        [ACTIVITY_RETRY_STATE_LOCAL_KEY]: {
          version: 1,
          attempts: { '1': 5 },
          activityNames: { constructor: 'x', '1': 7 },
        },
      }),
    ).toBeUndefined();
    expect(
      readRetryingActivity({
        [ACTIVITY_RETRY_STATE_LOCAL_KEY]: { version: 2, attempts: {}, activityNames: {} },
      }),
    ).toBeUndefined();
  });

  it('strips the names for a copy and returns the locals untouched when it has none', () => {
    const internals = internalsWith();
    writeActivityRetryAttempt(internals, 4, 2, 'fetch');
    const stripped = withoutRetryingActivityNames(internals.checkpointLocals);

    expect(readRetryingActivity(stripped)).toBeUndefined();
    expect(stripped[ACTIVITY_RETRY_STATE_LOCAL_KEY]).toMatchObject({ attempts: { '4': 2 } });
    expect(readRetryingActivity(internals.checkpointLocals)).toBeDefined();

    const plain = { other: 1 };
    expect(withoutRetryingActivityNames(plain)).toBe(plain);
  });
});

describe('the retrying record', () => {
  const retrying = { activity: 'fetch', attempt: 2 };

  function engineHolding(locals: Record<string, unknown> | undefined) {
    return {
      checkpoints: new Map(locals === undefined ? [] : [['wf', { locals }]]),
    } as unknown as EngineInternals;
  }

  function retryingLocals(name: string, attempt: number): Record<string, unknown> {
    const internals = internalsWith();
    writeActivityRetryAttempt(internals, 1, attempt, name);
    return internals.checkpointLocals;
  }

  it('puts the activity with its run token when a checkpoint first shows a retry', () => {
    const operations = buildActivityRetryingOperations(engineHolding(undefined), 'wf', {
      locals: retryingLocals('fetch', 2),
      workflowExecutionToken: 'run-1',
    });

    expect(operations).toEqual([
      {
        type: 'put',
        key: KEYS.activityRetrying('wf'),
        value: encode({ ...retrying, workflowExecutionToken: 'run-1' }),
      },
    ]);
  });

  it('adds nothing while the checkpoint shows what the previous one showed, and deletes once it shows none', () => {
    const locals = retryingLocals('fetch', 2);
    expect(
      buildActivityRetryingOperations(engineHolding(locals), 'wf', {
        locals,
        workflowExecutionToken: 'run-1',
      }),
    ).toEqual([]);
    expect(buildActivityRetryingOperations(engineHolding(undefined), 'wf', { locals: {} })).toEqual(
      [],
    );
    expect(buildActivityRetryingOperations(engineHolding(locals), 'wf', { locals: {} })).toEqual([
      { type: 'delete', key: KEYS.activityRetrying('wf') },
    ]);
  });

  it('replaces the record when the attempt advances', () => {
    const operations = buildActivityRetryingOperations(
      engineHolding(retryingLocals('fetch', 2)),
      'wf',
      { locals: retryingLocals('fetch', 3), workflowExecutionToken: 'run-1' },
    );
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ type: 'put' });
  });

  it('is read only by the run it belongs to', () => {
    const bytes = encode({ ...retrying, workflowExecutionToken: 'run-1' });

    expect(decodeActivityRetrying(bytes, 'run-1')).toEqual(retrying);
    // A run replaced under the same id (`start-new`) must not read the run before it as its own.
    expect(decodeActivityRetrying(bytes, 'run-2')).toBeUndefined();
    expect(decodeActivityRetrying(bytes, undefined)).toBeUndefined();
    // A record written for a run with no token belongs to a run with none.
    expect(decodeActivityRetrying(encode(retrying), undefined)).toEqual(retrying);
    expect(decodeActivityRetrying(encode(retrying), 'run-1')).toBeUndefined();
  });

  it('reads nothing from an absent or malformed record', () => {
    expect(decodeActivityRetrying(null, undefined)).toBeUndefined();
    for (const malformed of [
      'text',
      [],
      { activity: '', attempt: 2 },
      { activity: 'fetch', attempt: 1 },
      { activity: 'fetch', attempt: 2.5 },
      { activity: 7, attempt: 2 },
    ]) {
      expect(decodeActivityRetrying(encode(malformed), undefined)).toBeUndefined();
    }
  });
});
