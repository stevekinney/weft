import type { Component } from 'svelte';
import type { VisualFixture } from '../index.ts';

export type LazyModule<Value> = () => Promise<{ default: Value }>;

/**
 * What a fixture host's generated module map (`.playwright/fixture-modules.ts`, written by
 * `prepareManifest`) exports: the lazy fixture, host and application-fixture modules, and the
 * application fixtures each component declares.
 */
export type FixtureModuleMaps = {
  fixtureModules: Record<string, LazyModule<VisualFixture[]>>;
  hostModules: Record<string, LazyModule<Component<any>>>;
  appHostModules: Record<string, LazyModule<Component<any>>>;
  appFixtureDeclarations: Readonly<Record<string, readonly string[]>>;
};

export type LoadedFixture = {
  fixture: VisualFixture;
  component?: Component<any>;
};

function hostPath(sourcePath: string | undefined, host: string): string {
  if (host.startsWith('./app/')) return `./fixtures/${host.slice('./app/'.length)}`;
  if (sourcePath === undefined) throw new Error(`Source fixture owner missing for '${host}'.`);
  return `${sourcePath.slice(0, sourcePath.lastIndexOf('/'))}/${host.slice(2)}`;
}

function declaredAppFixtureNames(
  declarations: FixtureModuleMaps['appFixtureDeclarations'],
  component: string,
): readonly string[] {
  return Object.hasOwn(declarations, component) ? (declarations[component] ?? []) : [];
}

function appFixture(
  component: string,
  name: string,
  modules: FixtureModuleMaps,
): VisualFixture | undefined {
  if (
    !declaredAppFixtureNames(modules.appFixtureDeclarations, component).includes(name) ||
    modules.appHostModules[`./fixtures/${component}.svelte`] === undefined
  ) {
    return undefined;
  }
  return { name, host: `./app/${component}.svelte`, category: 'visual-contract' };
}

export async function loadFixture(
  component: string,
  name: string | null,
  modules: FixtureModuleMaps,
): Promise<LoadedFixture> {
  const owners = Object.entries(modules.fixtureModules).filter(([path]) =>
    path.endsWith(`/${component}/${component}-fixtures.ts`),
  );
  if (owners.length > 1) throw new Error(`Multiple fixture owners for '${component}'.`);
  const [sourcePath, sourceLoader] = owners[0] ?? [];
  const sourceModule = sourceLoader === undefined ? undefined : await sourceLoader();
  const source = sourceModule?.default;
  const fixture =
    source?.find((candidate) => candidate.name === (name ?? source[0]?.name)) ??
    appFixture(component, name ?? 'assertion', modules);
  if (fixture === undefined) throw new Error(`Fixture '${component}/${name}' was not found.`);

  if (typeof fixture.host !== 'string') return { fixture };
  const loader = fixture.host.startsWith('./app/')
    ? modules.appHostModules[hostPath(sourcePath, fixture.host)]
    : modules.hostModules[hostPath(sourcePath, fixture.host)];
  if (loader === undefined) throw new Error(`Fixture host '${fixture.host}' was not found.`);
  const hostModule = await loader();
  return { fixture, component: hostModule.default };
}
