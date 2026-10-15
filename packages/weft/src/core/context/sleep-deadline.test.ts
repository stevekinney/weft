import { describe, expect, it } from 'bun:test';

import { Context } from '../context.ts';
import { completePreparedSleepOperation, prepareSleepOperation } from './durable-operations.ts';
import { getInternals } from './internals.ts';

const SLEEP_DEADLINE_LOCAL_PREFIX = '__weftSleepDeadline:';

function createContext(overrides: Partial<ConstructorParameters<typeof Context>[0]> = {}) {
  return new Context({
    workflowId: 'wf-sleep-deadline',
    workflowType: 'sleep-deadline-test',
    startedAt: 1000,
    abortController: new AbortController(),
    ...overrides,
  });
}

function scheduledFireAt(prepared: ReturnType<typeof prepareSleepOperation>): number {
  if (prepared.cached || prepared.request.type !== 'sleep') {
    throw new Error('Expected an uncached sleep request.');
  }
  return prepared.request.scheduledFireAt;
}

describe('prepareSleepOperation deadline anchor', () => {
  it('re-parks a replayed pending sleep on the deadline its first evaluation anchored', () => {
    let now = 5_000;
    const first = getInternals(createContext({ getNow: () => now }));
    expect(scheduledFireAt(prepareSleepOperation(first, '1m'))).toBe(65_000);

    // A replay resumes from the checkpoint committed at the sleep's yield, which
    // carries the anchor, and hands the sleep that checkpoint's later `createdAt`
    // as its reference time. The anchor wins, so the deadline does not move.
    now = 35_000;
    const replay = getInternals(
      createContext({ getNow: () => now, locals: first.checkpointLocals, sleepReferenceTime: now }),
    );
    expect(scheduledFireAt(prepareSleepOperation(replay, '1m'))).toBe(65_000);
  });

  it('consumes the reference time at an anchored sleep so the next sleep measures from now', () => {
    const now = 90_000;
    const internals = getInternals(
      createContext({
        getNow: () => now,
        locals: { [`${SLEEP_DEADLINE_LOCAL_PREFIX}0`]: 65_000 },
        sleepReferenceTime: 35_000,
      }),
    );

    expect(scheduledFireAt(prepareSleepOperation(internals, '1m'))).toBe(65_000);
    expect(scheduledFireAt(prepareSleepOperation(internals, '1m'))).toBe(now + 60_000);
  });

  it('throws on a corrupt (present-but-non-finite) persisted anchor', () => {
    const internals = getInternals(
      createContext({ locals: { [`${SLEEP_DEADLINE_LOCAL_PREFIX}0`]: 'not-a-number' } }),
    );

    expect(() => prepareSleepOperation(internals, '1m')).toThrow(
      'Invalid checkpointed sleep deadline "not-a-number" for step 0',
    );
  });

  it('drops the anchor once the sleep completes, so recurring sleeps do not grow the checkpoint', () => {
    const context = createContext({ getNow: () => 5_000 });
    const internals = getInternals(context);
    const prepared = prepareSleepOperation(internals, '1m');
    if (prepared.cached) throw new Error('Expected an uncached sleep request.');
    expect(internals.checkpointLocals).toHaveProperty(`${SLEEP_DEADLINE_LOCAL_PREFIX}0`, 65_000);

    const execution = completePreparedSleepOperation(context, prepared);
    execution.next();
    expect(execution.next().done).toBe(true);
    expect(internals.checkpointLocals).not.toHaveProperty(`${SLEEP_DEADLINE_LOCAL_PREFIX}0`);
  });
});
