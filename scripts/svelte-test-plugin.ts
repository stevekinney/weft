/**
 * Bun plugin that compiles Svelte 5 components and rune modules for `bun
 * test`. Bun has no built-in `.svelte` loader, and `$state`/`$derived`/etc.
 * are compiler macros — a plain `.svelte.ts`/`.svelte.js` module needs
 * `svelte/compiler`'s `compileModule()` before Bun can run it, exactly like
 * a `.svelte` component needs `compile()`. `.svelte.js` matters too, not
 * just our own `.svelte.ts` files: `@testing-library/svelte-core` ships
 * uncompiled rune-using `.svelte.js` source (e.g. `props.svelte.js`) behind
 * its own package export conditions, relying on the CONSUMER's build tool to
 * compile it — the same pattern Cinder uses for its own component source.
 * Mirrors the proven pattern in `cinder/packages/components/scripts/svelte-plugin.ts`
 * (copied, not reinvented — that file is the canonical reference for this
 * incantation).
 *
 * IMPORTANT — this alone is not sufficient: `bun test` must also be run
 * with `--conditions browser --conditions svelte` (see `package.json`'s
 * `test` script; always use `bun run test`, not a bare `bun test`). Without
 * those flags, both `@lostgradient/cinder` and `svelte` itself resolve
 * through their `default`/`node` export condition (an SSR-only build for
 * both), and mounting any component fails with "not available on the
 * server". A `builder.onResolve()` hook was tried here to make this
 * flag-independent and does NOT work: Bun's runtime plugin hooks only fire
 * for import specifiers containing a literal `.` or `:`
 * (`node_modules/bun-types/bun.d.ts`, `Plugin` docstring), so bare package
 * specifiers like `svelte` or `@lostgradient/cinder` never reach a plugin's
 * `onResolve` at all — there is no in-plugin workaround for this, hence the
 * `--conditions` flags stay a hard requirement, not just a nice-to-have.
 *
 * @module scripts/svelte-test-plugin
 */
import type { BunPlugin } from 'bun';
import { compile, compileModule } from 'svelte/compiler';

export function svelteTestPlugin(): BunPlugin {
  return {
    name: 'svelte-test',
    setup(builder) {
      builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        const compileResult = compile(source, {
          filename: path,
          generate: 'client',
          css: 'external',
          dev: true,
        });
        return { contents: compileResult.js.code, loader: 'js' };
      });

      builder.onLoad({ filter: /\.svelte\.(js|ts)$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        const moduleSource = path.endsWith('.ts')
          ? new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
          : source;
        const compileResult = compileModule(moduleSource, {
          filename: path,
          generate: 'client',
          dev: true,
        });
        return { contents: compileResult.js.code, loader: 'js' };
      });
    },
  };
}
