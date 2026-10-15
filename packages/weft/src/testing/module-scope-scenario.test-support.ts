/**
 * Runs a test scenario at module scope and keeps its outcome for the test that reports it.
 *
 * A test that spawns a real process (`tsc`, a fresh Bun runtime, a SIGKILLed child) pays that
 * process's boot and module load on Bun's five-second per-test clock, and times out when the
 * host is loaded. Awaiting `outcomeOf(scenario)` at module scope runs the same body, assertions
 * included, before any test starts, where no per-test timeout applies. The test then calls
 * {@link rethrow} with the outcome, so a failed assertion still fails under the test that names
 * it, with its original message.
 *
 * Module scope has no per-test timeout, so a scenario whose child never exits would otherwise
 * hold the whole run. {@link SCENARIO_HANG_GUARD_MILLISECONDS} turns that hang into a failure of
 * the scenario's test. It is a uniform hang detector, set far above any healthy run on a loaded
 * host and never a performance bound; a scenario that needs a larger budget passes it explicitly.
 *
 * @example
 * ```ts
 * const compiled = await outcomeOf(async () => {
 *   const exitCode = await Bun.spawn(['bun', tscPath, '--noEmit']).exited;
 *   expect(exitCode).toBe(0);
 * });
 * it('compiles the fixture', () => rethrow(compiled));
 * ```
 */
import { restoreRealTimers } from './fake-timers.test-support.ts';

export const SCENARIO_HANG_GUARD_MILLISECONDS = 120_000;

/** The outcome {@link outcomeOf} records when a scenario does not settle before its hang guard. */
export class ScenarioHangError extends Error {
  constructor(hangGuardMilliseconds: number) {
    super(`scenario did not settle within ${hangGuardMilliseconds} ms; it is hung, not slow`);
    this.name = 'ScenarioHangError';
  }
}

/**
 * Runs `scenario` and returns what it threw, a {@link ScenarioHangError} if it did not settle
 * within `hangGuardMilliseconds`, or `undefined` when it finished. A hung scenario never reaches
 * its own `finally`, so `onHang` runs as soon as the guard fires to release what the scenario
 * holds (crash its realms, stop its servers) before the next scenario starts.
 */
export async function outcomeOf(
  scenario: () => Promise<void>,
  hangGuardMilliseconds = SCENARIO_HANG_GUARD_MILLISECONDS,
  onHang?: () => void | Promise<void>,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hang = new Promise<Error>((resolve) => {
    timer = setTimeout(() => {
      // The guard is armed before the scenario runs, so it fires even if the scenario installs
      // fake timers. An abandoned scenario never reaches its own `finally`, so restore real
      // timers here; otherwise every later scenario's guard would be created fake and never fire.
      restoreRealTimers();
      resolve(new ScenarioHangError(hangGuardMilliseconds));
    }, hangGuardMilliseconds);
  });
  try {
    const outcome = await Promise.race([
      scenario().then(
        () => undefined,
        (error: unknown) => error ?? new Error('scenario failed'),
      ),
      hang,
    ]);
    if (outcome instanceof ScenarioHangError && onHang !== undefined) {
      // Cleanup is best effort: a failure here must not hide the hang it is cleaning up after.
      await Promise.resolve()
        .then(onHang)
        .catch(() => {});
    }
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

/** Re-throws what {@link outcomeOf} captured; does nothing when the scenario succeeded. */
export function rethrow(outcome: unknown): void {
  if (outcome !== undefined) throw outcome;
}
