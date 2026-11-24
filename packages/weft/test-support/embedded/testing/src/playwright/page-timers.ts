import type { Page } from '@playwright/test';

/**
 * How far past the host's clock the page's clock jumps when it pauses. The jump must land ahead of
 * the page's own clock, which kept running in real time while the pause traveled to the page; a
 * minute is far more than any round trip, so the pause never asks to move time backward.
 */
const PAUSE_LEAD_MILLISECONDS = 60_000;

/**
 * Stop the page's timers, so state a component holds for a set time stays until the test reads
 * it. Call it just before the action that starts that state, after anything that needs timers to
 * run (a tooltip's open delay, a debounced input).
 *
 * A transient state on a real `setTimeout` (CopyButton's `data-cinder-copied`, held for
 * `confirmDuration`) races the round trips between the action and the first poll of the
 * assertion. Under load those outlast it, the state clears before anything sees it, and the
 * assertion waits for an element that never returns (COR-2644). With the clock paused, every
 * `setTimeout`, `setInterval` and `requestAnimationFrame` the page schedules from here on waits for
 * the test to advance time, which it never does. CSS transitions still run: they do not use the
 * page's timers.
 *
 * The clock is installed after load, so timers the page scheduled before this call keep real time.
 */
export async function freezePageTimers(page: Page): Promise<void> {
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + PAUSE_LEAD_MILLISECONDS);
}
