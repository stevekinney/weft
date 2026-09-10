/**
 * Second installed-but-inactive revision fixture for `order-processing`
 * (WFT-115). Installs a deliberately incompatible candidate revision into
 * the workflow catalog via the real, published `buildWorkflowContract`/
 * `buildWorkflowRevisionManifest` functions (never a console
 * reimplementation of the engine's contract-building logic) so the e2e
 * suite can exercise the Registry → Revisions panel's refused-activation
 * path end to end.
 *
 * A refusal is a pure no-op — `weft.workflows.revisions.activate` never
 * mutates the active pointer for an incompatible candidate (see
 * `packages/weft/documentation/guides/workflow-versioning.md` and
 * `core/contract/compatibility.ts`'s own module doc) — so exercising this
 * path against a real seeded server is safe and repeatable; it never
 * disturbs the original `order-processing` revision every other fixture
 * track asserts against (`fixtures/workflows.ts`'s append-only contract).
 *
 * The candidate differs from the seeded original on three independent
 * axes, chosen so `checkWorkflowCompatibility` reports exactly the three
 * reasons `tests/e2e/07-activate-workflow-revision.spec.ts` asserts
 * verbatim:
 *   - `version: '2.0.0'` (the seeded original is unversioned, i.e.
 *     `DEFAULT_WORKFLOW_VERSION` = `'0.0.0'`) → `workflow-version-incompatible`
 *     (`checkVersionCompatibility` is exact-string equality, not semver-aware).
 *   - a different `inputSchema` → `contract-hash-mismatch`.
 *   - an explicit, distinct `revision` → `artifact-revision-mismatch`
 *     (unavoidable here regardless of content, since the default strict
 *     policy — `requireExactRevision: true` — requires an exact match, but
 *     named explicitly anyway for a deterministic, greppable e2e fixture id
 *     rather than a content-derived hash).
 *
 * `name-mismatch` and `manifest-version-unsupported` are correctly absent:
 * this candidate is still named `order-processing` and still uses
 * `WORKFLOW_REVISION_MANIFEST_VERSION`.
 */
import type { WorkflowRevisionManifest } from '@lostgradient/weft';
import { buildWorkflowContract, buildWorkflowRevisionManifest } from '@lostgradient/weft';
import type { DefinitionSchema } from '@lostgradient/weft/json-schema';

/** Opaque revision id the e2e suite asserts against directly. */
export const ORDER_PROCESSING_CANDIDATE_REVISION = 'order-processing-candidate-2';

/** Narrow structural interface — see `fixtures/workflows.ts` for the pattern this file follows. */
export interface WorkflowRevisionsEngine {
  workflows: {
    install(manifest: WorkflowRevisionManifest): Promise<unknown>;
  };
}

/**
 * Wraps a plain JSON Schema fragment as a `DefinitionSchema` (Standard JSON
 * Schema v1) — the shape `buildWorkflowContract`'s `WorkflowContractSource`
 * requires for `inputSchema`/`outputSchema`, per
 * `core/types/definition-schema.ts`'s own documented example. The seeded
 * fixture workflows normally get this for free from a validator library's
 * `~standard` marker (zod, etc.); this fixture has no validator, only a
 * literal schema, so it builds the marker directly rather than pulling in a
 * validation dependency for one dev-only fixture.
 */
function rawJsonSchema(schema: Record<string, unknown>): DefinitionSchema {
  return {
    '~standard': {
      version: 1,
      vendor: 'weft-ui-fixture',
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}

/** Installs the candidate revision. Never activates it — the point is an installed-but-not-active row for the Revisions panel to show, and for Activate to refuse. */
export async function seedWorkflowRevisions(engine: WorkflowRevisionsEngine): Promise<void> {
  const candidateContract = buildWorkflowContract({
    name: 'order-processing',
    version: '2.0.0',
    inputSchema: rawJsonSchema({
      type: 'object',
      required: ['orderId', 'amountCents', 'email', 'expedited'],
      properties: {
        orderId: { type: 'string' },
        amountCents: { type: 'number' },
        email: { type: 'string' },
        expedited: { type: 'boolean' },
      },
    }),
  });
  const candidateManifest = await buildWorkflowRevisionManifest(candidateContract, {
    revision: ORDER_PROCESSING_CANDIDATE_REVISION,
  });
  await engine.workflows.install(candidateManifest);
}
