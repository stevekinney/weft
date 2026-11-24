/**
 * How a Weft workflow's persisted state reads as an A2A task.
 *
 * | Workflow status | Task state |
 * | --- | --- |
 * | `pending` | `SUBMITTED` |
 * | `running`, no signal wait | `WORKING` |
 * | `running`, any signal wait | `INPUT_REQUIRED` |
 * | `suspended` | `WORKING` |
 * | `completed` | `COMPLETED`, with the result's artifacts (by default one, holding one data part) |
 * | `failed`, `timed-out` | `FAILED` |
 * | `cancelled` | `CANCELED` |
 *
 * Each change is a `TaskStatusUpdateEvent` (preceded, on completion, by one
 * `TaskArtifactUpdateEvent` per artifact), and an agent message on a status (the signal names an
 * `INPUT_REQUIRED` task waits for, or a failure's reason) joins the task's history.
 * Nothing else the workflow does reaches the task.
 *
 * @module a2a/workflow-task-projection
 */

import {
  type Artifact,
  type Message,
  type Part,
  Role,
  type StreamResponse,
  type Task,
  TaskState,
  type TaskStatus,
} from '@a2a-js/sdk';

import type { WorkflowStatus } from '../core/types/identity.ts';
import type { WorkflowState } from '../core/types/state.ts';
import type { TaskMutation } from './task-event-log.ts';

/** The metadata key on an `INPUT_REQUIRED` status message listing the awaited signals. */
export const SIGNAL_NAMES_METADATA_KEY = 'signalNames';

/** The identifier of the artifact a completed workflow's result is published as. */
export const RESULT_ARTIFACT_ID = 'result';

const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

/** Whether a task in `state` can change no further. */
export function isTerminalTaskState(state: TaskState | undefined): boolean {
  return state !== undefined && TERMINAL_TASK_STATES.has(state);
}

/** Whether a task in `state` waits on its caller (or has ended): a blocking send returns. */
export function isSettledTaskState(state: TaskState | undefined): boolean {
  return (
    isTerminalTaskState(state) ||
    state === TaskState.TASK_STATE_INPUT_REQUIRED ||
    state === TaskState.TASK_STATE_AUTH_REQUIRED
  );
}

const SETTLED_STATUS_STATES: Readonly<Record<Exclude<WorkflowStatus, 'running'>, TaskState>> = {
  pending: TaskState.TASK_STATE_SUBMITTED,
  suspended: TaskState.TASK_STATE_WORKING,
  completed: TaskState.TASK_STATE_COMPLETED,
  failed: TaskState.TASK_STATE_FAILED,
  'timed-out': TaskState.TASK_STATE_FAILED,
  cancelled: TaskState.TASK_STATE_CANCELED,
};

/** The task state a workflow in `state` reads as, given the signal waits still live. */
/**
 * The part of a workflow's state its task is projected from. A purged workflow has no
 * state left, and its terminal event supplies these fields instead.
 */
export type WorkflowOutcome = Pick<WorkflowState, 'status' | 'result' | 'error'>;

export function taskStateOf(state: WorkflowOutcome, liveWaits: readonly string[]): TaskState {
  if (state.status !== 'running') return SETTLED_STATUS_STATES[state.status];
  return liveWaits.length > 0 ? TaskState.TASK_STATE_INPUT_REQUIRED : TaskState.TASK_STATE_WORKING;
}

function textPart(text: string): Part {
  return {
    content: { $case: 'text', value: text },
    metadata: undefined,
    filename: '',
    mediaType: '',
  };
}

/** An agent message on `task`. */
export function agentMessage(
  task: Pick<Task, 'id' | 'contextId'>,
  text: string,
  metadata?: Record<string, unknown>,
): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId: task.contextId,
    taskId: task.id,
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    metadata,
    extensions: [],
    referenceTaskIds: [],
  };
}

function quoted(names: readonly string[]): string {
  return names.map((name) => `'${name}'`).join(', ');
}

function waitingMessage(task: Task, liveWaits: readonly string[]): Message {
  const text =
    liveWaits.length === 1
      ? `Waiting for the signal ${quoted(liveWaits)}.`
      : `Waiting for one of the signals ${quoted(liveWaits)}; name it in metadata.signalName.`;
  return agentMessage(task, text, { [SIGNAL_NAMES_METADATA_KEY]: [...liveWaits] });
}

function failureMessage(task: Task, state: WorkflowOutcome): Message {
  if (state.status === 'timed-out') return agentMessage(task, 'The workflow timed out.');
  return agentMessage(task, state.error ?? 'The workflow failed.');
}

/** The signal names a task's current `INPUT_REQUIRED` status message lists. */
function announcedWaits(task: Task): readonly string[] | undefined {
  const names: unknown = task.status?.message?.metadata?.[SIGNAL_NAMES_METADATA_KEY];
  return Array.isArray(names) ? names : undefined;
}

function sameNames(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left !== undefined && left.length === right.length && left.every((n, i) => n === right[i]);
}

/** Maps a completed workflow's result to the artifacts its task is published with. */
export type WorkflowResultArtifacts = (result: unknown) => readonly Artifact[];

/** The single artifact a completed workflow's result is published as by default. */
export function resultArtifact(result: unknown): Artifact {
  return {
    artifactId: RESULT_ARTIFACT_ID,
    name: RESULT_ARTIFACT_ID,
    description: '',
    parts: [
      {
        content: { $case: 'data', value: result ?? null },
        metadata: undefined,
        filename: '',
        mediaType: 'application/json',
      },
    ],
    metadata: undefined,
    extensions: [],
  };
}

/** The default {@link WorkflowResultArtifacts}: the result as one data part. */
export const defaultResultArtifacts: WorkflowResultArtifacts = (result) => [resultArtifact(result)];

/** An artifact-update event publishing `artifact` whole on `task`. */
function artifactUpdateEvent(task: Task, artifact: Artifact): StreamResponse {
  return {
    payload: {
      $case: 'artifactUpdate',
      value: {
        taskId: task.id,
        contextId: task.contextId,
        artifact,
        append: false,
        lastChunk: true,
        metadata: undefined,
      },
    },
  };
}

/** A status-update event for `task` carrying `status`. */
export function statusUpdateEvent(task: Task, status: TaskStatus): StreamResponse {
  return {
    payload: {
      $case: 'statusUpdate',
      value: { taskId: task.id, contextId: task.contextId, status, metadata: undefined },
    },
  };
}

/** Move `task` to `status`, adding the status's message to its history. */
export function withStatus(task: Task, status: TaskStatus): Task {
  return {
    ...task,
    status,
    history: status.message === undefined ? task.history : [...task.history, status.message],
  };
}

/**
 * The change that brings `task` in line with the workflow's `state`, or `undefined`
 * when it already matches. A terminal task never changes. A completed workflow's
 * result becomes the artifacts `artifactsOf` maps it to, each published as its own
 * artifact update before the status.
 */
export function reconcileTask(
  task: Task,
  state: WorkflowOutcome,
  liveWaits: readonly string[],
  timestamp: string,
  artifactsOf: WorkflowResultArtifacts = defaultResultArtifacts,
): TaskMutation | undefined {
  const current = task.status?.state;
  if (isTerminalTaskState(current)) return undefined;
  const target = taskStateOf(state, liveWaits);
  if (target === current) {
    const waitsChanged =
      target === TaskState.TASK_STATE_INPUT_REQUIRED && !sameNames(announcedWaits(task), liveWaits);
    if (!waitsChanged) return undefined;
  }

  const events: StreamResponse[] = [];
  let next = task;
  if (target === TaskState.TASK_STATE_COMPLETED) {
    const artifacts = [...artifactsOf(state.result)];
    next = { ...next, artifacts };
    events.push(...artifacts.map((artifact) => artifactUpdateEvent(task, artifact)));
  }
  const message =
    target === TaskState.TASK_STATE_INPUT_REQUIRED
      ? waitingMessage(task, liveWaits)
      : target === TaskState.TASK_STATE_FAILED
        ? failureMessage(task, state)
        : undefined;
  const status: TaskStatus = { state: target, message, timestamp };
  next = withStatus(next, status);
  events.push(statusUpdateEvent(next, status));
  return { task: next, events };
}
