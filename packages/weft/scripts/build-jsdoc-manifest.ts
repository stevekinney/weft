/**
 * Developer helper: write the in-memory JSDoc manifest to tmp/jsdoc-manifest.json
 * for inspection. The committed verification gates (audit, check-declaration,
 * extract-doctests) build the manifest on the fly via scripts/lib/jsdoc-manifest.ts
 * and do not read this file.
 *
 * Run this when you want to grep/diff the manifest as a snapshot, e.g. while
 * editing the prose-only name pattern in the shared library.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { buildManifest } from './lib/jsdoc-manifest.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const OUTPUT_PATH = resolve(REPO_ROOT, 'tmp/jsdoc-manifest.json');

function main(): void {
  const manifest = buildManifest();
  const directory = dirname(OUTPUT_PATH);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const total = manifest.entries.length;
  const reachable = manifest.entries.filter((e) => e.publicFaces.length > 0).length;
  const orphaned = total - reachable;
  const exampleRequired = manifest.entries.filter(
    (e) => e.classification === 'example-required',
  ).length;
  const proseOnly = manifest.entries.filter((e) => e.classification === 'prose-only').length;
  const notPublic = manifest.entries.filter((e) => e.classification === 'not-public').length;

  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`  ${total} total entries`);
  console.log(`  ${reachable} reachable from a public entry point`);
  console.log(`  ${orphaned} not-public candidates (publicFaces: [])`);
  console.log(
    `  classification: example-required=${exampleRequired} prose-only=${proseOnly} not-public=${notPublic}`,
  );
}

main();
