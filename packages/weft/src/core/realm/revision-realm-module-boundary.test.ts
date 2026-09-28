/**
 * The stable host never imports workflow implementation artifacts (COR-117's
 * criterion, extended by COR-249's own coordinator decision: "Workflow
 * implementation modules are imported only inside realms when revision
 * realms are enabled").
 *
 * Proved by static module-graph analysis, not by running any code: a
 * `Bun.build()` bundle of the host-side pool/registry entrypoint must not
 * contain {@link WORKFLOW_IMPLEMENTATION_SENTINEL} anywhere in its output,
 * while a bundle of the realm-side worker bootstrap fixture — which
 * legitimately imports the workflow-implementation fixture, the same way a
 * real revision realm's bootstrap imports real workflow code — must contain
 * it. The positive control matters as much as the negative one: without it,
 * a misspelled or dead sentinel would make the host-side assertion pass for
 * the wrong reason.
 */
import { describe, expect, it } from 'bun:test';

import { WORKFLOW_IMPLEMENTATION_SENTINEL } from './__fixtures__/workflow-implementation.fixture.ts';

async function bundledText(entrypoint: URL): Promise<string> {
  const result = await Bun.build({ entrypoints: [entrypoint.pathname], target: 'bun' });
  const texts = await Promise.all(result.outputs.map((output) => output.text()));
  return texts.join('\n');
}

describe('revision-realm module graph boundary', () => {
  it('a bundle of the realm-side worker bootstrap DOES contain the workflow implementation (positive control)', async () => {
    const text = await bundledText(
      new URL('./__fixtures__/revision-realm-worker-entry.ts', import.meta.url),
    );
    expect(text).toContain(WORKFLOW_IMPLEMENTATION_SENTINEL);
  });

  it('a bundle of the host-side revision realm pool does NOT contain the workflow implementation', async () => {
    const text = await bundledText(new URL('./revision-realm-pool.ts', import.meta.url));
    expect(text).not.toContain(WORKFLOW_IMPLEMENTATION_SENTINEL);
  });

  it('a bundle of the host-side revision realm registry does NOT contain the workflow implementation', async () => {
    const text = await bundledText(new URL('./revision-realm-registry.ts', import.meta.url));
    expect(text).not.toContain(WORKFLOW_IMPLEMENTATION_SENTINEL);
  });

  it('a bundle of the host-side WorkerRealm itself does NOT contain the workflow implementation', async () => {
    const text = await bundledText(new URL('./worker-realm.ts', import.meta.url));
    expect(text).not.toContain(WORKFLOW_IMPLEMENTATION_SENTINEL);
  });

  it('a bundle of the realm-side child-process bootstrap DOES contain the workflow implementation (positive control, COR-246)', async () => {
    const text = await bundledText(
      new URL('./__fixtures__/revision-realm-child-process-entry.ts', import.meta.url),
    );
    expect(text).toContain(WORKFLOW_IMPLEMENTATION_SENTINEL);
  });

  it('a bundle of the host-side ChildProcessRealm itself does NOT contain the workflow implementation (COR-246)', async () => {
    const text = await bundledText(new URL('./child-process-realm.ts', import.meta.url));
    expect(text).not.toContain(WORKFLOW_IMPLEMENTATION_SENTINEL);
  });
});
