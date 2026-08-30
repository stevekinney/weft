/**
 * Compiles the package's single published JS entry point (plan §1, §2,
 * T10.2): `src/mount.ts` → `dist/mount.js` + `dist/mount.d.ts`.
 *
 * `src/mount.ts` only imports Node/Bun builtins (`node:path`, `node:url`)
 * plus a type-only import from `@lostgradient/weft/server` (elided by
 * `verbatimModuleSyntax`), so `Bun.build` needs no `external` list — the
 * output has zero runtime dependencies. Declarations are emitted
 * separately by `tsc` (`tsconfig.build.json`) because `Bun.build` does not
 * generate `.d.ts` files.
 *
 * Runs after `vite build` in the `build` script — `vite build` clears
 * `dist/` first (`build.emptyOutDir`), so ordering matters: this script
 * must run second, or it would be wiped along with the SPA assets.
 */
import { $ } from 'bun';

const result = await Bun.build({
  entrypoints: ['./src/mount.ts'],
  outdir: './dist',
  target: 'bun',
  format: 'esm',
  naming: '[name].js',
});

if (!result.success) {
  for (const message of result.logs) {
    console.error(message);
  }
  process.exit(1);
}

await $`bunx tsc -p tsconfig.build.json`;

console.log('Built dist/mount.js + dist/mount.d.ts');
