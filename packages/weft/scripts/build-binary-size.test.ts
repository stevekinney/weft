import { afterAll, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { buildForTarget, resolveTargets, type BunTarget } from './build-binary.ts';

const outputDirectory = join(import.meta.dir, '..', 'dist', `test-binary-size-${process.pid}`);

afterAll(() => {
  rmSync(outputDirectory, { recursive: true, force: true });
});

const currentTarget = resolveTargets({
  target: undefined,
  all: false,
  outdir: outputDirectory,
  help: false,
})[0]!;
const targets: BunTarget[] = [currentTarget];
const requestedTarget = Bun.env.WEFT_BINARY_SIZE_TARGET;
if (requestedTarget) {
  const target = resolveTargets({
    target: requestedTarget,
    all: false,
    outdir: outputDirectory,
    help: false,
  })[0]!;
  if (target !== currentTarget) targets.push(target);
}

// Bun 1.4.0 measurements, compiled with --bytecode --minify and the matching target:
// darwin-arm64 30,090,528; darwin-x64 30,266,496; linux-x64 30,044,160;
// linux-arm64 30,015,488; windows-x64 30,045,184 payload bytes.
// The retired 100 MB total-binary cap counted roughly 79 MiB of Bun's linux-x64 runtime.
// Keep the limit on Weft's payload, measured against a trivial entry in the same run.
const measuredPayloadBytes: Partial<Record<BunTarget, number>> = {
  'bun-darwin-arm64': 30_090_528,
  'bun-darwin-x64': 30_266_496,
  'bun-linux-x64': 30_044_160,
  'bun-linux-arm64': 30_015_488,
  'bun-windows-x64': 30_045_184,
};

test('the baseline entry uses the same compiler flags as the Weft entry', async () => {
  const commands: string[][] = [];
  const spawn = (command: string[]) => {
    commands.push(command);
    return {
      exited: Promise.resolve(0),
      stdout: new Response('').body,
      stderr: new Response('').body,
    };
  };

  await buildForTarget('bun-linux-x64', 'dist/weft', spawn, 'linux');
  await buildForTarget('bun-linux-x64', 'dist/baseline', spawn, 'linux', 'baseline.ts');

  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual([
    ...commands[0]!.slice(0, 8),
    'dist/baseline/weft-linux-x64',
    ...commands[0]!.slice(9, 11),
    'baseline.ts',
  ]);
});

for (const target of targets) {
  test(`the ${target} payload excludes the Bun runtime`, async () => {
    const baselineEntry = join(outputDirectory, 'baseline-entry.ts');
    await Bun.write(baselineEntry, 'console.log("baseline");\n');

    const weft = await buildForTarget(target, join(outputDirectory, `${target}-weft`));
    const baseline = await buildForTarget(
      target,
      join(outputDirectory, `${target}-baseline`),
      undefined,
      process.platform,
      baselineEntry,
    );

    expect(weft.success).toBe(true);
    expect(baseline.success).toBe(true);
    expect(existsSync(weft.outputPath)).toBe(true);
    expect(existsSync(baseline.outputPath)).toBe(true);

    const binaryBytes = Bun.file(weft.outputPath).size;
    const runtimeBytes = Bun.file(baseline.outputPath).size;
    const payloadBytes = binaryBytes - runtimeBytes;
    const measured = measuredPayloadBytes[target];
    console.log(
      `${target}: Bun ${Bun.version}, binary=${binaryBytes}, baseline=${runtimeBytes}, payload=${payloadBytes}`,
    );
    if (measured === undefined) throw new Error(`No measured payload ceiling for ${target}`);
    expect(payloadBytes).toBeGreaterThan(0);
    expect(payloadBytes).toBeLessThan(measured * 1.25);
  }, 60_000);
}
