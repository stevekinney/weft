import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { environmentConfiguration } from '../environment-configuration.ts';
import type { ComponentEntry, Theme, Viewport } from '../index.ts';
import { THEME_STORAGE_KEY, themeContextOptions } from '../index.ts';

type OpenArgs = {
  entry: ComponentEntry;
  theme: Theme;
  viewport: Viewport;
  fixtureName?: string;
  fixtureContentHash?: string;
  /** Emulate a touch screen, so `(any-pointer: coarse)` matches and the coarse hit areas apply. */
  hasTouch?: boolean;
  onPage?: (page: Page) => void | Promise<void>;
};

type Fixtures = { componentPage: { open(args: OpenArgs): Promise<Page> } };

/** The `componentPage` fixture, for a helper that takes it as a parameter. */
export type ComponentPageFixture = Fixtures['componentPage'];

function buildRoute(
  entry: ComponentEntry,
  fixtureName?: string,
  fixtureContentHash?: string,
): string {
  const params = new URLSearchParams({ snapshot: '1' });
  if (fixtureName !== undefined) params.set('fixture', fixtureName);
  const selectedHash =
    fixtureContentHash ??
    (fixtureName === undefined
      ? undefined
      : entry.fixtures?.find((fixture) => fixture.name === fixtureName)?.fixtureContentHash);
  if (selectedHash !== undefined) params.set('fixtureContentHash', selectedHash);
  return `${entry.route}?${params.toString()}`;
}

export const test = base.extend<Fixtures>({
  componentPage: async ({ browser }, use) => {
    const baseURL = environmentConfiguration().browserFixtureUrl;
    if (baseURL === undefined || baseURL.length === 0) {
      throw new Error('BROWSER_FIXTURE_URL must identify the fixture host.');
    }
    const contexts: BrowserContext[] = [];
    const diagnostics: string[] = [];
    try {
      await use({
        async open({ entry, theme, viewport, fixtureName, fixtureContentHash, hasTouch, onPage }) {
          const context = await browser.newContext({
            ...themeContextOptions(theme),
            ...(hasTouch === undefined ? {} : { hasTouch }),
            viewport: { width: viewport.width, height: viewport.height },
            baseURL,
          });
          // Only the fixture's own document stores the theme: an opaque-origin frame (a sandboxed
          // `srcdoc` such as an MCP App's) has no storage, and reading it there throws.
          await context.addInitScript(
            ([key, value, origin]) => {
              if (globalThis.location.origin !== origin) return;
              localStorage.setItem(key, value);
            },
            [THEME_STORAGE_KEY, theme, new URL(baseURL).origin] as const,
          );
          contexts.push(context);
          const page = await context.newPage();
          page.on('pageerror', (error) => diagnostics.push(`Page error: ${error.message}`));
          page.on('console', (message) => {
            if (message.type() === 'error' || message.type() === 'warning') {
              diagnostics.push(`Console ${message.type()}: ${message.text()}`);
            }
          });
          await onPage?.(page);
          await page.goto(buildRoute(entry, fixtureName, fixtureContentHash), {
            waitUntil: 'load',
          });
          await page.waitForSelector('#app > *', { state: 'visible' });
          const markdownEditors = page.locator('.markdown-editor-wrapper[data-mode="wysiwyg"]');
          if ((await markdownEditors.count()) > 0) {
            await page.waitForFunction(() =>
              Array.from(
                document.querySelectorAll('.markdown-editor-wrapper[data-mode="wysiwyg"]'),
              ).every((editor) => editor.getAttribute('data-ready') === 'true'),
            );
          }
          await page.evaluate(
            'const active = document.activeElement; if (active && typeof active.blur === "function") active.blur();',
          );
          return page;
        },
      });
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
    expect(diagnostics, `Unexpected fixture diagnostics:\n${diagnostics.join('\n')}`).toEqual([]);
  },
});

export { expect } from '@playwright/test';
