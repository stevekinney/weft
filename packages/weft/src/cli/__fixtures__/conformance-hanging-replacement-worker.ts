#!/usr/bin/env bun

/**
 * A worker command whose first launch is the conforming fixture and whose
 * second launch never connects. The reconnect check spawns that second launch
 * as the replacement worker, so it times out waiting for the replacement to
 * register. The second launch records its process id in the state directory
 * named by its first argument, so a test can prove the run stopped it.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ConformanceHangingReplacementWorkerFixture = 'hanging-replacement';

const stateDirectory = process.argv[2];
if (stateDirectory === undefined) {
  process.stderr.write('a state directory argument is required\n');
  process.exit(2);
}

const firstLaunchMarker = join(stateDirectory, 'first-launch');
if (existsSync(firstLaunchMarker)) {
  writeFileSync(join(stateDirectory, 'replacement.pid'), String(process.pid));
  // Never register; stay alive until the conformance run stops this process.
  setInterval(() => {}, 60_000);
} else {
  writeFileSync(firstLaunchMarker, '');
  await import('./conformance-worker.ts');
}
