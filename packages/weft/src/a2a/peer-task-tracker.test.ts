import { describe, expect, test } from 'bun:test';

import { Role, TaskState, type Artifact } from '@a2a-js/sdk';

import type { A2APeerUpdate } from './peer-client-types.ts';
import { PeerTaskTracker, type PeerStreamEvent } from './peer-task-tracker.ts';

const peer = { agentName: 'Peer', agentVersion: '1', cardUrl: 'https://peer.example/card' };

function status(state: TaskState, text = '') {
  return {
    state,
    timestamp: undefined,
    message:
      text === ''
        ? undefined
        : {
            messageId: text,
            contextId: 'c',
            taskId: 't',
            role: Role.ROLE_AGENT,
            parts: [
              {
                content: { $case: 'text' as const, value: text },
                metadata: undefined,
                filename: '',
                mediaType: 'text/plain',
              },
            ],
            metadata: undefined,
            extensions: [],
            referenceTaskIds: [],
          },
  };
}

const taskEvent = (state: TaskState, text = ''): PeerStreamEvent => ({
  payload: {
    $case: 'task',
    value: {
      id: 't',
      contextId: 'c',
      status: status(state, text),
      artifacts: [],
      history: [],
      metadata: undefined,
    },
  },
});

const statusEvent = (state: TaskState, text = ''): PeerStreamEvent => ({
  payload: {
    $case: 'statusUpdate',
    value: { taskId: 't', contextId: 'c', status: status(state, text), metadata: undefined },
  },
});

const textArtifact = (value: string): Artifact => ({
  artifactId: 'a',
  name: 'a',
  description: '',
  parts: [
    {
      content: { $case: 'text', value },
      metadata: undefined,
      filename: '',
      mediaType: 'text/plain',
    },
  ],
  metadata: undefined,
  extensions: [],
});

const artifactEvent = (artifact: Artifact, append: boolean): PeerStreamEvent => ({
  payload: {
    $case: 'artifactUpdate',
    value: {
      taskId: 't',
      contextId: 'c',
      artifact,
      append,
      lastChunk: false,
      metadata: undefined,
    },
  },
});

function tracker(awaitFollowUp: boolean, limit = 1000, updates: A2APeerUpdate[] = []) {
  return new PeerTaskTracker(
    peer,
    { text: 'hi', onUpdate: (u) => updates.push(u) },
    limit,
    awaitFollowUp,
  );
}

describe('PeerTaskTracker', () => {
  test('a terminal first response ends the wait after a continuation, a question does not', () => {
    // A repeated send (same messageId) is answered with the task the first send finished.
    for (const state of [
      TaskState.TASK_STATE_COMPLETED,
      TaskState.TASK_STATE_FAILED,
      TaskState.TASK_STATE_CANCELED,
      TaskState.TASK_STATE_REJECTED,
    ]) {
      const t = tracker(true);
      t.apply(taskEvent(state, 'finished'));
      t.markHeadSeen();
      expect(t.stopped()).toBe(true);
    }
    for (const state of [TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED]) {
      const t = tracker(true);
      t.apply(taskEvent(state, 'still asking'));
      t.markHeadSeen();
      expect(t.stopped()).toBe(false);
    }
  });

  test('only a status event ends the wait after a continuation', () => {
    const t = tracker(true);
    t.apply(taskEvent(TaskState.TASK_STATE_INPUT_REQUIRED, 'q1'));
    t.markHeadSeen();
    expect(t.stopped()).toBe(false);

    t.apply(artifactEvent(textArtifact('partial'), false));
    t.apply({ payload: undefined });
    expect(t.stopped()).toBe(false);

    t.apply(statusEvent(TaskState.TASK_STATE_INPUT_REQUIRED, 'q2'));
    expect(t.stopped()).toBe(true);
    expect(t.outcome()).toMatchObject({ state: 'input-required', message: 'q2' });
  });

  test('a status frame for another task is refused without ending the wait after a continuation', () => {
    const t = tracker(true);
    t.apply(taskEvent(TaskState.TASK_STATE_INPUT_REQUIRED, 'q1'));
    t.markHeadSeen();
    expect(t.stopped()).toBe(false);

    const otherTask: PeerStreamEvent = {
      payload: {
        $case: 'statusUpdate',
        value: {
          taskId: 'another',
          contextId: 'c',
          status: status(TaskState.TASK_STATE_COMPLETED, 'not ours'),
          metadata: undefined,
        },
      },
    };
    const otherContext: PeerStreamEvent = {
      payload: {
        $case: 'statusUpdate',
        value: {
          taskId: 't',
          contextId: 'another',
          status: status(TaskState.TASK_STATE_COMPLETED, 'not ours'),
          metadata: undefined,
        },
      },
    };

    expect(() => t.apply(otherTask)).toThrow();
    expect(() => t.apply(otherContext)).toThrow();
    // The refused frames changed nothing: the task still waits for the answer it was sent.
    expect(t.stopped()).toBe(false);
    expect(t.outcome()).toMatchObject({ state: 'input-required', message: 'q1' });
  });

  test('keeps at most the limit of content per artifact however many chunks arrive', () => {
    const t = tracker(false, 10);
    t.apply(taskEvent(TaskState.TASK_STATE_WORKING));
    t.apply(artifactEvent(textArtifact('12345678'), false));
    for (let chunk = 0; chunk < 50; chunk++) {
      t.apply(artifactEvent(textArtifact('abcdefgh'), true));
    }
    const parts = t.outcome().artifacts[0]?.parts ?? [];
    const kept = parts.reduce(
      (sum, part) => sum + (part.kind === 'text' ? part.text.length : 0),
      0,
    );
    expect(kept).toBeLessThanOrEqual(10);
    expect(parts.at(-1)).toMatchObject({ kind: 'omitted', reason: 'too-large' });
  });

  test('emits the peer state after a local cancel is cleared', () => {
    const updates: A2APeerUpdate[] = [];
    const t = tracker(false, 1000, updates);
    t.apply(taskEvent(TaskState.TASK_STATE_WORKING));
    t.cancelLocally({ confirmed: false, error: 'refused' });
    t.applyTask({
      id: 't',
      contextId: 'c',
      status: status(TaskState.TASK_STATE_COMPLETED, 'done'),
      artifacts: [],
      history: [],
      metadata: undefined,
    });
    t.clearLocalCancel();
    expect(updates.at(-1)?.state).toBe('completed');
    expect(t.outcome().state).toBe('completed');
  });
});
