#!/usr/bin/env bun
/**
 * Verify that no file imports from a designated `internals.ts` module unless
 * it lives within the allowed glob.
 *
 * The allowlist lives at `documentation/internal-imports-allowlist.json`. Each
 * entry pairs an internals module path (relative to repo root) with the glob
 * permitted to import it — for example, the engine and context internals
 * modules are each importable only from their own sibling directory. The
 * script trivially passes when the allowlist is empty.
 *
 * Triggered as part of `bun run lint`.
 */

import { Glob, file } from 'bun';
import { join, relative } from 'node:path';

interface AllowEntry {
  internalsModule: string;
  allowedFrom: string;
}

const repoRoot = join(import.meta.dir, '..');
const allowlistPath = join(repoRoot, 'documentation/internal-imports-allowlist.json');

let allowlist: AllowEntry[] = [];
try {
  allowlist = JSON.parse(await file(allowlistPath).text());
} catch (error) {
  console.error(`Could not read allowlist at ${allowlistPath}:`, error);
  process.exit(1);
}

if (allowlist.length === 0) {
  console.log('OK: internal-imports allowlist is empty; nothing to check.');
  process.exit(0);
}

const violations: { file: string; line: number; importedFrom: string; internalsModule: string }[] =
  [];

const glob = new Glob('src/**/*.ts');
for await (const relPath of glob.scan({ cwd: repoRoot })) {
  const absPath = join(repoRoot, relPath);
  const source = await file(absPath).text();
  const lines = source.split('\n');

  for (const [index, lineText] of lines.entries()) {
    // Match `import ... from 'path'` and `export ... from 'path'`
    const match = lineText.match(/(?:import|export)[^'"]*['"]([^'"]+)['"]/);
    if (!match) continue;
    const specifier = match[1];
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;

    // Resolve the specifier relative to this file's directory
    const fileDir = absPath.slice(0, absPath.lastIndexOf('/'));
    const resolved = join(fileDir, specifier);
    const resolvedRelativeToRoot = relative(repoRoot, resolved);

    for (const entry of allowlist) {
      if (resolvedRelativeToRoot === entry.internalsModule) {
        // Check if the importer is within the allowed glob
        const allowedGlob = new Glob(entry.allowedFrom);
        if (!allowedGlob.match(relPath)) {
          violations.push({
            file: relPath,
            line: index + 1,
            importedFrom: specifier,
            internalsModule: entry.internalsModule,
          });
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Forbidden internals imports:');
  for (const v of violations) {
    console.error(
      `  ${v.file}:${v.line}  imports '${v.importedFrom}' (resolves to ${v.internalsModule})`,
    );
  }
  process.exit(1);
}

console.log(`OK: ${allowlist.length} internals module(s) checked; no forbidden imports.`);
