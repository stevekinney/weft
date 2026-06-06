import { describe, expect, it } from 'bun:test';
import { join, resolve } from 'node:path';

// Isolated because it spawns a real `tsc --noEmit` subprocess: its wall-clock
// cost is unbounded under CPU contention and cannot be made deterministic with
// fake timers (the work happens in an external process, not the test's event
// loop). Listed in `LOAD_SENSITIVE_TEST_PATHS` so the pre-commit full-suite run
// skips it while CI runs it in isolation with full CPU. See
// scripts/husky/run-tests.ts.
const FIXTURE_DIR = resolve(import.meta.dir, '__fixtures__/codegen');
const TYPECHECK_FIXTURE_DIR = join(FIXTURE_DIR, 'typecheck');

describe('generated .d.ts typecheck fixture', () => {
  it('compiles under strict TypeScript with `@ts-expect-error` lines satisfied', async () => {
    // Resolve the TypeScript compiler from the fixture root and run it via
    // `bun` directly, rather than `bunx tsc`. `bunx` adds ~1.7s of package
    // resolution per call and offers nothing here; resolving the package entry
    // works in this worktree's layout (no local node_modules — deps resolve from
    // the project root) without relying on a PATH shim.
    const tscPath = Bun.resolveSync('typescript/bin/tsc', TYPECHECK_FIXTURE_DIR);
    const proc = Bun.spawn(['bun', tscPath, '-p', TYPECHECK_FIXTURE_DIR, '--noEmit'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (exitCode !== 0) {
      throw new Error(`typecheck fixture failed (exit ${exitCode}):\n${stdout}\n${stderr}`);
    }
    expect(exitCode).toBe(0);
    // The fixture imports `Engine` as a type only (see consumer.ts), so the
    // compile loads type declarations rather than the full engine runtime
    // closure. Measured ~3s isolated. Isolation (not a longer per-test timeout)
    // is the real fix: a cold `tsc` subprocess contending for CPU under the
    // full-suite parallel run flaked even at a 60s budget.
  }, 60_000);
});
