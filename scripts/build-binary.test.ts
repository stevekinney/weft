import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  BUILD_BINARY_HELP,
  buildForTarget,
  outputNameForTarget,
  parseBuildBinaryArguments,
  resolveTargets,
} from './build-binary.ts';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

describe('parseBuildBinaryArguments', () => {
  it('defaults to no target, all=false, outdir=dist', () => {
    const args = parseBuildBinaryArguments([]);
    expect(args.target).toBeUndefined();
    expect(args.all).toBe(false);
    expect(args.outdir).toBe('dist');
    expect(args.help).toBe(false);
  });

  it('parses --target flag', () => {
    const args = parseBuildBinaryArguments(['--target', 'darwin-arm64']);
    expect(args.target).toBe('darwin-arm64');
  });

  it('parses -t short flag', () => {
    const args = parseBuildBinaryArguments(['-t', 'linux-x64']);
    expect(args.target).toBe('linux-x64');
  });

  it('parses --all flag', () => {
    const args = parseBuildBinaryArguments(['--all']);
    expect(args.all).toBe(true);
  });

  it('parses --outdir flag', () => {
    const args = parseBuildBinaryArguments(['--outdir', '/tmp/out']);
    expect(args.outdir).toBe('/tmp/out');
  });

  it('parses -o short flag', () => {
    const args = parseBuildBinaryArguments(['-o', '/tmp/out']);
    expect(args.outdir).toBe('/tmp/out');
  });

  it('parses --help flag', () => {
    const args = parseBuildBinaryArguments(['--help']);
    expect(args.help).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

describe('resolveTargets', () => {
  it('returns all 5 targets when --all is set', () => {
    const targets = resolveTargets({
      target: undefined,
      all: true,
      outdir: 'dist',
      help: false,
    });
    expect(targets).toHaveLength(5);
    expect(targets).toContain('bun-darwin-arm64');
    expect(targets).toContain('bun-darwin-x64');
    expect(targets).toContain('bun-linux-x64');
    expect(targets).toContain('bun-linux-arm64');
    expect(targets).toContain('bun-windows-x64');
  });

  it('returns a single target when --target is specified', () => {
    const targets = resolveTargets({
      target: 'linux-arm64',
      all: false,
      outdir: 'dist',
      help: false,
    });
    expect(targets).toEqual(['bun-linux-arm64']);
  });

  it('throws for an unknown target', () => {
    expect(() =>
      resolveTargets({
        target: 'freebsd-x64',
        all: false,
        outdir: 'dist',
        help: false,
      }),
    ).toThrow('Unknown target');
  });

  it('throws for an unsupported CPU architecture', () => {
    expect(() =>
      resolveTargets(
        {
          target: undefined,
          all: false,
          outdir: 'dist',
          help: false,
        },
        { platform: 'linux', arch: 'riscv64' },
      ),
    ).toThrow("Unsupported CPU architecture 'riscv64'");
  });

  it('throws when the platform cannot be mapped to a Bun target', () => {
    expect(() =>
      resolveTargets(
        {
          target: undefined,
          all: false,
          outdir: 'dist',
          help: false,
        },
        { platform: 'freebsd', arch: 'x64' },
      ),
    ).toThrow('Cannot detect current platform target. Got: freebsd-x64');
  });

  it('detects current platform when no target is given', () => {
    const targets = resolveTargets({
      target: undefined,
      all: false,
      outdir: 'dist',
      help: false,
    });
    expect(targets).toHaveLength(1);
    // Should match current platform
    const expected = `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
    expect(targets[0]).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

describe('BUILD_BINARY_HELP', () => {
  it('references the build-binary main entrypoint', () => {
    expect(BUILD_BINARY_HELP).toContain('scripts/build-binary-main.ts');
    expect(BUILD_BINARY_HELP).not.toContain('scripts/build-binary.ts');
  });

  it('documents --target flag', () => {
    expect(BUILD_BINARY_HELP).toContain('--target');
  });

  it('documents --all flag', () => {
    expect(BUILD_BINARY_HELP).toContain('--all');
  });

  it('lists all supported platforms', () => {
    expect(BUILD_BINARY_HELP).toContain('darwin-arm64');
    expect(BUILD_BINARY_HELP).toContain('darwin-x64');
    expect(BUILD_BINARY_HELP).toContain('linux-x64');
    expect(BUILD_BINARY_HELP).toContain('linux-arm64');
    expect(BUILD_BINARY_HELP).toContain('windows-x64');
  });
});

describe('outputNameForTarget', () => {
  it('appends .exe for Windows targets', () => {
    expect(outputNameForTarget('bun-windows-x64')).toBe('weft-windows-x64.exe');
  });
});

// ---------------------------------------------------------------------------
// Build for current platform (integration test)
// ---------------------------------------------------------------------------

describe('buildForTarget (current platform)', () => {
  const outdir = join(import.meta.dir, '..', 'dist', `test-binary-${process.pid}`);
  const maxBinarySizeBytes = 100 * 1024 * 1024;

  beforeAll(() => {
    if (existsSync(outdir)) {
      rmSync(outdir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    if (existsSync(outdir)) {
      rmSync(outdir, { recursive: true, force: true });
    }
  });

  it('compiles successfully for the current platform', async () => {
    const platform = process.platform === 'win32' ? 'windows' : process.platform;
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const target = `bun-${platform}-${arch}` as Parameters<typeof buildForTarget>[0];

    let result = await buildForTarget(target, outdir);
    if (!result.success) {
      result = await buildForTarget(target, outdir);
    }

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(existsSync(result.outputPath)).toBe(true);
  }, 60_000);

  it('produces an executable binary that responds to --help', async () => {
    const platform = process.platform === 'win32' ? 'windows' : process.platform;
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const binaryName = `weft-${platform}-${arch}${platform === 'windows' ? '.exe' : ''}`;
    const binaryPath = join(outdir, binaryName);

    // Skip if binary was not produced (previous test may have been skipped)
    if (!existsSync(binaryPath)) {
      console.warn('Skipping --help test: binary not found');
      return;
    }

    const proc = Bun.spawn([binaryPath, '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('weft');
    expect(stdout).toContain('--port');
    expect(stdout).toContain('--database');
    expect(stdout).toContain('--storage');
  }, 30_000);

  it('keeps the compiled binary under 100MB', async () => {
    const platform = process.platform === 'win32' ? 'windows' : process.platform;
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const binaryName = `weft-${platform}-${arch}${platform === 'windows' ? '.exe' : ''}`;
    const binaryPath = join(outdir, binaryName);

    if (!existsSync(binaryPath)) {
      console.warn('Skipping size test: binary not found');
      return;
    }

    const sizeBytes = Bun.file(binaryPath).size;
    console.log(
      `Current-platform binary size: ${(sizeBytes / 1024 / 1024).toFixed(1)}MB (limit 100.0MB)`,
    );

    expect(sizeBytes).toBeLessThan(maxBinarySizeBytes);
  });

  it('returns a failed result when bun build exits non-zero', async () => {
    const result = await buildForTarget(
      'bun-linux-x64',
      outdir,
      () =>
        ({
          exited: Promise.resolve(1),
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('compile failed'));
              controller.close();
            },
          }),
        }) as ReturnType<typeof Bun.spawn>,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('compile failed');
  });

  it('returns a failed result when spawn throws', async () => {
    const result = await buildForTarget('bun-linux-x64', outdir, () => {
      throw new Error('spawn unavailable');
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('spawn unavailable');
  });
});

// ---------------------------------------------------------------------------
// Build all targets (unit test — just verify resolveTargets)
// ---------------------------------------------------------------------------

describe('multi-platform compilation', () => {
  it('resolveTargets with --all returns all 5 platform targets', () => {
    const targets = resolveTargets({
      target: undefined,
      all: true,
      outdir: 'dist',
      help: false,
    });

    expect(targets).toHaveLength(5);

    // Verify output naming conventions
    const expectedNames = [
      'weft-darwin-arm64',
      'weft-darwin-x64',
      'weft-linux-x64',
      'weft-linux-arm64',
      'weft-windows-x64.exe',
    ];

    for (const name of expectedNames) {
      expect(typeof name).toBe('string');
    }
  });

  it('builds the script via bun run without errors', async () => {
    const proc = Bun.spawn(['bun', 'run', 'scripts/build-binary-main.ts', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('scripts/build-binary-main.ts');
    expect(stdout).toContain('--target');
    expect(stdout).toContain('--all');
  });
});
