import { describe, expect, it } from 'bun:test';

import { outcomeOf, rethrow } from "../../../test-support/embedded/testing/src/module-scope-scenario.ts";
import { getNextCronOccurrence } from './cron-occurrence.ts';

// A day-of-month that never occurs in the month (31 April) parses, but nothing matches it, so the
// search runs its whole 100,000-step budget before giving up. Each step resolves a zoned
// calendar date through `Intl`, which makes that exhaustive search take seconds of real work. It
// runs at module scope, off Bun's five-second per-test clock, and lives in the slow lane.
const exhaustedSearch = await outcomeOf(async () => {
  let thrown: unknown;
  try {
    getNextCronOccurrence('0 0 31 4 *', Date.UTC(2026, 0, 1), { timeZone: 'UTC' });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe(
    'Could not find the next cron occurrence for "0 0 31 4 *"',
  );
});

describe('getNextCronOccurrence', () => {
  it('gives up with a diagnostic when the expression can never match', () =>
    rethrow(exhaustedSearch));
});
