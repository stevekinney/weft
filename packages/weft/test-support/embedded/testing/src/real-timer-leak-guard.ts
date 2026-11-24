/**
 * Side-effect module: importing it from a test preload installs the real-timer
 * leak guard for the whole `bun test` process.
 *
 * It installs one {@link createRealTimerTracker} on `globalThis`, restores
 * native timers after every test, and fails the run in `afterAll` (which Bun
 * runs once per process, after every file's own hooks) when a real timer
 * outlives the tests that armed it. A leaked timer keeps firing into every
 * later file in this process (COR-1339, COR-1343). No timer is exempt
 * (COR-1342).
 *
 * ```ts
 * // tests/test-preload.ts
 * import '@lostgradient/testing/real-timer-leak-guard';
 * ```
 */
import { afterAll, afterEach } from 'bun:test';

import { restoreRealTimers } from './fake-timers.ts';
import { createRealTimerTracker } from './real-timer-tracker.ts';

const realTimers = createRealTimerTracker();
realTimers.install();

// Each test starts with native timers, even after a failed fake-clock assertion.
afterEach(restoreRealTimers);

afterAll(() => realTimers.assertNoLeaks());
