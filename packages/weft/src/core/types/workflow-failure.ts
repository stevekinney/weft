/**
 * The step a failed run stopped at, as recorded on `WorkflowState.failedStep` and
 * `WorkflowSummary.failedStep`.
 */
export interface WorkflowFailedStep {
  /** The durable step index, the value of the timeline entry's `stepIndex`. */
  index: number;
  /** The step's operation label (an activity's name, for one), cut to 200 characters. */
  label: string;
}

/**
 * The activity a running workflow is retrying, as recorded on `WorkflowSummary.retrying`.
 */
export interface WorkflowRetrying {
  /** The activity's name. */
  activity: string;
  /** The attempt the activity is on or about to start; always 2 or later. */
  attempt: number;
}
