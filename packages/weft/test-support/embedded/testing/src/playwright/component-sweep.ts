import { expect, test } from '@playwright/test';
import type {
  ComponentEntry,
  FixtureCategory,
  InteractionStep,
  ManifestFixtureEntry,
  Theme,
  Viewport,
  ViewportName,
} from '../index.ts';
import {
  applyInteractions,
  captureScreenshot,
  evaluateAxeGate,
  runAxe,
  writeScreenshotMetadata,
} from '../index.ts';

type ComponentPage = {
  open(args: {
    entry: ComponentEntry;
    theme: Theme;
    viewport: Viewport;
    fixtureName?: string;
    fixtureContentHash?: string;
  }): Promise<import('@playwright/test').Page>;
};

function fixtureCategory(fixture: ManifestFixtureEntry): FixtureCategory {
  return fixture.category;
}

function fixtureInteractions(fixture: ManifestFixtureEntry) {
  return fixture.interact ?? [];
}

function fixtureMasks(fixture: ManifestFixtureEntry) {
  return fixture.mask;
}

async function captureState(
  page: import('@playwright/test').Page,
  key: { slug: string; theme: Theme; viewport: ViewportName; fixture: string },
  entry: ComponentEntry,
  category: FixtureCategory,
  route: string,
  fixtureContentHash: string,
  masks: ManifestFixtureEntry['mask'],
): Promise<void> {
  await captureScreenshot(page, key, masks === undefined ? undefined : { masks });
  await writeScreenshotMetadata({
    key,
    component: entry.name,
    category,
    route,
    fixtureContentHash,
    mask: masks,
  });
}

async function assertAxe(
  page: import('@playwright/test').Page,
  key: { slug: string; theme: Theme; viewport: ViewportName; fixture: string },
  category: FixtureCategory,
): Promise<void> {
  const buckets = await runAxe(page, key);
  test.info().annotations.push({
    type: 'axe',
    description: `C/S/M/m: ${buckets.critical.length}/${buckets.serious.length}/${buckets.moderate.length}/${buckets.minor.length}`,
  });
  test.info().annotations.push({ type: 'category', description: category });
  const decision = evaluateAxeGate(key, buckets);
  if (decision.status === 'allowed') {
    test.info().annotations.push({
      type: 'axe-allowed',
      description: `Allow-listed blocking violation(s): ${decision.reason}`,
    });
    return;
  }
  if (decision.status === 'fail') expect(decision.violations, decision.message).toHaveLength(0);
}

export async function runFixtureSweep(
  componentPage: ComponentPage,
  entry: ComponentEntry,
  theme: Theme,
  viewport: Viewport,
  fixture: ManifestFixtureEntry,
): Promise<void> {
  const page = await componentPage.open({
    entry,
    theme,
    viewport,
    fixtureName: fixture.name,
    fixtureContentHash: fixture.fixtureContentHash,
  });

  const key = {
    slug: entry.slug,
    theme,
    viewport: viewport.name,
    fixture: fixture.name,
  };
  const fixtureContentHash = fixture.fixtureContentHash;
  const currentUrl = new URL(page.url());
  const route = `${currentUrl.pathname}${currentUrl.search}`;

  const category = fixtureCategory(fixture);
  const masks = fixtureMasks(fixture);
  const isMobileTabsKeyboardFixture =
    entry.slug === 'tabs' && viewport.name === 'mobile' && fixture.name === 'keyboard-next';
  const interactionSteps: InteractionStep[] = isMobileTabsKeyboardFixture
    ? [
        { action: 'click', target: { role: 'combobox', name: 'Tab' } },
        { action: 'press', target: { role: 'combobox', name: 'Tab' }, key: 'ArrowDown' },
        { action: 'press', target: { role: 'combobox', name: 'Tab' }, key: 'Enter' },
      ]
    : fixtureInteractions(fixture);
  const hasInteractions = interactionSteps.length > 0;
  const restingKey = hasInteractions ? { ...key, fixture: `${fixture.name}-resting` } : key;

  // Every fixture has a resting-state capture. Interaction fixtures
  // use a second key so their resulting state remains pixel-checked.
  await captureState(
    page,
    restingKey,
    entry,
    hasInteractions ? 'visual-contract' : category,
    route,
    fixtureContentHash,
    masks,
  );

  // Apply interaction steps (e.g. click trigger, focus input) before
  // accessibility assertions. Resting-state capture above remains
  // independent of the transition's resulting state.
  if (interactionSteps.length > 0) {
    await applyInteractions(page, interactionSteps, {
      component: entry.slug,
      fixture: fixture.name,
    });
    if (isMobileTabsKeyboardFixture) {
      await expect(page.locator('.cinder-tab-panel[data-cinder-value="activity"]')).toBeVisible();
    }
    await expect(page.locator('[data-cinder-position-ready="false"]')).toHaveCount(0);
    await captureScreenshot(page, key, masks === undefined ? undefined : { masks });
    await writeScreenshotMetadata({
      key,
      component: entry.name,
      category,
      route,
      fixtureContentHash,
      interact: interactionSteps,
      mask: masks,
    });
  }

  await assertAxe(page, key, category);
}
