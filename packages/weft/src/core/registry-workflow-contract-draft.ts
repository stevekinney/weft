/**
 * Projects a converted {@link RegistryWorkflowEntry} into the
 * `core/contract` {@link WorkflowContract} shape {@link buildRegistrySnapshot}
 * feeds to `buildWorkflowRevisionManifest`.
 *
 * Split out of `core/registry-snapshot.ts` specifically to stay under the
 * repository's implementation-file-size ceiling once WFT-6's workflow-scoped
 * activity folding (`buildRegistrySnapshot` reading
 * `Engine.listWorkflowActivityDefinitions`) was added there.
 *
 * @module core/registry-workflow-contract-draft
 */
import type { WorkflowActivityContract, WorkflowContract } from './contract/index.ts';
import type { RegistryMessageEntry, RegistryWorkflowEntry } from './registry-snapshot.ts';

/** Mutable draft of the {@link WorkflowContract} one registry workflow entry projects into. */
type WorkflowContractDraft = {
  name: string;
  workflowVersion: string;
  description?: string;
  tags?: ReadonlyArray<string>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  signals?: Readonly<Record<string, RegistryMessageEntry>>;
  updates?: Readonly<Record<string, RegistryMessageEntry>>;
  queries?: Readonly<Record<string, RegistryMessageEntry>>;
  activities?: Readonly<Record<string, WorkflowActivityContract>>;
  finalizer?: RegistryMessageEntry;
};

function applyDraftSchemas(draft: WorkflowContractDraft, entry: RegistryWorkflowEntry): void {
  if (entry.description !== undefined) draft.description = entry.description;
  if (entry.tags !== undefined && entry.tags.length > 0) draft.tags = entry.tags;
  if (entry.inputSchema !== undefined) draft.inputSchema = entry.inputSchema;
  if (entry.outputSchema !== undefined) draft.outputSchema = entry.outputSchema;
}

function applyDraftMessages(draft: WorkflowContractDraft, entry: RegistryWorkflowEntry): void {
  if (entry.signals !== undefined && Object.keys(entry.signals).length > 0) {
    draft.signals = entry.signals;
  }
  if (entry.updates !== undefined && Object.keys(entry.updates).length > 0) {
    draft.updates = entry.updates;
  }
  if (entry.queries !== undefined && Object.keys(entry.queries).length > 0) {
    draft.queries = entry.queries;
  }
}

/**
 * Project a converted {@link RegistryWorkflowEntry} (schemas already turned
 * into JSON Schema by `buildWorkflowEntry`) into the `core/contract`
 * {@link WorkflowContract} shape `buildWorkflowRevisionManifest` consumes.
 * Deliberately does not re-run schema conversion — `entry`'s schemas are
 * already `Record<string, unknown>` JSON Schema, structurally identical to
 * what `WorkflowContract` expects, so re-converting through
 * `buildWorkflowContract` (which expects raw `DefinitionSchema`) would
 * double-convert and risk a different error shape for the same failure.
 *
 * `workflowScopedActivities`, when non-empty, becomes the draft's
 * `activities` — the workflow's own `.activities({...})` registrations
 * (`Engine.listWorkflowActivityDefinitions`), never the flat,
 * workflow-independent `RegistrySnapshot.activities` catalog. Omitted
 * (rather than `{}`) when empty, matching this module's "absent fields
 * omitted" convention.
 */
export function toWorkflowContractDraft(
  workflowType: string,
  workflowVersion: string,
  entry: RegistryWorkflowEntry,
  workflowScopedActivities: Readonly<Record<string, WorkflowActivityContract>>,
): WorkflowContract {
  const draft: WorkflowContractDraft = { name: workflowType, workflowVersion };
  applyDraftSchemas(draft, entry);
  applyDraftMessages(draft, entry);
  if (entry.finalizer !== undefined) draft.finalizer = entry.finalizer;
  if (Object.keys(workflowScopedActivities).length > 0) {
    draft.activities = workflowScopedActivities;
  }
  return draft;
}
