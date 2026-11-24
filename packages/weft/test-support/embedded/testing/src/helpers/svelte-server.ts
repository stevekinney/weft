import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { spawnWithHangGuard } from '../hang-guard.ts';

const compileProgram = `
import { sveltePlugin } from '@lostgradient/testing';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
const { sourcePaths, root, conditions } = await Bun.stdin.json();
if (typeof document !== 'undefined' || typeof window !== 'undefined') {
  throw new Error('Server rendering must start without DOM globals');
}
const sveltePackageDirectories = new Map();
function requiresSvelteCompilation(resolved) {
  if (/\\.svelte(?:\\.[jt]s)?$/.test(resolved)) return true;
  let directory = dirname(resolved);
  if (sveltePackageDirectories.has(directory)) return sveltePackageDirectories.get(directory);
  const initialDirectory = directory;
  while (directory !== dirname(directory)) {
    const manifestPath = join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const compile = manifest.name !== 'svelte' && Boolean(manifest.svelte || manifest.peerDependencies?.svelte);
      sveltePackageDirectories.set(initialDirectory, compile);
      return compile;
    }
    directory = dirname(directory);
  }
  return false;
}
const result = await Bun.build({
  entrypoints: sourcePaths,
  root,
  naming: {
    entry: '[dir]/[name].[ext]',
    asset: 'assets/[name]-[hash].[ext]',
    chunk: 'chunks/[name]-[hash].[ext]',
  },
  target: 'bun',
  conditions,
  plugins: [sveltePlugin({ generate: 'server' }), {
    name: 'preserve-source-dependency-ownership',
    setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, ({ path, importer, resolveDir }) => {
        if (path.startsWith('@lostgradient/')) return undefined;
        if (path === 'esm-env' || path.startsWith('esm-env/')) return undefined;
        if (/^(node|bun):/.test(path)) return { path, external: true };
        const resolved = Bun.resolveSync(path, importer ? dirname(importer) : resolveDir);
        return { path: resolved, external: !requiresSvelteCompilation(resolved) };
      });
    },
  }],
});
if (!result.success) throw new AggregateError(result.logs, 'Server component compilation failed');
const artifacts = new Map(result.outputs.filter((output) => output.kind === 'entry-point')
  .map((output) => [resolve(root, output.path), output]));
const code = await Promise.all(sourcePaths.map(async (sourcePath) => {
  const name = join(dirname(sourcePath), basename(sourcePath, extname(sourcePath)) + '.js');
  const artifact = artifacts.get(name);
  if (!artifact) throw new Error('Missing server component artifact: ' + sourcePath);
  return artifact.text();
}));
process.stdout.write(JSON.stringify(code));
`;

const renderProgram = `
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { render } from 'svelte/server';
import { fork } from 'svelte';
const { code, props, directory, importOnly } = await Bun.stdin.json();
if (typeof document !== 'undefined' || typeof window !== 'undefined') {
  throw new Error('Server rendering must start without DOM globals');
}
let forkRejected = false;
try { fork(() => {}); } catch { forkRejected = true; }
if (!forkRejected) throw new Error('Expected the real Svelte server runtime');
const entry = join(directory, 'component.ts');
await Bun.write(entry, code);
const component = await import(pathToFileURL(entry).href);
const output = importOnly ? '' : render(component.default, { props }).body;
if (typeof document !== 'undefined' || typeof window !== 'undefined') {
  throw new Error('Server component import installed DOM globals');
}
process.stdout.write(JSON.stringify(output));
`;

const packageRoot = resolve(import.meta.dir, '../..');
// Test source is immutable during a run. Cache compilation, never component instances or renders.
const serverSources = new Map<string, Promise<string>>();

function serializeServerInput(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, (_key, value: unknown) => {
    if (typeof value === 'function' || typeof value === 'symbol') {
      throw new TypeError(
        'Server props must contain data; define callbacks and snippets in a Svelte fixture.',
      );
    }
    return value;
  });
}

async function runServerProgram(
  program: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  // Through the hang guard, which kills a child that never exits after 120 s of awake time and
  // starts Bun with `--no-install`.
  const child = spawnWithHangGuard([process.execPath, '--eval', program], {
    cwd: packageRoot,
    stdin: new TextEncoder().encode(serializeServerInput(payload)),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [status, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (status !== 0 || errors !== '')
    throw new Error(`Server execution failed (${status}): ${errors}`);
  return JSON.parse(output) as unknown;
}

type SvelteServerOptions = {
  conditions?: readonly string[];
};

function serverSourceKey(sourcePath: string, conditions: readonly string[]): string {
  return `${sourcePath}\u0000${JSON.stringify(conditions)}`;
}

function commonSourceDirectory(sourcePaths: readonly string[]): string {
  let directory = dirname(sourcePaths[0]!);
  for (const source of sourcePaths.slice(1)) {
    let path = relative(directory, source);
    while (isAbsolute(path) || path === '..' || path.startsWith('../')) {
      const parent = dirname(directory);
      if (parent === directory) throw new Error('Server fixtures must share a filesystem root');
      directory = parent;
      path = relative(directory, source);
    }
  }
  return directory;
}

function compileMissingSources(
  sourcePaths: readonly string[],
  conditions: readonly string[],
): void {
  const missing = [...new Set(sourcePaths)].filter(
    (sourcePath) => !serverSources.has(serverSourceKey(sourcePath, conditions)),
  );
  if (missing.length === 0) return;

  const bundle = runServerProgram(compileProgram, {
    sourcePaths: missing,
    root: commonSourceDirectory(missing),
    conditions,
  });
  for (const [index, sourcePath] of missing.entries()) {
    const key = serverSourceKey(sourcePath, conditions);
    const compilation = bundle
      .then((result) => {
        const code: unknown = Array.isArray(result) ? result[index] : undefined;
        if (typeof code !== 'string') throw new Error('Server compiler returned invalid output');
        return code;
      })
      .catch((error: unknown) => {
        serverSources.delete(key);
        throw error;
      });
    serverSources.set(key, compilation);
  }
}

/** Compile related fixtures together to share dependency transforms without sharing render state. */
export async function prepareSvelteServerSources(
  sourcePaths: readonly string[],
  options: SvelteServerOptions = {},
): Promise<void> {
  const paths = sourcePaths.map((sourcePath) => resolve(sourcePath));
  const conditions = [...(options.conditions ?? ['svelte'])];
  compileMissingSources(paths, conditions);
  await Promise.all(
    paths.map((sourcePath) => serverSources.get(serverSourceKey(sourcePath, conditions))!),
  );
}

/** Prepare one fixture, keeping the condition selection identical to its render. */
export async function prepareSvelteServerSource(
  sourcePath: string,
  options: SvelteServerOptions = {},
): Promise<void> {
  await prepareSvelteServerSources([sourcePath], options);
}

async function runServerComponent(
  sourcePath: string,
  props: Record<string, unknown>,
  importOnly: boolean,
  options: SvelteServerOptions,
): Promise<string> {
  const conditions = [...(options.conditions ?? ['svelte'])];
  const absolute = resolve(sourcePath);
  compileMissingSources([absolute], conditions);
  const code = await serverSources.get(serverSourceKey(absolute, conditions));
  if (code === undefined) throw new Error('Missing prepared server source: ' + sourcePath);
  const directory = await mkdtemp(join(packageRoot, 'node_modules/.svelte-ssr-'));
  try {
    const output = await runServerProgram(renderProgram, { code, props, directory, importOnly });
    if (typeof output !== 'string') throw new Error('Server renderer returned invalid output');
    return output;
  } finally {
    await rm(directory, { recursive: true });
  }
}

/** Compile and render source with the real server runtime in an isolated Bun process. */
export function renderSvelteOnServer(
  sourcePath: string,
  props: Record<string, unknown> = {},
  options: SvelteServerOptions = {},
): Promise<string> {
  return runServerComponent(sourcePath, props, false, options);
}

/** Evaluate the complete server component graph without installing DOM globals. */
export async function importSvelteOnServer(sourcePath: string): Promise<void> {
  await runServerComponent(sourcePath, {}, true, {});
}
