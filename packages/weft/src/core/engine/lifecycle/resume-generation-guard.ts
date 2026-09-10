/**
 * `resumeWorkflowFromStorage()`'s generation-identity re-check (WFT-19
 * review round 7, chatgpt-codex-connector + stevekinney) — split out of
 * `resume.ts`, which has no headroom under the repository's 500-line
 * implementation-file ceiling for this doc-heavy addition.
 *
 * @module core/engine/lifecycle/resume-generation-guard
 */

import type { WorkflowState } from '../../types.ts';

/**
 * The generation a resume's `registration`/`resumeCheckpoint`/`resolvedRevision`
 * were all resolved against — captured from the SAME `WorkflowState` decoded
 * at the very top of `resumeWorkflowFromStorage()`, before
 * `acquireStandaloneClaimBeforeResume`, the checkpoint load, and registration
 * resolution all ran.
 *
 * `performSerializedResume()` re-reads workflow state fresh inside its
 * serialized section but (before this guard existed) only re-checked
 * `status` — never identity. An `onTerminalConflict: 'start-new'`
 * replacement landing on this SAME `workflowId` between the top-of-function
 * read and the serialized section's fresh read (e.g. a concurrent
 * cancel/timeout terminalizes this run, then a fresh `start()` call replaces
 * it) purges the old record and writes a brand-new one — new
 * `type`/`revision` possibly, and ALWAYS a fresh `workflowExecutionToken`
 * (`crypto.randomUUID()`, minted by every `start()` — see
 * `start-state.ts`'s `buildInitialIdentitySlice`). Without
 * {@link assertSameGeneration}, the stale `registration`/
 * `resumeCheckpoint` a resume closure already built would replay against the
 * replacement's fresh state: `commitSerializedResumeState` populates
 * `internals.checkpoints` from the OLD checkpoint, and
 * `relaunchInlineWorkflowAfterResume` drives the OLD handler — silently
 * corrupting the replacement's run.
 *
 * A DIFFERENT engine's replacement is additionally caught earlier, by
 * `acquireStandaloneClaimBeforeResume`'s durable `wakeOwnershipCheck`
 * (workflow-lease mode only) — but that check compares only holder
 * identity/epoch, never workflow identity, so a SAME-engine replacement
 * (whose fold-acquire updates this engine's own already-held claim in
 * place, leaving the epoch check trivially satisfied) is not caught there.
 * This guard closes that gap for every ownership mode, not just
 * workflow-lease.
 */
export type ResumeGeneration = {
  type: string;
  revision: string | undefined;
  workflowExecutionToken: string | undefined;
};

/** Captures {@link ResumeGeneration} off the `WorkflowState` a resume decoded at its top, before any `await`. */
export function deriveResumeGeneration(state: WorkflowState): ResumeGeneration {
  return {
    type: state.type,
    revision: state.revision,
    workflowExecutionToken: state.workflowExecutionToken,
  };
}

/**
 * Throws when `latestState` — freshly re-read inside `performSerializedResume()`'s
 * serialized section — no longer belongs to the same generation `expected`
 * names. See {@link ResumeGeneration}'s doc for the exact race this
 * closes. All three fields are compared — `workflowExecutionToken` alone
 * would miss a legacy record that carries `undefined` on both sides of the
 * race.
 */
export function assertSameGeneration(
  workflowId: string,
  latestState: WorkflowState,
  expected: ResumeGeneration,
): void {
  if (
    latestState.workflowExecutionToken !== expected.workflowExecutionToken ||
    latestState.type !== expected.type ||
    latestState.revision !== expected.revision
  ) {
    throw new Error(
      `Cannot resume workflow "${workflowId}": its persisted state changed generation ` +
        `(a replacement run landed at this same id) between resume's registration lookup ` +
        `and its serialized commit — retry against the new generation instead of replaying ` +
        `stale state.`,
    );
  }
}
