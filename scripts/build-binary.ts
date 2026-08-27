#!/usr/bin/env bun

/**
 * Build a standalone Weft binary using `bun build --compile`.
 *
 * Produces a self-contained executable that bundles the Bun runtime, SQLite,
 * and the Weft server into a single file.
 *
 * Usage:
 *   bun run scripts/build-binary-main.ts                   # current platform
 *   bun run scripts/build-binary-main.ts --target darwin-arm64   # specific platform
 *   bun run scripts/build-binary-main.ts --all             # all 5 platforms
 *
 * @module build-binary
 */

import { join } from 'node:path';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** All supported compilation targets. */
const TARGETS = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-windows-x64',
] as const;

export type BunTarget = (typeof TARGETS)[number];

/** Map from user-facing target names to Bun's internal target identifiers. */
const TARGET_MAP: Record<string, BunTarget> = {
  'darwin-arm64': 'bun-darwin-arm64',
  'darwin-x64': 'bun-darwin-x64',
  'linux-x64': 'bun-linux-x64',
  'linux-arm64': 'bun-linux-arm64',
  'windows-x64': 'bun-windows-x64',
};

/** Derive the output filename for a given target. */
export function outputNameForTarget(target: BunTarget): string {
  const suffix = target.replace('bun-', 'weft-');
  if (target.includes('windows')) {
    return `${suffix}.exe`;
  }
  return suffix;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export type BuildBinaryArgs = {
  target: string | undefined;
  all: boolean;
  outdir: string;
  help: boolean;
};

export function parseBuildBinaryArguments(args: string[]): BuildBinaryArgs {
  const { values } = parseArgs({
    args,
    options: {
      target: { type: 'string', short: 't' },
      all: { type: 'boolean', default: false },
      outdir: { type: 'string', short: 'o', default: 'dist' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  return {
    target: values.target,
    all: values.all ?? false,
    outdir: values.outdir ?? 'dist',
    help: values.help ?? false,
  };
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const BUILD_BINARY_HELP = `
scripts/build-binary-main.ts - Compile Weft into a standalone binary

Usage: bun run scripts/build-binary-main.ts [options]

Options:
  -t, --target <platform>   Target platform (e.g., darwin-arm64, linux-x64)
      --all                 Compile for all supported platforms
  -o, --outdir <path>       Output directory (default: dist)
  -h, --help                Show this help message

Supported targets:
  darwin-arm64   macOS Apple Silicon
  darwin-x64     macOS Intel
  linux-x64      Linux x86_64
  linux-arm64    Linux ARM64
  windows-x64    Windows x86_64
`;

// ---------------------------------------------------------------------------
// Build logic
// ---------------------------------------------------------------------------

export interface BuildResult {
  target: string;
  outputPath: string;
  success: boolean;
  error?: string;
}

/**
 * Compile the CLI entrypoint for a single target using `bun build --compile`.
 *
 * The `--compile` flag is only available via the CLI, not the JS `Bun.build()` API,
 * so we shell out to the `bun` process.
 */
type BuildProcess = {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
};

type BuildProcessSpawner = (
  command: string[],
  options: { stdout: 'pipe'; stderr: 'pipe' },
) => BuildProcess;

export async function buildForTarget(
  bunTarget: BunTarget,
  outdir: string,
  spawnBuildProcess: BuildProcessSpawner = (command, options) => Bun.spawn(command, options),
): Promise<BuildResult> {
  const outputName = outputNameForTarget(bunTarget);
  const outputPath = join(outdir, outputName);

  try {
    const proc = spawnBuildProcess(
      [
        'bun',
        'build',
        '--compile',
        '--bytecode',
        '--format=esm',
        '--target',
        bunTarget,
        '--outfile',
        outputPath,
        '--sourcemap=external',
        '--minify',
        './src/cli-main.ts',
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    // Consume both stdout and stderr to prevent pipe buffer deadlock
    const [exitCode, , stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    if (exitCode !== 0) {
      return { target: bunTarget, outputPath, success: false, error: stderr.trim() };
    }

    return { target: bunTarget, outputPath, success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { target: bunTarget, outputPath, success: false, error: message };
  }
}

/** Resolve which targets to build based on CLI args. */
export function resolveTargets(
  args: BuildBinaryArgs,
  environment: { platform?: NodeJS.Platform; arch?: string } = {},
): BunTarget[] {
  if (args.all) {
    return [...TARGETS];
  }

  if (args.target) {
    const mapped = TARGET_MAP[args.target];
    if (!mapped) {
      const valid = Object.keys(TARGET_MAP).join(', ');
      throw new Error(`Unknown target '${args.target}'. Valid targets: ${valid}`);
    }
    return [mapped];
  }

  // Default: current platform
  const platformValue = environment.platform ?? process.platform;
  const archValue = environment.arch ?? process.arch;
  const platform = platformValue === 'win32' ? 'windows' : platformValue;
  const supportedArches: Record<string, string> = { arm64: 'arm64', x64: 'x64', x86_64: 'x64' };
  const arch = supportedArches[archValue];

  if (!arch) {
    throw new Error(
      `Unsupported CPU architecture '${archValue}'. Supported: ${Object.keys(supportedArches).join(', ')}`,
    );
  }

  const key = `${platform}-${arch}`;
  const mapped = TARGET_MAP[key];

  if (!mapped) {
    throw new Error(`Cannot detect current platform target. Got: ${key}`);
  }

  return [mapped];
}
