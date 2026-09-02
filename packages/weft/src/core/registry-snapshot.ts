/**
 * Pure builder that captures a snapshot of the engine's locally-registered
 * workflows and activities, with their JSON Schemas. This is the data source
 * behind the `GET /v1/registry` REST endpoint and (later) the MCP server.
 *
 * The output is a plain object designed to be safe for JSON serialization.
 * Absent metadata fields are omitted (never `null`, never `{}`); converter
 * exceptions surface as a typed {@link RegistrySchemaConversionError} (see
 * its JSDoc for what reaches the wire vs server logs).
 *
 * **v2.** Each registered workflow's schema/description/tags/message
 * metadata is packaged as a {@link WorkflowRevisionManifest} (`core/contract`,
 * WFT-5) rather than a flat `Record<name, entry>` — `workflows` is a sorted
 * array and `activeRevisions` is the `name -> revision` pointer map a
 * consumer resolves the "currently active" manifest through. Building a
 * manifest hashes the normalized contract (`crypto.subtle`), so this module
 * is async where v1 was not.
 *
 * **Ordering guarantee.** `workflows` is sorted by `(name, revision)` via
 * {@link compareWorkflowManifests} — see that export's JSDoc for why the
 * revision tiebreak can never actually fire through this builder.
 * `activities` keys are inserted in alphabetical (codepoint) order, and
 * signal/update/query keys inside each manifest's `contract` the same way.
 * Workflow and activity names cannot be integer-like (the name grammar
 * requires a leading letter or underscore), but signal/update/query names
 * accept any string, so integer-like message names could theoretically be
 * reordered by JS engines despite the explicit sort. Clients that want to
 * protect themselves from future registry sources should still sort
 * `Object.keys(...)` before presenting or diffing snapshot entries.
 *
 * The per-workflow entry/message/scoped-activity conversion this module
 * folds into each manifest lives in `registry-workflow-manifest.ts` — see
 * that module's doc for why it is a separate file.
 *
 * @module core/registry-snapshot
 */
import type { ActivityMetadata } from './activity-registry.ts';
import { compareCodepoint } from './compare-codepoint.ts';
import type { WorkflowRevisionManifest } from './contract/index.ts';
import type { Engine } from './engine.ts';
import { MAX_REGISTRY_WORKFLOW_COUNT, RegistryWorkflowCountLimitError } from './registry-limits.ts';
import { convertSchema, RegistrySchemaConversionError } from './registry-schema-conversion.ts';
import { buildOneWorkflowManifest } from './registry-workflow-manifest.ts';

export {
  buildWorkflowManifestForType,
  RegistryManifestLimitError,
  type RegistryMessageEntry,
  type RegistryWorkflowEntry,
} from './registry-workflow-manifest.ts';
export { RegistrySchemaConversionError, RegistryWorkflowCountLimitError };

/**
 * Current registry contract version. Future incompatible changes to the
 * snapshot shape must bump this number; the codegen CLI rejects unknown
 * versions with a clear upgrade message.
 */
export const REGISTRY_VERSION = 2;

/**
 * Metadata reported per activity in a registry snapshot.
 *
 * `tags` is intentionally omitted: the registry feeds `weft codegen`, which
 * models activities as TypeScript function signatures. Tags are catalog
 * metadata for documentation/observability surfaces and don't appear on a
 * function type. Workflows include tags because the workflow registry
 * augmentation point (`WorkflowRegistry`) is an interface where extra
 * metadata can be attached structurally; activity names are now typed
 * per-workflow via the builder's `.activities({...})` step, so there is no
 * global activity-type registry to attach metadata to.
 */
export type RegistryActivityEntry = {
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** Engine assigns a default queue when none is specified, so this is always populated. */
  queue: string;
  description?: string;
  retry?: ActivityMetadata['retry'];
  timeout?: ActivityMetadata['timeout'];
};

/**
 * Snapshot of every locally-registered workflow and activity, suitable for
 * serialization as the `GET /v1/registry` response body.
 *
 * `workflows` carries one {@link WorkflowRevisionManifest} per registered
 * workflow, sorted by {@link compareWorkflowManifests}. `activeRevisions`
 * points each workflow name at the `revision` of its currently active
 * manifest in `workflows` — today that is always the manifest a consumer
 * resolves, since the engine registers exactly one implementation per name;
 * the pointer exists so a future multi-revision registry source does not
 * require another wire-shape bump. `activities` is unchanged from v1: a
 * flat `Record<name, entry>`, since activities are not versioned contracts.
 */
export type RegistrySnapshot = {
  registryVersion: typeof REGISTRY_VERSION;
  /** ISO-8601 generation timestamp. Informational only — excluded from codegen input validation and any determinism/drift comparison. */
  generatedAt: string;
  workflows: readonly WorkflowRevisionManifest[];
  activeRevisions: Readonly<Record<string, string>>;
  activities: Record<string, RegistryActivityEntry>;
};

/**
 * Order two workflow revision manifests by `(name, revision)`. `workflows`
 * is sorted with this comparator so registry output is deterministic
 * regardless of registration order.
 *
 * The `revision` tiebreak can never actually fire through
 * {@link buildRegistrySnapshot}: the engine registers at most one
 * implementation per workflow name, so `name` alone is already unique
 * within one snapshot. It exists, and is exported, so a future
 * multi-revision registry source (or this function in isolation) has a
 * total order to rely on, and so the tiebreak itself has direct unit-test
 * coverage independent of engine registration uniqueness.
 */
export function compareWorkflowManifests(
  a: Pick<WorkflowRevisionManifest, 'name' | 'revision'>,
  b: Pick<WorkflowRevisionManifest, 'name' | 'revision'>,
): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  if (a.revision < b.revision) return -1;
  if (a.revision > b.revision) return 1;
  return 0;
}

/** Options accepted by {@link buildRegistrySnapshot}. */
export interface BuildRegistrySnapshotOptions {
  /**
   * Clock used for `generatedAt`. Defaults to `Date.now`; exists solely so
   * tests can pin `generatedAt` for exact-equality assertions. Production
   * call sites never pass this.
   */
  now?: () => number;
}

/**
 * Build a registry snapshot from an engine's locally-registered workflows
 * and activities. Remote-only activities (those advertised by a remote
 * worker but never registered with the local engine) are excluded by
 * construction — `engine.listActivityDefinitions()` is the only source.
 *
 * `engine.listWorkflowDefinitions()`/`listActivityDefinitions()` are read
 * synchronously in one eager pass before any `await`, so a workflow
 * registered concurrently mid-build simply does not appear in that call's
 * snapshot — the same eventual-consistency behavior v1's fully-synchronous
 * builder had. No torn or partial manifest is possible.
 *
 * Throws {@link RegistrySchemaConversionError} if any registered schema
 * fails JSON Schema conversion, {@link RegistryManifestLimitError} if a
 * registered workflow's contract exceeds a WFT-5 hostile-input limit, or
 * {@link RegistryWorkflowCountLimitError} if the engine has more than
 * {@link MAX_REGISTRY_WORKFLOW_COUNT} workflows registered in total —
 * checked here, at the producer, so `weft codegen --server`'s matching
 * consumer-side ceiling in `cli/codegen-validate.ts` can never reject a
 * `GET /v1/registry` response this function actually emits. A caller that
 * wants only one or a few workflows' manifests — never the full snapshot,
 * so neither limit above is the right contract — should use
 * `buildWorkflowManifestForType` (`registry-workflow-manifest.ts`) instead;
 * it is what this function itself calls per workflow.
 */
export async function buildRegistrySnapshot(
  engine: Engine,
  options?: BuildRegistrySnapshotOptions,
): Promise<RegistrySnapshot> {
  const workflowDefinitions = engine.listWorkflowDefinitions();
  if (workflowDefinitions.length > MAX_REGISTRY_WORKFLOW_COUNT) {
    throw new RegistryWorkflowCountLimitError(workflowDefinitions.length);
  }
  const activityDefinitions = engine.listActivityDefinitions();

  // Sort with explicit codepoint comparators rather than `localeCompare`
  // (project rule: deterministic comparisons in runtime logic).
  const sortedWorkflows = workflowDefinitions.toSorted((a, b) => compareCodepoint(a.type, b.type));
  const sortedActivities = activityDefinitions.toSorted((a, b) => compareCodepoint(a.name, b.name));

  // Each workflow's manifest hashing (`crypto.subtle`-backed) is independent
  // of every other's, so build them concurrently rather than one `await` at
  // a time — the same tradeoff `buildWorkerManifestFromRegistry` makes for
  // its own per-workflow work with `Promise.all`. Each mapped promise
  // catches its own workflow's failure so `RegistryManifestLimitError`
  // still names the one workflow whose contract exceeded a limit, not
  // whichever one happened to reject first.
  const manifests = await Promise.all(
    sortedWorkflows.map((definition) => buildOneWorkflowManifest(engine, definition)),
  );
  // Null-prototype: a workflow literally named `__proto__` is grammar-valid
  // (see name-grammar.ts) and must be stored as an own property rather than
  // mutate the prototype chain, which would silently drop it from JSON
  // output — same rationale as `workflows`/`activities` below.
  const activeRevisions = Object.create(null) as Record<string, string>;
  for (const manifest of manifests) {
    activeRevisions[manifest.name] = manifest.revision;
  }
  const sortedManifests = manifests.toSorted(compareWorkflowManifests);

  const activities = Object.create(null) as Record<string, RegistryActivityEntry>;
  for (const metadata of sortedActivities) {
    activities[metadata.name] = buildActivityEntry(metadata);
  }

  const now = options?.now ?? Date.now;

  return {
    registryVersion: REGISTRY_VERSION,
    generatedAt: new Date(now()).toISOString(),
    workflows: sortedManifests,
    activeRevisions,
    activities,
  };
}

/**
 * Convert one activity's catalog metadata to its `RegistryActivityEntry`
 * projection (schema pair plus queue/description/retry/timeout). Exported
 * so build tooling that resolves a single activity outside a full
 * {@link buildRegistrySnapshot} pass — see
 * `worker/manifest/registry-contract-builder.ts`'s workflow-scoped-first
 * activity resolution — can reuse the same conversion rather than
 * reimplementing it.
 */
export function buildActivityEntry(metadata: ActivityMetadata): RegistryActivityEntry {
  const entry: RegistryActivityEntry = { queue: metadata.queue };
  if (metadata.inputSchema !== undefined) {
    entry.inputSchema = convertSchema(
      'activity',
      metadata.name,
      'inputSchema',
      metadata.inputSchema,
    );
  }
  if (metadata.outputSchema !== undefined) {
    entry.outputSchema = convertSchema(
      'activity',
      metadata.name,
      'outputSchema',
      metadata.outputSchema,
    );
  }
  if (metadata.description !== undefined) {
    entry.description = metadata.description;
  }
  if (metadata.retry !== undefined) {
    entry.retry = metadata.retry;
  }
  if (metadata.timeout !== undefined) {
    entry.timeout = metadata.timeout;
  }
  return entry;
}
