import type { WorkflowHandle } from './handles.ts';

/**
 * A resume from storage that has not yet adopted its workflow's checkpoint. A later resume of the
 * same execution generation joins it instead of driving the run a second time, and hands over the
 * claim bookkeeping it would otherwise have done itself.
 */
export type ResumeAwaitingAdoption = {
  /** The generation being resumed; a resume of any other generation never joins this one. */
  readonly workflowExecutionToken: string | undefined;
  /** Settles with the joined resume's handle or rejection. */
  readonly handle: Promise<WorkflowHandle>;
  /** What this resume does that a joiner may require; a joiner requiring more resumes on its own. */
  readonly performs: { readonly eagerRevisionCheck: boolean; readonly resumedEvent: boolean };
  /** The epoch of a claim this resume freshly acquired, once it has. */
  claimEpoch: number | null;
  /** Joiners' trackers, filled with {@link claimEpoch} once it is known. */
  readonly freshClaimTrackers: Array<{ epoch: number | null }>;
  /** Set when a joiner asked to release a fresh claim itself after a rejection. */
  deferClaimReleaseOnRejection: boolean;
};
