import { describe, expect, test } from 'bun:test';

import { type Task, TaskState } from '@a2a-js/sdk';

import type { WorkflowState } from '../core/types/state.ts';
import {
  reconcileTask,
  RESULT_ARTIFACT_ID,
  SIGNAL_NAMES_METADATA_KEY,
  taskStateOf,
} from './workflow-task-projection.ts';

function workflowState(overrides: Partial<WorkflowState>): WorkflowState {
  return {
    id: 'workflow-1',
    type: 'agent-approval',
    status: 'running',
    input: null,
    versionTuple: { workflowVersion: '1.0.0' },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function task(state: TaskState): Task {
  return {
    id: 'workflow-1',
    contextId: 'context-1',
    status: { state, message: undefined, timestamp: undefined },
    artifacts: [],
    history: [],
    metadata: undefined,
  };
}

const TIMESTAMP = '2026-10-17T00:00:00.000Z';

describe('workflow status to task state', () => {
  test('pending reads as SUBMITTED', () => {
    expect(taskStateOf(workflowState({ status: 'pending' }), [])).toBe(
      TaskState.TASK_STATE_SUBMITTED,
    );
  });

  test('running without a signal wait reads as WORKING', () => {
    expect(taskStateOf(workflowState({ status: 'running' }), [])).toBe(
      TaskState.TASK_STATE_WORKING,
    );
  });

  test('any signal wait reads as INPUT_REQUIRED', () => {
    expect(taskStateOf(workflowState({ status: 'running' }), ['input'])).toBe(
      TaskState.TASK_STATE_INPUT_REQUIRED,
    );
  });

  test('suspended reads as WORKING', () => {
    expect(taskStateOf(workflowState({ status: 'suspended' }), [])).toBe(
      TaskState.TASK_STATE_WORKING,
    );
  });

  test('completed reads as COMPLETED', () => {
    expect(taskStateOf(workflowState({ status: 'completed' }), [])).toBe(
      TaskState.TASK_STATE_COMPLETED,
    );
  });

  test('failed reads as FAILED', () => {
    expect(taskStateOf(workflowState({ status: 'failed' }), [])).toBe(TaskState.TASK_STATE_FAILED);
  });

  test('timed-out reads as FAILED', () => {
    expect(taskStateOf(workflowState({ status: 'timed-out' }), [])).toBe(
      TaskState.TASK_STATE_FAILED,
    );
  });

  test('cancelled reads as CANCELED', () => {
    expect(taskStateOf(workflowState({ status: 'cancelled' }), [])).toBe(
      TaskState.TASK_STATE_CANCELED,
    );
  });
});

describe('reconcileTask', () => {
  test('publishes a completed workflow’s result as one artifact with one data part, before the status', () => {
    const change = reconcileTask(
      task(TaskState.TASK_STATE_WORKING),
      workflowState({ status: 'completed', result: { answer: 42 } }),
      [],
      TIMESTAMP,
    );

    expect(change?.task.artifacts).toEqual([
      expect.objectContaining({
        artifactId: RESULT_ARTIFACT_ID,
        parts: [expect.objectContaining({ content: { $case: 'data', value: { answer: 42 } } })],
      }),
    ]);
    expect(change?.events.map((event) => event.payload?.$case)).toEqual([
      'artifactUpdate',
      'statusUpdate',
    ]);
  });

  test('publishes the artifacts a mapper gives the result, each before the status, in order', () => {
    const artifact = (artifactId: string, text: string) => ({
      artifactId,
      name: '',
      description: '',
      parts: [
        {
          content: { $case: 'text' as const, value: text },
          metadata: undefined,
          filename: '',
          mediaType: '',
        },
      ],
      metadata: undefined,
      extensions: [],
    });
    const change = reconcileTask(
      task(TaskState.TASK_STATE_WORKING),
      workflowState({ status: 'completed', result: { summary: 'done', detail: 'all of it' } }),
      [],
      TIMESTAMP,
      (result) => {
        const { summary, detail } = result as { summary: string; detail: string };
        return [artifact('summary', summary), artifact('detail', detail)];
      },
    );

    expect(change?.task.artifacts.map((entry) => entry.artifactId)).toEqual(['summary', 'detail']);
    expect(
      change?.events.map((event) =>
        event.payload?.$case === 'artifactUpdate'
          ? event.payload.value.artifact?.artifactId
          : event.payload?.$case,
      ),
    ).toEqual(['summary', 'detail', 'statusUpdate']);
  });

  test('publishes an undefined result as a null data part', () => {
    const change = reconcileTask(
      task(TaskState.TASK_STATE_WORKING),
      workflowState({ status: 'completed' }),
      [],
      TIMESTAMP,
    );

    expect(change?.task.artifacts[0]?.parts[0]?.content).toEqual({ $case: 'data', value: null });
  });

  test('changes nothing for a task already in the workflow’s state', () => {
    expect(
      reconcileTask(task(TaskState.TASK_STATE_WORKING), workflowState({}), [], TIMESTAMP),
    ).toBeUndefined();
  });

  test('never moves a terminal task', () => {
    expect(
      reconcileTask(task(TaskState.TASK_STATE_CANCELED), workflowState({}), [], TIMESTAMP),
    ).toBeUndefined();
  });

  test('announces a new set of waits on a task already waiting for input', () => {
    const waiting = reconcileTask(
      task(TaskState.TASK_STATE_WORKING),
      workflowState({}),
      ['a'],
      TIMESTAMP,
    );
    if (waiting === undefined) throw new Error('expected a change');

    expect(reconcileTask(waiting.task, workflowState({}), ['a'], TIMESTAMP)).toBeUndefined();
    const changed = reconcileTask(waiting.task, workflowState({}), ['b'], TIMESTAMP);
    expect(changed?.task.status?.message?.metadata).toEqual({ [SIGNAL_NAMES_METADATA_KEY]: ['b'] });
    expect(changed?.task.history).toHaveLength(2);
  });

  test('explains a failure and a timeout in the status message', () => {
    const failed = reconcileTask(
      task(TaskState.TASK_STATE_WORKING),
      workflowState({ status: 'failed', error: 'boom' }),
      [],
      TIMESTAMP,
    );
    const failedWithoutReason = reconcileTask(
      task(TaskState.TASK_STATE_WORKING),
      workflowState({ status: 'failed' }),
      [],
      TIMESTAMP,
    );
    const timedOut = reconcileTask(
      task(TaskState.TASK_STATE_WORKING),
      workflowState({ status: 'timed-out' }),
      [],
      TIMESTAMP,
    );

    const textOf = (change: typeof failed) => change?.task.status?.message?.parts[0]?.content;
    expect(textOf(failed)).toEqual({ $case: 'text', value: 'boom' });
    expect(textOf(failedWithoutReason)).toEqual({ $case: 'text', value: 'The workflow failed.' });
    expect(textOf(timedOut)).toEqual({ $case: 'text', value: 'The workflow timed out.' });
  });
});
