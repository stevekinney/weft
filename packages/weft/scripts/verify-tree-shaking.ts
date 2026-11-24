import { existsSync } from 'node:fs';
import { join } from 'node:path';

const manifest = (await Bun.file('package.json').json()) as {
  exports: Record<string, Record<string, string>>;
  bin: Record<string, string>;
};

for (const [specifier, conditions] of Object.entries(manifest.exports)) {
  for (const [condition, target] of Object.entries(conditions)) {
    if (!existsSync(target)) throw new Error(`${specifier} (${condition}) is missing ${target}`);
  }
}
for (const [name, target] of Object.entries(manifest.bin)) {
  if (!(await Bun.file(target).text()).startsWith('#!/usr/bin/env bun\n')) {
    throw new Error(`${name} is missing its Bun shebang`);
  }
}

const entries = [
  ['storage', 'dist/embedded/storage/src/index.js'],
  ['IndexedDB', 'dist/embedded/storage-indexeddb/src/index.js'],
  ['worker authoring', 'dist/worker/authoring.js'],
  ['generated worker authoring', 'dist/worker/generated-authoring.js'],
] as const;
const forbidden = /bun:sqlite|better-sqlite3|@libsql\/client|@neondatabase\/serverless|\blmdb\b/;
for (const [label, entry] of entries) {
  const result = await Bun.build({ entrypoints: [join('.', entry)], target: 'browser' });
  if (!result.success) throw new Error(`${label} did not bundle for the browser`);
  for (const output of result.outputs) {
    if (forbidden.test(await output.text())) {
      throw new Error(`${label} pulled a server-only storage backend into its browser bundle`);
    }
  }
}
console.log('Weft exports, CLI entry points, and portable storage and worker bundles verified');
