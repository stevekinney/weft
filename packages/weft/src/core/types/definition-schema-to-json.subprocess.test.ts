import { describe, expect, it } from 'bun:test';

import {
  outcomeOf,
  rethrow,
  SCENARIO_HANG_GUARD_MILLISECONDS,
} from '../../testing/module-scope-scenario.test-support.ts';

// This spawns a real process, which takes seconds on a loaded host. The scenarios below run at
// module scope, off Bun's five-second per-test clock; each test rethrows its scenario's outcome.

/**
 * Verify the Valibot adapter in a fresh Bun process as well as the in-process
 * suite. The child must exit successfully; loader and dependency failures
 * remain test failures.
 */
const scenario1 = await outcomeOf(async () => {
  const proc = Bun.spawn(['bun', 'src/core/types/definition-schema-to-json.valibot-fixture.ts'], {
    timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
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
});

describe('definition-schema-to-json (subprocess gate)', () => {
  it('exits zero when the Valibot adapter fixture runs in a fresh Bun process', () =>
    rethrow(scenario1));
});
