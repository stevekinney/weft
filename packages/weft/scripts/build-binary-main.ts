#!/usr/bin/env bun

import { existsSync, mkdirSync } from 'node:fs';

import {
  BUILD_BINARY_HELP,
  buildForTarget,
  type BuildResult,
  parseBuildBinaryArguments,
  resolveTargets,
} from './build-binary.ts';

const args = parseBuildBinaryArguments(Bun.argv.slice(2));

if (args.help) {
  console.log(BUILD_BINARY_HELP);
  process.exit(0);
}

if (!existsSync(args.outdir)) {
  mkdirSync(args.outdir, { recursive: true });
}

const targets = resolveTargets(args);
console.log(
  `Building Weft binary for: ${targets.map((target) => target.replace('bun-', '')).join(', ')}`,
);

const results: BuildResult[] = [];

for (const target of targets) {
  console.log(`  Compiling ${target.replace('bun-', '')}...`);
  const result = await buildForTarget(target, args.outdir);
  results.push(result);

  if (result.success) {
    console.log(`  ✓ ${result.outputPath}`);
  } else {
    console.error(`  ✗ ${target}: ${result.error}`);
  }
}

const failures = results.filter((result) => !result.success);
if (failures.length > 0) {
  console.error(`\n${failures.length} target(s) failed.`);
  process.exit(1);
}

console.log('\nBinary build complete!');
