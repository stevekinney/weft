/**
 * Test-only builders for the workflow refresh operations' tests: an immutable
 * candidate artifact for `checkout`, and a refresh source that serves it.
 */

import type { WorkflowRefreshArtifact, WorkflowRefreshSource } from '../../core/catalog/index.ts';
import { buildWorkflowContract } from '../../core/contract/build.ts';
import { buildWorkflowRevisionManifest } from '../../core/contract/manifest.ts';
import type { RegisteredWorkflowDefinition } from '../../core/types/workflow-registry.ts';

export const REFRESH_TEST_WORKFLOW = 'checkout';

const definition: RegisteredWorkflowDefinition = {
  type: REFRESH_TEST_WORKFLOW,
  version: '1.0.0',
  tags: [],
};

/** A well-formed artifact for `checkout` at `revision` and workflow `version`. */
export async function refreshArtifact(
  revision: string,
  version = '1.0.0',
): Promise<WorkflowRefreshArtifact> {
  const manifest = await buildWorkflowRevisionManifest(
    buildWorkflowContract({ name: REFRESH_TEST_WORKFLOW, version }),
    { revision },
  );
  const identity = { name: manifest.name, revision: manifest.revision };
  const runtime = 'bun@1.4.2';
  const bytes = new TextEncoder().encode(JSON.stringify({ manifest, identity, runtime }));
  const digestBytes = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  const digest = `sha256:${[...new Uint8Array(digestBytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  return { manifest, bytes, digest, identity, runtime };
}

/**
 * A source serving `artifact()`'s current value, answering a request that
 * carries the last ETag with `304`. Overrides replace any callback.
 */
export function refreshSource(
  artifact: () => WorkflowRefreshArtifact,
  overrides: Partial<WorkflowRefreshSource> = {},
): WorkflowRefreshSource {
  return {
    fetch: async ({ etag }) =>
      etag === undefined
        ? { status: 200 as const, etag: artifact().digest, artifact: artifact() }
        : { status: 304 as const, etag },
    warm: async () => definition,
    validateRuntime: () => {},
    ...overrides,
  };
}
