import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import type { ScheduleState } from '../types.ts';
import { countPinnedSchedulesForRevision } from './pinned-schedule-revision-count.ts';

function makeScheduleState(overrides: Partial<ScheduleState> & { id: string }): ScheduleState {
  return {
    workflowType: 'checkout',
    input: null,
    cronExpression: '* * * * *',
    status: 'active',
    overlap: 'skip',
    backfill: false,
    revisionPolicy: 'active-at-fire',
    createdAt: 1,
    updatedAt: 1,
    nextFireAt: 60_000,
    missedFireCount: 0,
    queuedRuns: [],
    ...overrides,
  };
}

async function seedSchedule(storage: MemoryStorage, state: ScheduleState): Promise<void> {
  await storage.put(KEYS.schedule(state.id), encode(state));
}

describe('countPinnedSchedulesForRevision', () => {
  it('is 0 when no schedules exist', async () => {
    const storage = new MemoryStorage();
    expect(await countPinnedSchedulesForRevision(storage, 'checkout', 'rev-a')).toBe(0);
  });

  it('counts exactly one active pinned schedule matching type and revision', async () => {
    const storage = new MemoryStorage();
    await seedSchedule(
      storage,
      makeScheduleState({
        id: 'sched-1',
        revisionPolicy: 'pinned',
        pinnedRevision: 'rev-a',
        status: 'active',
      }),
    );

    expect(await countPinnedSchedulesForRevision(storage, 'checkout', 'rev-a')).toBe(1);
  });

  it('excludes a cancelled pinned schedule — it will never fire again', async () => {
    const storage = new MemoryStorage();
    await seedSchedule(
      storage,
      makeScheduleState({
        id: 'sched-cancelled',
        revisionPolicy: 'pinned',
        pinnedRevision: 'rev-a',
        status: 'cancelled',
      }),
    );

    expect(await countPinnedSchedulesForRevision(storage, 'checkout', 'rev-a')).toBe(0);
  });

  it('counts a PAUSED (not cancelled) pinned schedule — it can be resumed and fire again', async () => {
    const storage = new MemoryStorage();
    await seedSchedule(
      storage,
      makeScheduleState({
        id: 'sched-paused',
        revisionPolicy: 'pinned',
        pinnedRevision: 'rev-a',
        status: 'paused',
      }),
    );

    expect(await countPinnedSchedulesForRevision(storage, 'checkout', 'rev-a')).toBe(1);
  });

  it('never counts an active-at-fire schedule against the same (type, revision) a pinned sibling names', async () => {
    const storage = new MemoryStorage();
    await seedSchedule(
      storage,
      makeScheduleState({
        id: 'sched-active-at-fire',
        revisionPolicy: 'active-at-fire',
        status: 'active',
      }),
    );

    expect(await countPinnedSchedulesForRevision(storage, 'checkout', 'rev-a')).toBe(0);
  });

  it('never matches a schedule for a different workflowType', async () => {
    const storage = new MemoryStorage();
    await seedSchedule(
      storage,
      makeScheduleState({
        id: 'sched-other-type',
        workflowType: 'other',
        revisionPolicy: 'pinned',
        pinnedRevision: 'rev-a',
        status: 'active',
      }),
    );

    expect(await countPinnedSchedulesForRevision(storage, 'checkout', 'rev-a')).toBe(0);
  });

  it('skips schedule-run:<id>:* suffix keys that share the schedule: prefix', async () => {
    const storage = new MemoryStorage();
    await seedSchedule(
      storage,
      makeScheduleState({
        id: 'sched-1',
        revisionPolicy: 'pinned',
        pinnedRevision: 'rev-a',
        status: 'active',
      }),
    );
    // A non-schedule-state record sharing the `schedule:` prefix — must be
    // skipped, never decoded as a schedule record.
    await storage.put('schedule:sched-1:timer', encode({ not: 'a schedule state' }));

    expect(await countPinnedSchedulesForRevision(storage, 'checkout', 'rev-a')).toBe(1);
  });
});
