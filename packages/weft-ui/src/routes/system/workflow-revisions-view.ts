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
 * every record is runtime-guarded rather than cast. `workflowRevisionRows`
 * treats even one malformed entry as a malformed RESPONSE (returns
 * `undefined`) rather than silently dropping just that entry — see that
 * function's own doc for why a partial, silently-filtered list is unsafe
 * here specifically.
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
 * Sorted (codepoint order, by revision), render-ready rows for `records` —
 * or `undefined` when even ONE entry fails {@link isWorkflowRevisionRecordLike}.
 *
 * An earlier version of this function silently filtered out malformed
 * entries and rendered the rest as a (misleadingly complete-looking)
 * revisions list. That is unsafe specifically when the malformed record IS
 * the one the active pointer names: the surviving rows would all render as
 * "Installed" with no "Active" badge, AND the panel's "no active
 * revision — never activated" note would stay suppressed (the pointer
 * itself is still non-null) — silently telling an operator the workflow
 * has installed-but-unactivated revisions when it actually has an active
 * one this console just couldn't parse. Treating ANY malformed entry as a
 * malformed RESPONSE (same "reject, don't guess" contract
 * `weft.workflows.active.get`'s own malformed-pointer handling in
 * `workflow-revisions-panel.svelte` already uses) removes that failure
 * mode entirely — the panel renders its explicit malformed-response state
 * instead of a partial, mislabeled list.
 */
export function workflowRevisionRows(
  records: readonly unknown[],
  active: WorkflowCatalogActivePointerLike | null,
): readonly WorkflowRevisionRow[] | undefined {
  const validated: WorkflowRevisionRecordSource[] = [];
  for (const record of records) {
    if (!isWorkflowRevisionRecordLike(record)) return undefined;
    validated.push(record);
  }
  return validated
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
