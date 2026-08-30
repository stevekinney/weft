/**
 * Playwright fixtures shared by every persona-flow spec (plan §11.4).
 *
 * ## Why route interception, not the `<ApiKeyEntry>` UI
 *
 * `src/app/app.svelte` mounts `<ApiKeyEntry>` in place of the shell only
 * when boot-time principal resolution 401s with no credential
 * (`resolvePrincipal(client, { credentialed: false })` — see that module's
 * doc). Driving that form on every test would work, but the entered key
 * lives in component state only (`src/lib/client.ts`'s `setApiKey()`:
 * "never `localStorage`, never a cookie"), so it evaporates on any full
 * navigation — brittle for flows that `page.goto()` a route directly
 * (reviews inbox, schedules, workers) rather than reaching it via in-app
 * links from `/`.
 *
 * Instead, `withApiKeyInjected` rewrites the `<script type="application/json"
 * id="weft-ui-config">` block on every DOCUMENT response (not
 * asset/XHR requests) to add `token`, matching the shape
 * `src/lib/config.ts`'s `readRuntimeConfig()` already validates. Every full
 * navigation — the first `page.goto()` and any later one — boots the app
 * already credentialed, so `app.svelte`'s boot probe succeeds immediately
 * and the shell mounts straight into `phase: 'ready'`. No test in this
 * suite needs to touch `<ApiKeyEntry>` itself; that surface is a Cinder
 * component-test concern (`src/app/auth/*.test.ts`), not this suite's.
 */
import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Page } from '@playwright/test';

import { E2E_API_KEY } from './e2e-constants.ts';

const CONFIG_SCRIPT_PATTERN =
  /(<script type="application\/json" id="weft-ui-config">)([\s\S]*?)(<\/script>)/;

/**
 * Parses the injected runtime-config JSON out of `html`, adds `token`, and
 * re-serializes it back into the same script tag. Throws (rather than
 * silently returning `html` unchanged) when the tag isn't found or its body
 * isn't valid JSON — a console that changed how it injects config would
 * otherwise leave this suite quietly running unauthenticated and every
 * scope-gated flow would fail downstream with a confusing 401, far from
 * this function.
 */
export function injectApiKeyIntoHtml(html: string, token: string): string {
  const match = CONFIG_SCRIPT_PATTERN.exec(html);
  if (!match) {
    throw new Error(
      'injectApiKeyIntoHtml: no #weft-ui-config script tag found in the served HTML — ' +
        "src/lib/config.ts's injected-config contract may have changed.",
    );
  }
  const [, open, body, close] = match;
  const config: Record<string, unknown> = JSON.parse((body ?? '').trim());
  config['token'] = token;
  return (
    html.slice(0, match.index) +
    open +
    JSON.stringify(config) +
    close +
    html.slice(match.index + match[0].length)
  );
}

async function installApiKeyInjection(page: Page): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (request.resourceType() !== 'document') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const contentType = response.headers()['content-type'] ?? '';
    if (!contentType.includes('text/html')) {
      await route.fulfill({ response });
      return;
    }
    const original = await response.text();
    await route.fulfill({ response, body: injectApiKeyIntoHtml(original, E2E_API_KEY) });
  });
}

/**
 * Polls every button/input's `background-color`/`color` across consecutive
 * animation frames until two consecutive samples are identical (or a bounded
 * number of frames elapses), so axe reads settled paint, not a
 * mid-transition blend.
 *
 * `foundation.css`'s reduced-motion rule (`*, ::before, ::after {
 * transition-duration: 0.01ms !important; }`, confirmed live against the
 * built CSS) collapses every Cinder transition to sub-frame length under
 * `use.reducedMotion: 'reduce'` (`playwright.config.ts`) — but "sub-frame"
 * still means the browser can paint an intermediate frame of an
 * interpolating `background-color`/`color` transition (e.g. a button's
 * disabled→enabled color swap, which every "fill the form, then check the
 * now-enabled submit button" step in this suite triggers) before settling.
 * Confirmed empirically, twice, with a fixed two-`requestAnimationFrame`
 * wait still in place: axe's own `color-contrast` check sampled a
 * DIFFERENT transitional blend on each run (`bgColor: '#adc1f3'` then
 * `'#5c79e7'`) on the identical "Submit decision" button, while a
 * `getComputedStyle` read moments later on the same element consistently
 * showed the correct settled `oklch(0.5 0.22 270)` background / `oklch(1 0
 * 0)` text (21:1) — so a FIXED frame count isn't a reliable bound here;
 * polling until the sample stops changing is.
 *
 * Cinder 0.21 added real `@starting-style` entry transitions to Modal and
 * Drawer, which exposed a second sampling hazard this poll alone cannot
 * see: the overlay PANEL fades in via `opacity`, and axe composites each
 * control's colors through that translucent ancestor — so a button whose
 * own `background-color`/`color` are already settled (signature stable)
 * still measures as a washed-out blend (observed: the drain dialog's
 * primary button flagged at 2.88:1 with bg `#8390ea` while its computed
 * resting style was the correct `oklch(0.5 0.22 270)` / 21:1). Two
 * additions close it: `waitForAnimationsToFinish` first awaits every
 * finite animation/transition on the page (near-instant under this
 * suite's `reducedMotion: 'reduce'`), and the signature below includes
 * `opacity` so an ancestor fade is itself detected as unsettled paint.
 */
async function waitForAnimationsToFinish(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // `Document.getAnimations()` already spans the whole document (the
    // `{ subtree }` option exists only on `Element.getAnimations()`).
    const finite = document.getAnimations().filter((animation) => {
      const timing = animation.effect?.getTiming();
      // Infinite animations (spinners, indeterminate progress) never
      // finish — awaiting them would deadlock; axe's contrast math is not
      // affected by them on this suite's screens.
      return timing !== undefined && timing.iterations !== Infinity;
    });
    await Promise.race([
      Promise.allSettled(finite.map((animation) => animation.finished)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  });
}

async function waitForPaintSettle(page: Page): Promise<void> {
  const MAX_FRAMES = 30;
  await page.evaluate((maxFrames) => {
    // `signature` must stay nested inside this `page.evaluate` callback to
    // run in the browser context; it cannot be hoisted to this file's
    // module scope (a genuinely separate JS realm), which is what the rule
    // below suggests.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    function signature(): string {
      return Array.from(
        document.querySelectorAll('button, input, textarea, select, dialog, [role="dialog"]'),
      )
        .map((el) => {
          const cs = getComputedStyle(el);
          return `${cs.backgroundColor}|${cs.color}|${cs.opacity}`;
        })
        .join(';');
    }
    return new Promise<void>((resolve) => {
      let previous = signature();
      let frame = 0;
      function tick(): void {
        frame += 1;
        const current = signature();
        if (current === previous || frame >= maxFrames) {
          resolve();
          return;
        }
        previous = current;
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }, MAX_FRAMES);
}

/**
 * Fails the test when the page has a serious or critical axe violation.
 * Moderate/minor findings are out of scope for this gate — plan §11.4's
 * "zero serious/critical axe violations" bar — surfaced but not asserted,
 * so a moderate finding never blocks a merge while still being visible in
 * the error message if the count is nonzero.
 */
async function assertNoSeriousAxeViolations(page: Page, screenLabel: string): Promise<void> {
  await waitForAnimationsToFinish(page);
  await waitForPaintSettle(page);
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  const summary = blocking
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.help} — ${violation.nodes.length} node(s)`,
    )
    .join('\n');
  expect(
    blocking,
    `axe found serious/critical violations at "${screenLabel}":\n${summary}`,
  ).toEqual([]);
}

export const test = base.extend<{ checkA11y: (screenLabel: string) => Promise<void> }>({
  page: async ({ page }, use) => {
    await installApiKeyInjection(page);
    await use(page);
  },
  checkA11y: async ({ page }, use) => {
    await use((screenLabel: string) => assertNoSeriousAxeViolations(page, screenLabel));
  },
});

export { expect };
