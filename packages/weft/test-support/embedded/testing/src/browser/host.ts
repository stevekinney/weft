/// <reference lib="dom" />
import { flushSync, mount, type Component } from 'svelte';

import type { VisualFixture } from '../visual-fixtures.ts';
import { loadFixture, type FixtureModuleMaps } from './fixture-loader.ts';
import FixtureRoot from './fixture-root.svelte';
import { applySnapshotMode, isSnapshotMode } from './snapshot-mode.ts';

export type FixtureHostOptions = {
  /** The suite's generated module map (`.playwright/fixture-modules.ts`). */
  modules: FixtureModuleMaps;
  /** Components mounted directly by slug when no fixture host renders them. */
  components?: Record<string, Component<any>>;
  /** Runs once the stored theme is applied, the way an application installs its theme guard. */
  installThemeGuard?: () => void;
  /** Runs while the fixture root initializes, to publish context every fixture reads. */
  provideContext?: () => void;
};

function fixtureProps(fixture: VisualFixture): Record<string, any> {
  const props = 'props' in fixture ? fixture.props : undefined;
  return props !== null && typeof props === 'object' && !Array.isArray(props) ? props : {};
}

function themeFromStorage(): void {
  const theme = localStorage.getItem('browser-fixture-theme') ?? 'light';
  document.documentElement.dataset['theme'] = theme;
  document.documentElement.dataset['cinderTheme'] = theme;
  document.documentElement.style.colorScheme = theme;
}

async function start(options: FixtureHostOptions, target: Element): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const componentName = decodeURIComponent(window.location.pathname.split('/').at(-1) ?? '');
  themeFromStorage();
  options.installThemeGuard?.();
  applySnapshotMode(isSnapshotMode(params));
  const { fixture, component: fixtureComponent } = await loadFixture(
    componentName,
    params.get('fixture'),
    options.modules,
  );
  const Component = fixtureComponent ?? options.components?.[componentName];
  if (Component === undefined) throw new Error(`Component '${componentName}' was not found.`);
  mount(FixtureRoot, {
    target,
    props: {
      component: Component,
      componentProps: fixtureProps(fixture),
      ...(options.provideContext === undefined ? {} : { provideContext: options.provideContext }),
    },
  });
  flushSync();
}

/**
 * Mounts the fixture the page's URL names (`/page/<component>?fixture=<name>`) into `#app`. A
 * failure empties the target and rethrows, so a spec waiting for the fixture fails on the error.
 */
export function startFixtureHost(options: FixtureHostOptions): void {
  const target = document.getElementById('app');
  if (target === null) throw new Error('[corvidae fixtures] #app target not found');
  void start(options, target).catch((error: unknown) => {
    target.replaceChildren();
    throw error;
  });
}
