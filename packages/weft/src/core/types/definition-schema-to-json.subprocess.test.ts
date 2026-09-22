import { describe, expect, it } from 'bun:test';

/**
 * Verify the Valibot adapter in a fresh Bun process as well as the in-process
 * suite. The child must exit successfully; loader and dependency failures
 * remain test failures.
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
