import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import { workflow } from '../types.ts';
import { parseCompletedReviewEntry } from './review-list-entries.ts';
import { decodeWorkflowState, resolveRetentionForStatus } from './validation.ts';
import { getWorkflowVisibilityWatermark } from './workflow-indexes.ts';

describe('getWorkflowVisibilityWatermark', () => {
  it('treats a watermark that does not decode as stale', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEYS.workflowVisibilityMetaVersion(), new Uint8Array([0xc1]));

    expect(await getWorkflowVisibilityWatermark(storage)).toBe('stale');
  });
});

describe('resolveRetentionForStatus', () => {
  it('has no retention for a status that is not terminal', () => {
    const policy = { completed: 1, failed: 2, cancelled: 3, timedOut: 4 };

    expect(resolveRetentionForStatus(policy, 'running')).toBeUndefined();
  });
});

describe('decodeWorkflowState', () => {
  it('returns a decoded value that is not a record without stripping fields', () => {
    const decoded: unknown = decodeWorkflowState(encode(['not', 'a', 'record']));
    expect(decoded).toEqual(['not', 'a', 'record']);
  });
});

describe('parseCompletedReviewEntry', () => {
  it('returns null for bytes that do not decode', () => {
    expect(parseCompletedReviewEntry(new Uint8Array([0xc1]))).toBeNull();
  });
});

describe('updateSchedule on a cancelled schedule', () => {
  it('keeps the schedule without a next fire time', async () => {
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    engine.register(
      workflow({ name: 'cancelled-schedule' }).execute(async function* () {
        return 'ok';
      }),
    );
    const handle = await engine.schedule('cancelled-schedule', null, '* * * * *');
    await handle.cancel();

    await handle.update('*/5 * * * *');

    const described = await handle.describe();
    expect(described.nextFireAt).toBeNull();
  });
});
