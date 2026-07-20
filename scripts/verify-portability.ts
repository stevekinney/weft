/**
 * Build-time portability gate.
 *
 * Bundles the portable entry points for the `browser` target and asserts
 * that no platform-locked *static* imports leak into the output. Runtime-
 * guarded `require()` calls (behind `IS_BUN` / `typeof Bun` checks in the
 * portable runtime layer) are acceptable — the bundler preserves both
 * branches but the browser path never executes them.
 *
 * The key assertion: the bundle must *build successfully* for the browser
 * target, meaning the bundler can resolve all static imports. Unresolvable
 * `node:*` or `bun:*` static imports cause the build to fail, which is the
 * real portability check.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type PortableEntry = {
  name: string;
  entrypoint: string;
};

const PORTABLE_ENTRIES: PortableEntry[] = [
  { name: 'weft (root)', entrypoint: './src/index.ts' },
  { name: '@lostgradient/weft/client', entrypoint: './src/client/index.ts' },
  { name: '@lostgradient/weft/service-worker', entrypoint: './src/service-worker/index.ts' },
  { name: '@lostgradient/weft/storage/http', entrypoint: './src/storage/http.ts' },
  { name: '@lostgradient/weft/storage/cloudflare', entrypoint: './src/storage/cloudflare.ts' },
  { name: '@lostgradient/weft/storage/indexeddb', entrypoint: './src/storage/indexeddb.ts' },
  { name: '@lostgradient/weft/storage/resolve', entrypoint: './src/storage/resolve.ts' },
  {
    name: '@lostgradient/weft/storage/web-extension',
    entrypoint: './src/storage/web-extension.ts',
  },
  { name: '@lostgradient/weft/worker-protocol', entrypoint: './src/worker/protocol.ts' },
  { name: '@lostgradient/weft/server/handler', entrypoint: './src/server/handler.ts' },
];

/**
 * Patterns that indicate a platform-locked module leaked into the portable
 * bundle in an unguarded way.
 *
 * The portable runtime layer (`src/runtime/portable.ts`) intentionally
 * references `Bun.*` behind `IS_BUN` guards, and uses `process.getBuiltinModule`
 * for Node-side fallbacks. These are dead code in browsers and are not
 * flagged by static-import checks. Similarly, `StdioTransport` uses
 * `Bun.spawn` behind a dynamic `import()` in the transport factory, which
 * is only reachable when `kind === 'stdio'`.
 *
 * What IS forbidden:
 * - `bun:sqlite` — a storage backend leaked into the portable surface
 * - `bun:test` — test infrastructure leaked into production code
 * - `node:crypto` / `node:zlib` / `node:fs` — Node built-ins that browser
 *   bundlers cannot resolve, imported statically (runtime-loaded via
 *   `process.getBuiltinModule` is fine — it appears as a dynamic lookup)
 * - `Bun.spawn` — process-spawn API leaked into the portable surface
 */
const FORBIDDEN_STATIC_IMPORTS = [
  { pattern: /\bfrom\s*["']bun:sqlite["']/g, label: 'bun:sqlite import' },
  { pattern: /\brequire\(["']bun:sqlite["']\)/g, label: 'bun:sqlite require' },
  { pattern: /\bfrom\s*["']bun:test["']/g, label: 'bun:test import' },
  { pattern: /\brequire\(["']bun:test["']\)/g, label: 'bun:test require' },
  { pattern: /\bfrom\s*["']node:crypto["']/g, label: 'node:crypto import' },
  { pattern: /\brequire\(["']node:crypto["']\)/g, label: 'node:crypto require' },
  { pattern: /\bfrom\s*["']node:zlib["']/g, label: 'node:zlib import' },
  { pattern: /\brequire\(["']node:zlib["']\)/g, label: 'node:zlib require' },
  { pattern: /\bfrom\s*["']node:fs["']/g, label: 'node:fs import' },
  { pattern: /\brequire\(["']node:fs["']\)/g, label: 'node:fs require' },
  { pattern: /\bBun\.spawn\b/g, label: 'Bun.spawn usage' },
] as const;

const tempDir = mkdtempSync(join(tmpdir(), 'weft-portability-'));
let failures = 0;

try {
  for (const entry of PORTABLE_ENTRIES) {
    let entryFailures = 0;

    const result = await Bun.build({
      entrypoints: [entry.entrypoint],
      target: 'browser',
      format: 'esm',
      outdir: tempDir,
      minify: false,
      // Heavy optional dependencies — not part of the portable surface.
      external: ['@opentelemetry/api', 'lmdb', '@libsql/client', '@neondatabase/serverless'],
    });

    if (!result.success) {
      console.error(`  FAIL  ${entry.name} — browser build failed:`);
      for (const log of result.logs) {
        console.error('        ', log);
      }
      entryFailures++;
      failures++;
      continue;
    }

    // Check bundled output for forbidden static imports.
    for (const output of result.outputs) {
      const text = await output.text();
      for (const { pattern, label } of FORBIDDEN_STATIC_IMPORTS) {
        pattern.lastIndex = 0;
        const matches = text.match(pattern);
        if (matches && matches.length > 0) {
          console.error(
            `  FAIL  ${entry.name} — found ${String(matches.length)} occurrence(s) of ${label}`,
          );
          entryFailures++;
          failures++;
        }
      }
    }

    if (entryFailures === 0) {
      console.log(`  PASS  ${entry.name}`);
    }
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${String(failures)} portability check(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll portability checks passed.');
}
