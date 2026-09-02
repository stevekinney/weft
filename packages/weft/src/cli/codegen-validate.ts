/**
 * Envelope and per-manifest validation for a `weft codegen` registry
 * snapshot source (fetched from a live server or vendored as `--from`
 * JSON).
 *
 * Split out of `codegen.ts` specifically to stay under the repository's
 * implementation-file-size ceiling once WFT-6's manifest validation
 * (reusing `core/contract`'s hostile-input `parseWorkflowRevisionManifest`)
 * was added — `codegen.ts` was already 460 of 500 lines before this module
 * existed.
 *
 * @module cli/codegen-validate
 */

import { z } from 'zod';

import {
  parseWorkflowRevisionManifest,
  type WorkflowRevisionManifest,
} from '../core/contract/index.ts';
import {
  REGISTRY_VERSION,
  type RegistryActivityEntry,
  type RegistryWorkflowEntry,
} from '../core/registry-snapshot.ts';
import { isRecord } from '../worker/manifest/is-record.ts';

export type ValidateSnapshotResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** The active workflow projection `weft codegen` emits from, plus the activity count for the CLI's summary line. */
export interface ActiveRegistryProjection {
  workflows: Record<string, RegistryWorkflowEntry>;
  activities: Record<string, RegistryActivityEntry>;
}

// JSON Schema permits a boolean at any schema position (`true` →
// accept anything, `false` → accept nothing). `RegistryActivityEntry`
// schemas are validated with this Zod-level tolerance (unchanged from v1);
// workflow schemas are not — see the module doc on `resolveActiveWorkflowEntries`.
const jsonSchema = z.union([z.boolean(), z.record(z.string(), z.unknown())]);

const activityEntrySchema = z
  .object({
    inputSchema: jsonSchema.optional(),
    outputSchema: jsonSchema.optional(),
    queue: z.string(),
    description: z.string().optional(),
  })
  .passthrough();

// We validate the envelope (`registryVersion`/`generatedAt` and the
// presence of `workflows`/`activeRevisions` in their documented shapes) but
// treat `workflows`' elements and `activeRevisions` as opaque values rather
// than running them through `z.record(...)`. `z.record()` rebuilds the
// input by iterating own keys and assigning to a fresh `{}`, which silently
// drops a `__proto__`-named entry even though a real registry snapshot
// preserves it (see `get-registry.ts`'s identical rationale for its own
// output schema). `workflows`' elements are individually re-validated by
// `parseWorkflowRevisionManifest` below, which is itself null-prototype-safe.
const objectValue = z
  .unknown()
  .refine((value) => typeof value === 'object' && value !== null && !Array.isArray(value), {
    message: 'expected an object',
  });

const registryEnvelopeSchema = z
  .object({
    registryVersion: z.literal(REGISTRY_VERSION),
    generatedAt: z.string(),
    workflows: z.array(objectValue),
    activeRevisions: objectValue,
    activities: z.record(z.string(), activityEntrySchema),
  })
  .passthrough();

/**
 * JSON Schema permits a boolean at any schema position. `RegistryActivityEntry`
 * keeps that tolerance (activities are unversioned catalog metadata, not a
 * `WorkflowRevisionManifest`); normalize it to an object form here so the
 * projection stays compatible with `RegistryActivityEntry`'s
 * `Record<string, unknown>` schema fields. `true` → `{}` (emitter never
 * reads activity schemas, so the coarsening is immaterial); `false` is
 * mapped to `{}` too rather than encoding `never` structurally, matching
 * the same tradeoff `codegen.ts` documented before this split.
 */
function normalizeRootSchema(
  schema: boolean | Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (schema === undefined) return undefined;
  if (typeof schema === 'boolean') return {};
  return schema;
}

function projectActivities(
  raw: Record<string, z.infer<typeof activityEntrySchema>>,
): Record<string, RegistryActivityEntry> {
  const projected: Record<string, RegistryActivityEntry> = Object.create(null) as Record<
    string,
    RegistryActivityEntry
  >;
  for (const [name, entry] of Object.entries(raw)) {
    const projection: RegistryActivityEntry = { queue: entry.queue };
    const input = normalizeRootSchema(entry.inputSchema);
    const output = normalizeRootSchema(entry.outputSchema);
    if (input !== undefined) projection.inputSchema = input;
    if (output !== undefined) projection.outputSchema = output;
    if (entry.description !== undefined) projection.description = entry.description;
    projected[name] = projection;
  }
  return projected;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? '<root>' : issue.path.join('.');
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Read one `activeRevisions[name]` entry without `z.record()`'s
 * fresh-object rebuild (see `registryEnvelopeSchema`'s module doc): iterate
 * `Object.keys` directly (which, for a value produced by `JSON.parse`,
 * enumerates a `__proto__`-named key as a normal own property) and require
 * every value to be a string.
 */
function readActiveRevisions(
  value: unknown,
): ValidateSnapshotResult<Readonly<Record<string, string>>> {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: 'codegen: invalid registry snapshot: activeRevisions must be an object',
    };
  }
  for (const [name, revision] of Object.entries(value)) {
    if (typeof revision !== 'string') {
      return {
        ok: false,
        error: `codegen: invalid registry snapshot: activeRevisions["${name}"] must be a string`,
      };
    }
  }
  return { ok: true, value: value as Readonly<Record<string, string>> };
}

/**
 * Parse every raw `workflows` array element as a {@link WorkflowRevisionManifest}
 * (hostile-input validated: bounded identifiers/entry counts/schema depth,
 * `contractHash` recomputed and compared — see `core/contract/manifest-parse.ts`),
 * then project the manifest named by each `activeRevisions` entry into the
 * `{ inputSchema?, outputSchema? }` shape {@link emitRegistryDeclaration}
 * consumes.
 *
 * A manifest in `workflows` with no matching `activeRevisions` entry
 * (a future installed-but-inactive revision) is silently excluded, not an
 * error — only the currently active manifest per name feeds codegen.
 *
 * Workflow schemas lose the boolean-root tolerance `RegistryActivityEntry`
 * keeps: `parseWorkflowRevisionManifest`'s schema-fragment parser requires a
 * JSON object at every `inputSchema`/`outputSchema` position, matching what
 * a real registry snapshot always produces (`definitionSchemaToJsonSchema`
 * never emits a boolean root). A hand-vendored `--from` file using a
 * boolean root schema is rejected with a clear diagnostic rather than
 * silently coarsened, a deliberate narrowing from v1 — see CHANGELOG.md.
 */
/** Parse every raw `workflows` array element, short-circuiting with an indexed diagnostic on the first hostile-input rejection. */
async function parseAllManifests(
  workflowsRaw: readonly unknown[],
): Promise<ValidateSnapshotResult<WorkflowRevisionManifest[]>> {
  const manifests: WorkflowRevisionManifest[] = [];
  for (const [index, raw] of workflowsRaw.entries()) {
    const parsed = await parseWorkflowRevisionManifest(raw);
    if (!parsed.ok) {
      const location = parsed.path === undefined ? '' : ` at ${parsed.path}`;
      return {
        ok: false,
        error: `codegen: invalid registry snapshot: workflows[${index}] (${parsed.reason}${location}): ${parsed.message}`,
      };
    }
    manifests.push(parsed.manifest);
  }
  return { ok: true, value: manifests };
}

/** Project one manifest's contract into the `{ inputSchema?, outputSchema?, description?, tags? }` shape {@link emitRegistryDeclaration} consumes. */
function toRegistryWorkflowEntry(manifest: WorkflowRevisionManifest): RegistryWorkflowEntry {
  const entry: RegistryWorkflowEntry = {};
  if (manifest.contract.inputSchema !== undefined)
    entry.inputSchema = manifest.contract.inputSchema;
  if (manifest.contract.outputSchema !== undefined)
    entry.outputSchema = manifest.contract.outputSchema;
  if (manifest.contract.description !== undefined)
    entry.description = manifest.contract.description;
  if (manifest.contract.tags !== undefined && manifest.contract.tags.length > 0) {
    entry.tags = manifest.contract.tags;
  }
  return entry;
}

async function resolveActiveWorkflowEntries(
  workflowsRaw: readonly unknown[],
  activeRevisions: Readonly<Record<string, string>>,
): Promise<ValidateSnapshotResult<Record<string, RegistryWorkflowEntry>>> {
  const parsed = await parseAllManifests(workflowsRaw);
  if (!parsed.ok) return parsed;
  const manifests = parsed.value;

  const projected: Record<string, RegistryWorkflowEntry> = Object.create(null) as Record<
    string,
    RegistryWorkflowEntry
  >;
  for (const [name, revision] of Object.entries(activeRevisions)) {
    const manifest = manifests.find(
      (candidate) => candidate.name === name && candidate.revision === revision,
    );
    if (manifest === undefined) {
      return {
        ok: false,
        error: `codegen: invalid registry snapshot: activeRevisions[${JSON.stringify(name)}] = ${JSON.stringify(revision)} has no matching entry in workflows`,
      };
    }
    projected[name] = toRegistryWorkflowEntry(manifest);
  }
  return { ok: true, value: projected };
}

/**
 * Validate an untrusted registry snapshot end-to-end: the version/envelope
 * shape, every `workflows` manifest, and the `activeRevisions` pointer map,
 * projecting the result down to what `weft codegen` actually emits from.
 *
 * Surfaces a clear version-mismatch diagnostic before delegating to the
 * full envelope schema, since the version check is the most likely failure
 * when consumers vendor a snapshot from an older or newer server.
 */
export async function validateRegistrySnapshot(
  value: unknown,
): Promise<ValidateSnapshotResult<ActiveRegistryProjection>> {
  if (value !== null && typeof value === 'object' && 'registryVersion' in value) {
    const { registryVersion: actual } = value as { registryVersion?: unknown };
    if (actual !== REGISTRY_VERSION) {
      return {
        ok: false,
        error: `codegen: registryVersion ${String(actual)} is not supported (expected ${REGISTRY_VERSION}); upgrade or regenerate the snapshot`,
      };
    }
  }

  const parsed = registryEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: `codegen: invalid registry snapshot: ${formatZodError(parsed.error)}`,
    };
  }

  const activeRevisions = readActiveRevisions(parsed.data.activeRevisions);
  if (!activeRevisions.ok) return activeRevisions;

  const workflows = await resolveActiveWorkflowEntries(
    parsed.data.workflows,
    activeRevisions.value,
  );
  if (!workflows.ok) return workflows;

  return {
    ok: true,
    value: {
      workflows: workflows.value,
      activities: projectActivities(parsed.data.activities),
    },
  };
}
