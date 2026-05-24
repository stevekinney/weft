import { expect } from 'bun:test';

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { BunPlugin } from 'bun';
import type { DOMWindow } from 'jsdom';
import { JSDOM } from 'jsdom';

/**
 * Tracks temporary files and directories generated while compiling a Svelte
 * harness module so the owning suite can remove them in its own `afterEach`.
 *
 * The helper owns the push/cleanup symmetry; the suite controls when cleanup
 * runs relative to its other teardown.
 */
export type GeneratedArtifactTracker = {
  /** Record a generated file to remove during {@link GeneratedArtifactTracker.cleanup}. */
  trackFile(path: string): void;
  /** Record a generated directory to remove during {@link GeneratedArtifactTracker.cleanup}. */
  trackDirectory(path: string): void;
  /** Remove every tracked file (force) and directory (force + recursive), clearing the lists. */
  cleanup(): void;
};

/**
 * Create a {@link GeneratedArtifactTracker}. Each dashboard Svelte suite makes
 * one and calls `cleanup()` from its own `afterEach`.
 */
export function createGeneratedArtifactTracker(): GeneratedArtifactTracker {
  const generatedFiles: string[] = [];
  const generatedDirectories: string[] = [];

  return {
    trackFile(path: string): void {
      generatedFiles.push(path);
    },
    trackDirectory(path: string): void {
      generatedDirectories.push(path);
    },
    cleanup(): void {
      for (const generatedFile of generatedFiles.splice(0)) {
        rmSync(generatedFile, { force: true });
      }
      for (const generatedDirectory of generatedDirectories.splice(0)) {
        rmSync(generatedDirectory, { force: true, recursive: true });
      }
    },
  };
}

/**
 * Compile a temporary Svelte harness module written to disk, dynamically import
 * it, and return its exports as `unknown`. The caller narrows/casts the result
 * to its own module type beside that type's definition so the unchecked
 * contract stays local.
 *
 * The temp-file extension is significant and is **not** standardized:
 * `bun-plugin-svelte` selects its load behavior by filename filter, so a
 * `.svelte.ts` file is routed through Svelte's `compileModule` (runes / module
 * compilation) while a plain `.ts` file is bundled as ordinary TypeScript. Each
 * suite passes the extension its harness requires.
 */
export async function compileSvelteHarnessModule(options: {
  /** Directory the harness module is written into — typically `new URL('.', import.meta.url).pathname`. */
  componentDirectory: string;
  /** Stable prefix for the generated artifact names, e.g. `'date-range-picker-harness'`. */
  harnessBaseName: string;
  /** Temp-file extension; preserves each suite's compiler path (see function docs). */
  harnessExtension: '.svelte.ts' | '.ts';
  /** Component-specific harness source string. */
  source: string;
  /** Tracker that records the generated file and output directory for cleanup. */
  tracker: GeneratedArtifactTracker;
}): Promise<unknown> {
  const { componentDirectory, harnessBaseName, harnessExtension, source, tracker } = options;

  const harnessPath = join(
    componentDirectory,
    `.${harnessBaseName}.${crypto.randomUUID()}${harnessExtension}`,
  );
  await Bun.write(harnessPath, source);
  tracker.trackFile(harnessPath);

  const sveltePluginSpecifier = 'bun-plugin-svelte';
  const sveltePluginModule = (await import(sveltePluginSpecifier)) as {
    SveltePlugin: (options: { forceSide: 'client'; development: boolean }) => BunPlugin;
  };

  const outputDirectory = join(
    componentDirectory,
    `.${harnessBaseName}.${crypto.randomUUID()}.compiled`,
  );
  // Track the output directory before building so a failed build still gets
  // its (possibly partial) output cleaned up.
  tracker.trackDirectory(outputDirectory);

  const result = await Bun.build({
    entrypoints: [harnessPath],
    target: 'browser',
    format: 'esm',
    outdir: outputDirectory,
    plugins: [sveltePluginModule.SveltePlugin({ forceSide: 'client', development: false })],
  });

  expect(result.success).toBe(true);
  const outputPath = result.outputs[0]?.path;
  if (typeof outputPath !== 'string') {
    throw new Error('Svelte component build did not produce an output file');
  }

  return await import(pathToFileURL(outputPath).href);
}

/**
 * Install a JSDOM-backed global surface plus `requestAnimationFrame` /
 * `cancelAnimationFrame` shims, saving previous property descriptors. Returns a
 * teardown that restores prior descriptors (deleting keys that did not
 * previously exist) and closes the window.
 *
 * The base global set is the intersection both dashboard suites share.
 * `extraGlobals` lets a suite add element constructors it needs (e.g.
 * `HTMLButtonElement`, `MouseEvent`) without re-listing the common set.
 */
export function installDashboardDom(
  extraGlobals?: (window: DOMWindow) => Record<string, unknown>,
): () => void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
  });
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    SVGElement: dom.window.SVGElement,
    Text: dom.window.Text,
    Comment: dom.window.Comment,
    Document: dom.window.Document,
    DocumentFragment: dom.window.DocumentFragment,
    Event: dom.window.Event,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    navigator: dom.window.navigator,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback): number =>
      setTimeout(() => callback(Date.now()), 0) as unknown as number,
    cancelAnimationFrame: (handle: number): void => clearTimeout(handle),
    ...extraGlobals?.(dom.window),
  };
  const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();

  for (const [key, value] of Object.entries(replacements)) {
    previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  return () => {
    for (const [key, descriptor] of previousDescriptors) {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, key);
      } else {
        Object.defineProperty(globalThis, key, descriptor);
      }
    }
    dom.window.close();
  };
}
