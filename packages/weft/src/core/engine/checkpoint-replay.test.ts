import { describe, expect, it } from 'bun:test';

import type { Checkpoint } from '../types.ts';
import { WORKER_REPLAY_SIGNATURE_FORMAT } from '../types/checkpoint.ts';
import { pruneCheckpointReplayState } from './checkpoint-replay.ts';

function createCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    workflowId: 'workflow-id',
    step: 4,
    locals: {},
    accumulatedResults: [],
    searchAttributes: {},
    version: '1',
    schemaVersion: 2,
    createdAt: 1,
    ...overrides,
  };
}

describe('checkpoint replay pruning', () => {
  it('moves consumed accumulated results into a replay payload and leaves pending results in the checkpoint', () => {
    const checkpoint = createCheckpoint({
      accumulatedResults: [
        [0, 'completed'],
        [1, 'pending'],
      ],
    });

    const pruned = pruneCheckpointReplayState(checkpoint, 1);

    expect(pruned.checkpoint.accumulatedResults).toEqual([[1, 'pending']]);
    expect(pruned.checkpoint.accumulatedResultReplayWatermark).toBe(0);
    expect(pruned.replayPayload).toEqual({
      accumulatedResults: [[0, 'completed']],
    });
  });

  it('does not re-emit consumed results that are already covered by the replay watermark', () => {
    const checkpoint = createCheckpoint({
      accumulatedResultReplayWatermark: 0,
      accumulatedResults: [
        [0, 'already-emitted'],
        [1, 'new'],
      ],
    });

    const pruned = pruneCheckpointReplayState(checkpoint, 2);

    expect(pruned.checkpoint.accumulatedResults).toEqual([]);
    expect(pruned.checkpoint.accumulatedResultReplayWatermark).toBe(1);
    expect(pruned.replayPayload).toEqual({
      accumulatedResults: [[1, 'new']],
    });
  });

  it('prunes consumed worker replay metadata with the same pending-step frontier', () => {
    const checkpoint = createCheckpoint({
      accumulatedResults: [
        [0, 'worker-result'],
        [1, 'pending-result'],
      ],
      workerReplaySignatures: [
        [
          0,
          {
            format: WORKER_REPLAY_SIGNATURE_FORMAT,
            operationType: 'activity',
            stableFieldsDigest: 'digest-0',
            stableFieldsByteLength: 10,
          },
        ],
        [
          1,
          {
            format: WORKER_REPLAY_SIGNATURE_FORMAT,
            operationType: 'activity',
            stableFieldsDigest: 'digest-1',
            stableFieldsByteLength: 10,
          },
        ],
      ],
      workerReplayFailures: [
        [
          0,
          {
            status: 'failed',
            error: 'old failure',
            failureCategory: 'timeout',
          },
        ],
      ],
    });

    const pruned = pruneCheckpointReplayState(checkpoint, 1);

    expect(pruned.checkpoint.accumulatedResults).toEqual([[1, 'pending-result']]);
    expect(pruned.checkpoint.workerReplaySignatures).toEqual([
      [
        1,
        {
          format: WORKER_REPLAY_SIGNATURE_FORMAT,
          operationType: 'activity',
          stableFieldsDigest: 'digest-1',
          stableFieldsByteLength: 10,
        },
      ],
    ]);
    expect(pruned.checkpoint.workerReplayFailures).toBeUndefined();
    expect(pruned.replayPayload).toEqual({
      accumulatedResults: [[0, 'worker-result']],
      workerReplaySignatures: [
        [
          0,
          {
            format: WORKER_REPLAY_SIGNATURE_FORMAT,
            operationType: 'activity',
            stableFieldsDigest: 'digest-0',
            stableFieldsByteLength: 10,
          },
        ],
      ],
      workerReplayFailures: [
        [
          0,
          {
            status: 'failed',
            error: 'old failure',
            failureCategory: 'timeout',
          },
        ],
      ],
    });
  });
});
