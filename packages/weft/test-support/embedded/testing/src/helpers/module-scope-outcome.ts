/**
 * Run a whole test body at module scope, where Bun applies no per-test timeout, and rethrow its
 * outcome from the test that names it. For bodies that start a real process (git, a fresh Bun,
 * server-side rendering): the process boots off the five-second clock, yet a failed assertion
 * still fails under the test that owns it.
 *
 * Module scope has no per-test timeout, so a scenario that never settles would otherwise hold the
 * whole run. `HANG_GUARD_MILLISECONDS` of awake time turns that hang into a failure of the
 * scenario's test; `../hang-guard.ts` explains why the guard counts only time the process was
 * awake. It is a uniform hang detector, set far above any healthy run on a loaded host and never a
 * performance bound; a scenario that needs a larger budget passes it explicitly.
 */
import { afterAwakeTime, HANG_GUARD_MILLISECONDS } from '../hang-guard.ts';

/** The outcome `outcomeOf` records when a scenario does not settle before its hang guard. */
export class ScenarioHangError extends Error {
  constructor(hangGuardMilliseconds: number) {
    super(`scenario did not settle within ${hangGuardMilliseconds} ms; it is hung, not slow`);
    this.name = 'ScenarioHangError';
  }
}

/** Run `scenario` and return what it threw, or `undefined` when it finished. */
export async function outcomeOf(
  scenario: () => Promise<void> | void,
  hangGuardMilliseconds = HANG_GUARD_MILLISECONDS,
): Promise<unknown> {
  let cancel: (() => void) | undefined;
  const hang = new Promise<ScenarioHangError>((resolve) => {
    cancel = afterAwakeTime(hangGuardMilliseconds, () =>
      resolve(new ScenarioHangError(hangGuardMilliseconds)),
    );
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(scenario)
        .then(
          () => undefined,
          (error: unknown) => error ?? new Error('scenario failed'),
        ),
      hang,
    ]);
  } finally {
    cancel?.();
  }
}

/** Rethrow what `outcomeOf` recorded; returns normally when the scenario passed. */
export function rethrow(outcome: unknown): void {
  if (outcome !== undefined) throw outcome;
}
