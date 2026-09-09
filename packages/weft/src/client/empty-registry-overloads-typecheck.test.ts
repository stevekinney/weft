import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

// Spawns a real `tsc --noEmit` subprocess against an isolated tsconfig, on
// purpose: it is the only way to reproduce a genuinely unaugmented
// `WorkflowRegistry` (see the comment atop consumer.ts for why the shared
// tsconfig.test-d.json / tsconfig.package-test-d.json programs cannot). Not
// added to `LOAD_SENSITIVE_TEST_PATHS` — the fixture is a tiny type-only
// module (three declared client instances, nine calls), so the cold `tsc`
// start dominates wall-clock cost the same way codegen-typecheck.test.ts's
// fixture does; if this test starts flaking under the pre-commit hook's
// parallel full-suite run the way that one did before isolation, move it
// there rather than raise the LOAD_SENSITIVE_TEST_PATHS cap without cause.
const FIXTURE_DIR = resolve(import.meta.dir, '__fixtures__/no-workflow-registry');

describe('client fallback-overload genericity fixture (no WorkflowRegistry augmentation)', () => {
  it('compiles start/startOrSignal/schedule with an explicit type argument against WeftClient, LocalClient, and HttpClient', async () => {
    const tscPath = Bun.resolveSync('typescript/bin/tsc', FIXTURE_DIR);
    const proc = Bun.spawn(['bun', tscPath, '-p', FIXTURE_DIR, '--noEmit'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (exitCode !== 0) {
      throw new Error(`fallback-overload fixture failed (exit ${exitCode}):
${stdout}
${stderr}`);
    }
    expect(exitCode).toBe(0);
    // Regression coverage: temporarily dropping this overload's own
    // `<TName extends string>` on all three client types (rewriting
    // UnknownNameWhenRegistryEmpty<TName> to
    // UnknownNameWhenRegistryEmpty<string>) makes every call in consumer.ts
    // fail with "does not satisfy the constraint 'never'" against the
    // OTHER (KnownWorkflowName) overload — confirmed manually before this
    // test was added. This proves the fixture is non-vacuous: it fails
    // without the fix and passes with it, not just "passes" unconditionally.
  }, 60_000);
});
