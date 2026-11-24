import type { Browser, Page } from '@playwright/test';
import { environmentConfiguration } from '../environment-configuration.ts';
import { THEME_STORAGE_KEY } from '../index.ts';

export const TOUCH_TARGET_MIN = 44;

/**
 * Resolves the alpha channel (0–255) of a computed CSS color *inside the page*,
 * so any color space the browser emits — `rgb()`, `rgba()`, `oklch()`, etc. —
 * is handled by the browser's own color engine rather than a brittle string
 * parser. Paints the color onto a 1×1 canvas and reads back the alpha byte.
 */
export async function colorAlpha(
  target: import('@playwright/test').Locator,
  property: 'backgroundColor' | 'borderTopColor',
): Promise<number> {
  return target.evaluate((element, prop) => {
    const value = getComputedStyle(element)[prop];
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) return 0;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3] ?? 0;
  }, property);
}

/**
 * Opens a playground route in a fresh touch-capable context with the requested
 * theme pre-selected, and waits for the app to mount.
 */
export async function openTouchPage(
  browser: Browser,
  route: string,
  theme: 'light' | 'dark',
  viewport = { width: 414, height: 896 },
): Promise<{ page: Page; dispose: () => Promise<void> }> {
  const baseURL = environmentConfiguration().browserFixtureUrl;
  const context = await browser.newContext({
    ...(baseURL === undefined ? {} : { baseURL }),
    colorScheme: theme,
    reducedMotion: 'reduce',
    hasTouch: true,
    isMobile: true,
    viewport,
  });
  // A failure below (bad route, load regression) would otherwise leak this
  // context: nothing else here closes a context whose owning `openTouchPage`
  // call never returned. Close it on any failure and rethrow.
  try {
    await context.addInitScript(
      ([key, value]) => {
        try {
          localStorage.setItem(key, value);
        } catch {
          /* ignore */
        }
      },
      [THEME_STORAGE_KEY, theme] as const,
    );
    const page = await context.newPage();
    await page.goto(route, { waitUntil: 'load' });
    await page.waitForSelector('#app > *', { state: 'visible' });
    return { page, dispose: () => context.close() };
  } catch (error) {
    await context.close();
    throw error;
  }
}
