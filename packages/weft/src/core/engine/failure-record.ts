/**
 * The two facts a failed run stores beside its message (COR-2529): the error's code and the step
 * it failed at. Both are written in the failure write itself, so a list reads them without
 * replaying the timeline, and both are optional so a record written before them reads the same.
 *
 * @module core/engine/failure-record
 */
import type { WorkflowFailedStep, WorkflowState, WorkflowTimelineEntry } from '../types.ts';
import { isWeftErrorCode } from '../weft-error.ts';

/** Longest `failedStep.label`, in characters. */
export const FAILED_STEP_LABEL_MAX_LENGTH = 200;

/** A label as text; the type says string, but it is built from caller-supplied operation fields. */
function labelText(label: unknown): string {
  return String(label);
}

/** A label cut to {@link FAILED_STEP_LABEL_MAX_LENGTH}, the way a failed run stores it. */
export function truncateLabel(label: string): string {
  if (label.length <= FAILED_STEP_LABEL_MAX_LENGTH) return label;
  const cut = label.slice(0, FAILED_STEP_LABEL_MAX_LENGTH);
  // Never end on half of a surrogate pair.
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * The failed step for the timeline entry the failure write finalizes: its durable step index
 * (`step`, the checkpoint count, for an entry persisted before `stepIndex` existed) and its label
 * cut to {@link FAILED_STEP_LABEL_MAX_LENGTH}. `undefined` when the run started no step.
 */
export function failedStepOf(
  entry: WorkflowTimelineEntry | undefined,
): WorkflowFailedStep | undefined {
  if (entry === undefined) return undefined;
  // The label is derived from caller-built operation fields, so it is read as text here: a label
  // that threw would abort the failure write, and the run would end abandoned instead of failed.
  return {
    index: entry.stepIndex ?? entry.step,
    label: truncateLabel(labelText(entry.operationLabel)),
  };
}

function isFailedStep(value: unknown): value is WorkflowFailedStep {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { index, label } = value as Record<string, unknown>;
  return (
    typeof index === 'number' &&
    Number.isSafeInteger(index) &&
    index >= 0 &&
    typeof label === 'string' &&
    label.length <= FAILED_STEP_LABEL_MAX_LENGTH
  );
}

/**
 * Drop a decoded `errorCode` or `failedStep` that is not what the engine writes. The engine never
 * writes one, so such a value is corruption, and reporting no code or step is safer than a
 * malformed one.
 */
export function sanitizeDecodedFailureRecord(state: WorkflowState): void {
  if (state.errorCode !== undefined && !isWeftErrorCode(state.errorCode)) delete state.errorCode;
  if (state.failedStep !== undefined && !isFailedStep(state.failedStep)) delete state.failedStep;
}
