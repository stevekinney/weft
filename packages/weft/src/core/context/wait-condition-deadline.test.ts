import { describe, expect, it } from 'bun:test';

import { Context } from '../context.ts';
import { prepareSleepOperation, readOrInitConditionDeadline } from './durable-operations.ts';
import { getInternals } from './internals.ts';

const CONDITION_DEADLINE_LOCAL_PREFIX = '__weftConditionDeadline:';

function createContext(overrides: Partial<ConstructorParameters<typeof Context>[0]> = {}) {
  return new Context({
    workflowId: 'wf-wait-condition-deadline',
    workflowType: 'wait-condition-deadline-test',
    startedAt: 1000,
    abortController: new AbortController(),
    ...overrides,
  });
}

describe('readOrInitConditionDeadline', () => {
  it('returns undefined when no timeout is supplied (wait forever)', () => {
    const internals = getInternals(createContext());
    expect(readOrInitConditionDeadline(internals, 0, undefined)).toBeUndefined();
  });

  it('anchors the deadline once and reuses it on replay', () => {
    let now = 5_000;
    const internals = getInternals(createContext({ getNow: () => now }));

    const first = readOrInitConditionDeadline(internals, 0, '1m');
    expect(first).toBe(5_000 + 60_000);

    // A replay advances the clock but must read the SAME anchor — the timeout
    // window is measured from the original first evaluation, not re-anchored.
    now = 999_999;
    const replayed = readOrInitConditionDeadline(internals, 0, '1m');
    expect(replayed).toBe(first);
  });

  it('honors a finite anchor of 0 (a test clock can legitimately report 0)', () => {
    let now = 0;
    const internals = getInternals(createContext({ getNow: () => now }));
    // First anchor at now=0 with a zero-length window → deadline 0.
    const first = readOrInitConditionDeadline(internals, 0, 0);
    expect(first).toBe(0);

    now = 1_000;
    // 0 must be treated as a SET anchor, not "unset" — re-read returns 0.
    expect(readOrInitConditionDeadline(internals, 0, '1m')).toBe(0);
  });

  it('throws on a corrupt (present-but-non-finite) persisted anchor', () => {
    const internals = getInternals(createContext());
    internals.checkpointLocals = {
      ...internals.checkpointLocals,
      [`${CONDITION_DEADLINE_LOCAL_PREFIX}3`]: 'not-a-number',
    };

    expect(() => readOrInitConditionDeadline(internals, 3, '1m')).toThrow(
      'Invalid checkpointed wait-condition deadline "not-a-number" for step 3',
    );
  });

  it('consumes the resume reference time when replaying an anchored deadline', () => {
    // Resumed from a checkpoint created at 35_000 while a `waitUntil` anchored at
    // 95_000 was still pending. The replay returns the anchor, and the reference
    // time must not leak to the next uncached sleep, which would otherwise fire
    // from the stale checkpoint time instead of now.
    const internals = getInternals(
      createContext({
        getNow: () => 90_000,
        locals: { [`${CONDITION_DEADLINE_LOCAL_PREFIX}0`]: 95_000 },
        sleepReferenceTime: 35_000,
      }),
    );

    expect(readOrInitConditionDeadline(internals, 0, '1m')).toBe(95_000);
    expect(internals.sleepReferenceTime).toBeUndefined();

    internals.stepIndex = 1;
    const prepared = prepareSleepOperation(internals, '1m');
    if (prepared.cached) throw new Error('Expected an uncached sleep');
    expect(prepared.request).toMatchObject({ scheduledFireAt: 90_000 + 60_000 });
  });

  it('consumes the resume reference time when replaying a wait with no timeout', () => {
    const internals = getInternals(
      createContext({ getNow: () => 90_000, sleepReferenceTime: 35_000 }),
    );

    expect(readOrInitConditionDeadline(internals, 0, undefined)).toBeUndefined();
    expect(internals.sleepReferenceTime).toBeUndefined();

    internals.stepIndex = 1;
    const prepared = prepareSleepOperation(internals, '1m');
    if (prepared.cached) throw new Error('Expected an uncached sleep');
    expect(prepared.request).toMatchObject({ scheduledFireAt: 90_000 + 60_000 });
  });

  it('keeps the resume reference time when an invalid timeout throws', () => {
    // A workflow that catches the invalid-timeout error and then sleeps must still
    // schedule from the checkpoint time, as if the wait had never run.
    const internals = getInternals(
      createContext({ getNow: () => 90_000, sleepReferenceTime: 35_000 }),
    );

    expect(() => readOrInitConditionDeadline(internals, 0, 'not a duration')).toThrow(
      'Invalid duration string',
    );
    expect(internals.sleepReferenceTime).toBe(35_000);

    internals.stepIndex = 1;
    const prepared = prepareSleepOperation(internals, '1m');
    if (prepared.cached) throw new Error('Expected an uncached sleep');
    expect(prepared.request).toMatchObject({ scheduledFireAt: 35_000 + 60_000 });
  });

  it('keeps the resume reference time when a corrupt anchor throws', () => {
    const internals = getInternals(
      createContext({
        getNow: () => 90_000,
        locals: { [`${CONDITION_DEADLINE_LOCAL_PREFIX}0`]: 'not-a-number' },
        sleepReferenceTime: 35_000,
      }),
    );

    expect(() => readOrInitConditionDeadline(internals, 0, '1m')).toThrow(
      'Invalid checkpointed wait-condition deadline',
    );
    expect(internals.sleepReferenceTime).toBe(35_000);
  });
});
