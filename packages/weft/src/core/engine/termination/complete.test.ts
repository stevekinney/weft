import { describe, expect, it } from 'bun:test';

import { finalizePendingTimelineEntry } from './complete.ts';

describe('finalizePendingTimelineEntry', () => {
  it('leaves a non-running, non-overridable entry unchanged', () => {
    const internals = {
      pendingTimelineEntries: new Map([
        [
          'wf-1',
          {
            startedAt: 10,
            entry: {
              status: 'paused',
              outputSummary: 'before',
              duration: 5,
            },
          },
        ],
      ]),
      options: { getNow: () => 20 },
    } as any;

    finalizePendingTimelineEntry(internals, 'wf-1', 'failed', 'after');

    expect(internals.pendingTimelineEntries.get('wf-1')?.entry).toEqual({
      status: 'paused',
      outputSummary: 'before',
      duration: 5,
    });
  });
});
