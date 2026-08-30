import { describe, expect, it } from 'bun:test';

/**
 * Bun's test runner refuses `require('@valibot/to-json-schema')` mid-suite
 * with "Unexpected require target" — the require resolves cleanly only when
 * the file is invoked on its own. The in-suite Valibot test (in
 * `definition-schema-to-json.test.ts`) probes that behavior and uses
 * `it.skipIf(!canLoadValibot)`, which means the in-suite case can silently
 * skip if the loader is broken in CI.
 *
 * This test closes that gap by spawning a child Bun process that runs a
 * small standalone fixture (`definition-schema-to-json.valibot-fixture.ts`)
 * which exercises the Valibot adapter unconditionally — no `skipIf`, no
 * probe — and exits non-zero on any failure. The child's exit code is the
 * gate: any breakage in the Valibot conversion path or the
 * `@valibot/to-json-schema` package fails this test. It is intentionally
 * small (no DI, no fixtures beyond the script itself) and proves the
 * shipped adapter path actually works under CI without restructuring the
 * loader.
 */
describe('definition-schema-to-json (subprocess gate)', () => {
  it('exits zero when the Valibot adapter fixture runs in a fresh Bun process', async () => {
    const proc = Bun.spawn(['bun', 'src/core/types/definition-schema-to-json.valibot-fixture.ts'], {
      cwd: import.meta.dir + '/../../..',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...Bun.env, FORCE_COLOR: '0' },
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      throw new Error(
        `Valibot adapter fixture failed (exit ${exitCode}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    expect(exitCode).toBe(0);
  }, 30_000);
});
