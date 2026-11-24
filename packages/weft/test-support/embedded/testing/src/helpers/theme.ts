import type { BrowserContextOptions } from '@playwright/test';
import type { Theme } from './manifest.ts';

/** Returns Playwright context options for a color theme. */
export function themeContextOptions(theme: Theme): BrowserContextOptions {
  return { colorScheme: theme, reducedMotion: 'reduce' };
}

/** Storage key used by browser fixtures to persist their theme. */
export const THEME_STORAGE_KEY = 'browser-fixture-theme';
