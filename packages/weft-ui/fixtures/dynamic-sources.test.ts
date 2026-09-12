/**
 * Contract tests for `fixtures/dynamic-sources.ts` (WFT-116), run against a
 * REAL `Engine` rather than a double. The dev harness and
 * `tests/e2e/09-preload-dynamic-source.spec.ts` both assume this fixture
 * produces three specific engine states — `idle` before any load, `ready`
 * after a successful preload, and `failed` with a bounded failure category
 * after a rejected one. If any of that stops being true, the e2e suite
 * fails with a confusing UI assertion; these tests fail with the actual
 * reason instead.
 *
 * The first test is also what keeps `DYNAMIC_SOURCE_LOADABLE_REVISION` from
 * going stale: a revision is a content identity, so editing
 * `dynamic-workflows/invoice-reconciliation.ts` changes it, and the strict
 * default compatibility policy then refuses the preload as
 * `artifact-revision-mismatch`.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { Engine, getWorkflowRevisionDiagnostics } from '@lostgradient/weft';

import {
  DYNAMIC_SOURCE_FAILING_REVISION,
  DYNAMIC_SOURCE_LOADABLE_REVISION,
  DYNAMIC_SOURCE_WORKFLOW_NAME,
  seedDynamicSources,
} from './dynamic-sources.ts';

let engines: Engine[] = [];

async function seededEngine(): Promise<Engine> {
  const engine = await Engine.create({ workflows: {} });
  engines.push(engine);
  seedDynamicSources(engine);
  return engine;
}

afterEach(async () => {
  const pending = engines;
  engines = [];
  await Promise.all(pending.map((engine) => engine[Symbol.asyncDispose]()));
});

describe('seedDynamicSources', () => {
  it('registers both revisions as idle, having loaded neither', async () => {
    const engine = await seededEngine();

    for (const revision of [DYNAMIC_SOURCE_LOADABLE_REVISION, DYNAMIC_SOURCE_FAILING_REVISION]) {
      const diagnostics = await getWorkflowRevisionDiagnostics(
        engine,
        DYNAMIC_SOURCE_WORKFLOW_NAME,
        revision,
      );
      expect(diagnostics.source).toBeDefined();
      expect(diagnostics.source?.kind).toBe('module');
      expect(diagnostics.source?.state).toBe('idle');
      expect(diagnostics.source?.requestedRevision).toBe(revision);
      expect(diagnostics.source?.loadDurationMs).toBeUndefined();
      expect(diagnostics.source?.waiterCount).toBe(0);
      expect(diagnostics.installed).toBe(false);
    }
  });

  it('preloads the loadable revision to ready, pinning its content-derived revision', async () => {
    const engine = await seededEngine();

    const record = await engine.workflows.preload(
      DYNAMIC_SOURCE_WORKFLOW_NAME,
      DYNAMIC_SOURCE_LOADABLE_REVISION,
    );
    // If this fails, `dynamic-workflows/invoice-reconciliation.ts` changed:
    // copy the revision this reports into `DYNAMIC_SOURCE_LOADABLE_REVISION`.
    expect(record.manifest.revision).toBe(DYNAMIC_SOURCE_LOADABLE_REVISION);

    const diagnostics = await getWorkflowRevisionDiagnostics(
      engine,
      DYNAMIC_SOURCE_WORKFLOW_NAME,
      DYNAMIC_SOURCE_LOADABLE_REVISION,
    );
    expect(diagnostics.source?.state).toBe('ready');
    expect(typeof diagnostics.source?.loadDurationMs).toBe('number');
    expect(diagnostics.source?.lastFailureCategory).toBeUndefined();
    expect(diagnostics.installed).toBe(true);
  });

  it('records a bounded failure category when the failing revision rejects', async () => {
    const engine = await seededEngine();

    await expect(
      engine.workflows.preload(DYNAMIC_SOURCE_WORKFLOW_NAME, DYNAMIC_SOURCE_FAILING_REVISION),
    ).rejects.toThrow();

    const diagnostics = await getWorkflowRevisionDiagnostics(
      engine,
      DYNAMIC_SOURCE_WORKFLOW_NAME,
      DYNAMIC_SOURCE_FAILING_REVISION,
    );
    expect(diagnostics.source?.state).toBe('failed');
    // The whole point of the console re-fetching diagnostics after a refused
    // preload: the wire fault carries no cause, so this category is the only
    // classified account of why the load failed.
    expect(diagnostics.source?.lastFailureCategory).toBeDefined();
    expect(diagnostics.installed).toBe(false);
  });

  it('reports no dynamic source at all for a name that was never registered as one', async () => {
    const engine = await seededEngine();

    const diagnostics = await getWorkflowRevisionDiagnostics(engine, 'never-registered', 'r1');
    expect(diagnostics.source).toBeUndefined();
    expect(diagnostics.installed).toBe(false);
  });
});
