/**
 * What a schedule records when it misses occurrences (COR-1829): the counters on the schedule, the
 * persisted row of each miss, and the read of those rows.
 *
 * A row is keyed by schedule, occurrence and reason ({@link KEYS.scheduleMissed}) and is written in
 * the same storage batch as the schedule state that counts it, so a miss is either counted and
 * recorded or neither. A backfilled tick writes what it missed with its first run, before the
 * schedule's `nextFireAt` moves, so a crash before its last write replays the same misses. The
 * schedule's `lastMissedFireAt` is the watermark that tells a replayed miss from a new one: misses
 * only ever come from instants after the previous tick's anchor, so one at or before the watermark
 * was recorded already, and is neither counted nor written again.
 */

import type { BatchOperation } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { decode, encode } from '../codec.ts';
import { isRecord } from '../debug-output.ts';
import {
  ScheduleMissedFireEvent,
  type ScheduleMissedFireReason,
} from '../events/schedule-events.ts';
import {
  SCHEDULE_MISSED_FIRE_LIMIT,
  type ScheduleMissedFire,
  type ScheduleState,
} from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { isSkippedOccurrence, type ScheduleTick } from './schedule-occurrence.ts';
import { coerceScheduleId } from './validation/schedule.ts';

/** One missed instant and how many occurrences it stands for. */
export type MissedScheduleInstant = { at: number; count: number };

/** What one tick missed for one reason. */
export type MissedScheduleOccurrences = {
  /** Why these occurrences were missed: reached too late, or swallowed by a daylight-saving gap. */
  reason: ScheduleMissedFireReason;
  /** The instants missed, oldest first. */
  instants: MissedScheduleInstant[];
  windowStart: number;
  windowEnd: number;
};

/** What a tick records: the schedule's new counters, the rows to commit with them, and the events. */
export type RecordedMisses = {
  /** The counters the schedule carries after the write. */
  counters: Pick<ScheduleState, 'missedFireCount'> &
    Partial<Pick<ScheduleState, 'lastMissedFireAt'>>;
  /** Row puts, and the evictions the limit makes, to commit in the schedule's own batch. */
  operations: BatchOperation[];
  /** The misses that are new, to announce once the write has landed. */
  announce: Array<{
    reason: ScheduleMissedFireReason;
    count: number;
    windowStart: number;
    windowEnd: number;
  }>;
};

/** The misses of `missed` that the schedule has not recorded: those after its watermark. */
function freshInstants(
  state: ScheduleState,
  entry: MissedScheduleOccurrences,
): MissedScheduleInstant[] {
  const watermark = state.lastMissedFireAt;
  return watermark === undefined
    ? entry.instants
    : entry.instants.filter((instant) => instant.at > watermark);
}

/**
 * What recording `missed` changes about `state`: the counters, the row operations, and what to
 * announce. A miss at or before the schedule's `lastMissedFireAt` was recorded by an earlier write
 * (a replayed tick) and is left out of all three. At most {@link SCHEDULE_MISSED_FIRE_LIMIT} rows
 * are kept: the oldest go, whether they were stored before or are among the new ones.
 */
export async function recordMissedFires(
  internals: EngineInternals,
  state: ScheduleState,
  missed: readonly MissedScheduleOccurrences[],
): Promise<RecordedMisses> {
  const fresh = missed
    .map((entry) => ({ entry, instants: freshInstants(state, entry) }))
    .filter(({ instants }) => instants.length > 0);
  if (fresh.length === 0) {
    return { counters: { missedFireCount: state.missedFireCount }, operations: [], announce: [] };
  }

  const recordedAt = internals.options.getNow();
  const added = fresh
    .flatMap(({ entry, instants }) =>
      instants.map((instant) => ({
        key: KEYS.scheduleMissed(state.id, instant.at, entry.reason),
        row: {
          scheduleId: state.id,
          occurrence: instant.at,
          reason: entry.reason,
          count: instant.count,
          recordedAt,
        } satisfies ScheduleMissedFire,
      })),
    )
    .toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const stored: string[] = [];
  for await (const [key] of internals.storage.scan(KEYS.scheduleMissedPrefix(state.id))) {
    stored.push(key);
  }
  const kept = new Set(
    [...new Set([...stored, ...added.map((entry) => entry.key)])]
      .toSorted()
      .slice(-SCHEDULE_MISSED_FIRE_LIMIT),
  );
  const operations: BatchOperation[] = [
    ...stored.filter((key) => !kept.has(key)).map((key) => ({ type: 'delete' as const, key })),
    ...added
      .filter((entry) => kept.has(entry.key))
      .map((entry) => ({ type: 'put' as const, key: entry.key, value: encode(entry.row) })),
  ];

  const total = fresh.reduce(
    (sum, { instants }) => sum + instants.reduce((inner, instant) => inner + instant.count, 0),
    0,
  );
  const last = Math.max(...fresh.map(({ instants }) => instants.at(-1)!.at));
  return {
    counters: {
      missedFireCount: state.missedFireCount + total,
      lastMissedFireAt: Math.max(last, state.lastMissedFireAt ?? last),
    },
    operations,
    announce: fresh.map(({ entry, instants }) => ({
      reason: entry.reason,
      count: instants.reduce((sum, instant) => sum + instant.count, 0),
      windowStart: entry.windowStart,
      windowEnd: entry.windowEnd,
    })),
  };
}

/** Announces what a tick missed, once the write that recorded it has landed. */
export function dispatchMissedFires(
  internals: EngineInternals,
  scheduleId: string,
  announce: RecordedMisses['announce'],
): void {
  for (const entry of announce) {
    internals.engine.dispatchEvent(
      new ScheduleMissedFireEvent(
        scheduleId,
        entry.count,
        entry.windowStart,
        entry.windowEnd,
        entry.reason,
      ),
    );
  }
}

function decodeMissedFire(scheduleId: string, bytes: Uint8Array): ScheduleMissedFire | null {
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    return null;
  }
  if (!isRecord(decoded)) return null;
  const { occurrence, reason, count, recordedAt } = decoded;
  if (
    !Number.isSafeInteger(occurrence) ||
    (reason !== 'late' && reason !== 'dst-gap') ||
    !Number.isSafeInteger(count) ||
    !Number.isSafeInteger(recordedAt)
  ) {
    return null;
  }
  return {
    scheduleId,
    occurrence: occurrence as number,
    reason,
    count: count as number,
    recordedAt: recordedAt as number,
  };
}

/**
 * The missed-fire rows a schedule keeps, newest occurrence first, at most `limit` of them (default
 * and ceiling {@link SCHEDULE_MISSED_FIRE_LIMIT}). A schedule that does not exist is `null`, so a
 * caller can tell it from one that has missed nothing.
 */
export async function listScheduleMissedFires(
  internals: EngineInternals,
  scheduleId: string,
  limit: number | undefined,
): Promise<ScheduleMissedFire[] | null> {
  coerceScheduleId(scheduleId, 'scheduleId');
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new Error('options.limit must be a positive integer');
  }
  if (!(await internals.storage.get(KEYS.schedule(scheduleId)))) return null;
  const take = Math.min(limit ?? SCHEDULE_MISSED_FIRE_LIMIT, SCHEDULE_MISSED_FIRE_LIMIT);
  const rows: ScheduleMissedFire[] = [];
  for await (const [, value] of internals.storage.scan(KEYS.scheduleMissedPrefix(scheduleId))) {
    const row = decodeMissedFire(scheduleId, value);
    if (row !== null) rows.push(row);
  }
  return rows.toReversed().slice(0, take);
}

/**
 * The occurrences a late timer skips: every tick in the window that would have fired, except the
 * one a person asked to skip, which would not have.
 */
export function lateMisses(
  state: ScheduleState,
  ticks: ScheduleTick[],
  windowStart: number,
  windowEnd: number,
): MissedScheduleOccurrences[] {
  const late = ticks.filter((tick) => tick.fires && !isSkippedOccurrence(state, tick.at));
  if (late.length === 0) return [];
  return [
    {
      reason: 'late',
      instants: late.map((tick) => ({ at: tick.at, count: 1 })),
      windowStart,
      windowEnd,
    },
  ];
}

/**
 * The wall-clock times daylight-saving gaps swallowed in a run of ticks, which are missed whether
 * the tick was reached on time or late: the time does not exist, so no run could have started at
 * it. The window is the instant a gap ends, because that is when the clock passes it.
 */
export function gapMisses(ticks: ScheduleTick[]): MissedScheduleOccurrences[] {
  const gaps = ticks.filter((tick) => tick.dstGapSkipped > 0);
  if (gaps.length === 0) return [];
  return [
    {
      reason: 'dst-gap',
      instants: gaps.map((tick) => ({ at: tick.at, count: tick.dstGapSkipped })),
      windowStart: gaps[0]!.at,
      windowEnd: gaps.at(-1)!.at,
    },
  ];
}
