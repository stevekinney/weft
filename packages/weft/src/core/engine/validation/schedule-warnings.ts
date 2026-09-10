/**
 * The shared "ignore this malformed persisted schedule record" warning
 * helper, split into its own leaf module so both `schedule.ts` and its
 * decode helpers (`schedule-cadence.ts`, `schedule-revision.ts`) can import
 * it without an import cycle — `schedule.ts` re-exports it so every existing
 * caller keeps importing it from there.
 *
 * @module core/engine/validation/schedule-warnings
 */

/** Warn and return `null` for a persisted schedule record that failed decode validation. */
export function rejectInvalidScheduleRecord(scheduleId: string | undefined, message: string): null {
  const prefix =
    scheduleId === undefined
      ? '[weft] Ignoring malformed schedule record'
      : `[weft] Ignoring malformed schedule "${scheduleId}"`;
  console.warn(`${prefix} ${message}.`);
  return null;
}
