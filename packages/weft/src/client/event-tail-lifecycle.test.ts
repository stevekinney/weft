import { describe, expect, it } from 'bun:test';

import type { WorkflowEvent } from '../core/types.ts';
import { WorkflowEventTailLifecycle } from './event-tail-lifecycle.ts';

const event: WorkflowEvent = { type: 'activity:started', timestamp: 1, data: {} };

describe('WorkflowEventTailLifecycle emit', () => {
  it('keeps delivering to the iterator when the listener throws', async () => {
    const lifecycle = new WorkflowEventTailLifecycle({
      bufferForIteration: true,
      onClose: () => {},
    });

    const delivered = lifecycle.emit(event, () => {
      throw new Error('listener failed');
    });
    lifecycle.close();

    expect(delivered).toBe(true);
    const received: WorkflowEvent[] = [];
    for await (const next of lifecycle) received.push(next);
    expect(received).toEqual([event]);
    expect(lifecycle.closeReason).toBe('client-closed');
  });

  it('refuses events once closed, without calling the listener', () => {
    const lifecycle = new WorkflowEventTailLifecycle({ onClose: () => {} });
    lifecycle.close();
    let calls = 0;

    expect(lifecycle.emit(event, () => (calls += 1))).toBe(false);
    expect(calls).toBe(0);
  });
});
