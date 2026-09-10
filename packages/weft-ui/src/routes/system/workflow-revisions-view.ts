/**
 * Pure view-model mapping for the Registry detail view's Revisions panel
 * (WFT-115): turns `weft.workflows.revisions.list`'s output (an array of
 * `WorkflowRevisionRecord`, `@lostgradient/weft`) plus
 * `weft.workflows.active.get`'s output (a `WorkflowCatalogActivePointer`,
 * or `null` for a workflow that has never been activated) into sorted,
 * render-ready rows — mirrors `registry-view.ts`'s framework-free,
 * unit-testable-without-a-DOM convention.
 *
 * Both wire operations type their output `unknown` (the generated client's
 * `weft.workflows.revisions.list`/`weft.workflows.active.get` entries —
 * their zod schemas use `z.unknown()`, same as the registry snapshot), so
 * every record is runtime-guarded rather than cast — a malformed or
 * unsupported record is dropped, never fabricated into a row.
 */

/** Mirrors `WorkflowRevisionManifest` (`@lostgradient/weft`) structurally — only the identity fields this panel renders. */
interface WorkflowRevisionManifestLike {
  readonly manifestVersion: number;
  readonly name: string;
  readonly workflowVersion: string;
  readonly revision: string;
  readonly contractHash: string;
  readonly contract: unknown;
}

/** Mirrors `WorkflowRevisionRecord` (`@lostgradient/weft`) structurally. */
export interface WorkflowRevisionRecordSource {
  readonly manifest: WorkflowRevisionManifestLike;
  readonly installedAt: number;
}

/** Mirrors `WorkflowCatalogActivePointer` (`@lostgradient/weft`) structurally. */
export interface WorkflowCatalogActivePointerLike {
  readonly revision: string;
  readonly generation: number;
  readonly activatedAt: number;
}

function isWorkflowRevisionManifestLike(value: unknown): value is WorkflowRevisionManifestLike {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['manifestVersion'] === 'number' &&
    typeof record['name'] === 'string' &&
    typeof record['workflowVersion'] === 'string' &&
    typeof record['revision'] === 'string' &&
    typeof record['contractHash'] === 'string' &&
    typeof record['contract'] === 'object' &&
    record['contract'] !== null
  );
}

/** Runtime type guard for one `weft.workflows.revisions.list` array entry. */
export function isWorkflowRevisionRecordLike(
  value: unknown,
): value is WorkflowRevisionRecordSource {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isWorkflowRevisionManifestLike(record['manifest']) && typeof record['installedAt'] === 'number'
  );
}

/** Runtime type guard for `weft.workflows.active.get`'s output. */
export function isWorkflowCatalogActivePointerLike(
  value: unknown,
): value is WorkflowCatalogActivePointerLike {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['revision'] === 'string' &&
    typeof record['generation'] === 'number' &&
    typeof record['activatedAt'] === 'number'
  );
}

/** One render-ready row for the Revisions panel — an installed revision, flagged active or not against the resolved active pointer. */
export interface WorkflowRevisionRow {
  readonly revision: string;
  readonly workflowVersion: string;
  readonly contractHash: string;
  readonly manifestVersion: number;
  readonly installedAt: number;
  readonly isActive: boolean;
}

function compareCodepoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Sorted (codepoint order, by revision), render-ready rows for every
 * structurally valid entry in `records` — a record that fails
 * {@link isWorkflowRevisionRecordLike} is dropped rather than rendered as a
 * guessed-at row. `active` is `null` for a workflow name that has never
 * been activated (a legitimate state — `weft.workflows.active.get` faults
 * `NotFound` there, which the panel renders as "no active revision" rather
 * than propagating the fault into this pure module).
 */
export function workflowRevisionRows(
  records: readonly unknown[],
  active: WorkflowCatalogActivePointerLike | null,
): readonly WorkflowRevisionRow[] {
  return records
    .filter(isWorkflowRevisionRecordLike)
    .map((record): WorkflowRevisionRow => ({
      revision: record.manifest.revision,
      workflowVersion: record.manifest.workflowVersion,
      contractHash: record.manifest.contractHash,
      manifestVersion: record.manifest.manifestVersion,
      installedAt: record.installedAt,
      isActive: active !== null && active.revision === record.manifest.revision,
    }))
    .toSorted((a, b) => compareCodepoint(a.revision, b.revision));
}
