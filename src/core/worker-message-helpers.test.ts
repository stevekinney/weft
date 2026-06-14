import { describe, expect, it, mock } from 'bun:test';

import type { WorkerOutboundMessage } from './types.ts';
import { deliverWorkerLog, emitWorkerMessageToEngine } from './worker-message-helpers.ts';

describe('emitWorkerMessageToEngine', () => {
  const message = {
    type: 'completed',
    workflowId: 'wf-1',
    result: 'done',
  } as const;

  it('returns true when the synchronous handler throws', () => {
    expect(
      emitWorkerMessageToEngine(() => {
        throw new Error('boom');
      }, message),
    ).toBe(true);
  });

  it('returns false for a synchronous success and maps async success or failure to booleans', async () => {
    expect(emitWorkerMessageToEngine(() => {}, message)).toBe(false);
    await expect(emitWorkerMessageToEngine(async () => {}, message)).resolves.toBe(false);
    await expect(
      emitWorkerMessageToEngine(async () => {
        throw new Error('boom');
      }, message),
    ).resolves.toBe(true);
  });
});

describe('deliverWorkerLog (#529)', () => {
  function logMessage(record: unknown): Extract<WorkerOutboundMessage, { type: 'log' }> {
    return {
      type: 'log',
      workflowId: 'wf-1',
      record,
    } as Extract<WorkerOutboundMessage, { type: 'log' }>;
  }

  const validRecord = {
    level: 'info' as const,
    message: 'hello',
    workflowId: 'wf-1',
    workflowType: 'demo',
    timestamp: 0,
  };

  it('delivers a valid in-budget record to the sink', () => {
    const received: Array<{ message: string }> = [];
    deliverWorkerLog(logMessage(validRecord), (record) => received.push(record), 4_096);
    expect(received).toEqual([expect.objectContaining({ message: 'hello' })]);
  });

  it('delivers when no size cap is configured', () => {
    const sink = mock(() => {});
    deliverWorkerLog(logMessage(validRecord), sink, undefined);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('drops a malformed record without calling the sink', () => {
    const sink = mock(() => {});
    deliverWorkerLog(logMessage({ not: 'a-log' }), sink, 4_096);
    expect(sink).not.toHaveBeenCalled();
  });

  it('drops an oversized record without calling the sink', () => {
    const sink = mock(() => {});
    const oversize = { ...validRecord, attributes: { blob: 'x'.repeat(8_192) } };
    deliverWorkerLog(logMessage(oversize), sink, 4_096);
    expect(sink).not.toHaveBeenCalled();
  });

  it('swallows a throwing sink (a logging error never propagates)', () => {
    const sink = mock(() => {
      throw new Error('sink blew up');
    });
    expect(() => deliverWorkerLog(logMessage(validRecord), sink, 4_096)).not.toThrow();
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no sink is installed', () => {
    expect(() => deliverWorkerLog(logMessage(validRecord), undefined, 4_096)).not.toThrow();
  });
});
