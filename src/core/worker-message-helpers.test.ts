import { describe, expect, it, mock } from 'bun:test';

import { deliverForwardedWorkerLog, emitWorkerMessageToEngine } from './worker-message-helpers.ts';
import type { WorkerLogMessageCandidate } from './worker-protocol-log.ts';

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

describe('deliverForwardedWorkerLog (#529)', () => {
  // The caller (the strategy) gates on worker-ownership before this helper runs; the
  // helper is the mechanical tail: full-shape validity, record/envelope identity match,
  // size cap, deliver-with-console-fallback. None of these paths throw or signal discard.
  function logMessage(record: unknown, envelopeWorkflowId = 'wf-1'): WorkerLogMessageCandidate {
    return { type: 'log', workflowId: envelopeWorkflowId, record };
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
    deliverForwardedWorkerLog(logMessage(validRecord), (record) => received.push(record), 4_096);
    expect(received).toEqual([expect.objectContaining({ message: 'hello' })]);
  });

  it('delivers when no size cap is configured', () => {
    const sink = mock(() => {});
    deliverForwardedWorkerLog(logMessage(validRecord), sink, undefined);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('drops a malformed record without calling the sink', () => {
    const sink = mock(() => {});
    deliverForwardedWorkerLog(logMessage({ not: 'a-log' }), sink, 4_096);
    expect(sink).not.toHaveBeenCalled();
  });

  it('drops a record whose workflowId does not match the envelope', () => {
    const sink = mock(() => {});
    const otherWorkflowRecord = { ...validRecord, workflowId: 'wf-other' };
    deliverForwardedWorkerLog(logMessage(otherWorkflowRecord, 'wf-1'), sink, 4_096);
    expect(sink).not.toHaveBeenCalled();
  });

  it('drops a record missing required envelope fields', () => {
    const sink = mock(() => {});
    // Missing workflowType and timestamp.
    const partial = { level: 'info', message: 'hi', workflowId: 'wf-1' };
    deliverForwardedWorkerLog(logMessage(partial), sink, 4_096);
    expect(sink).not.toHaveBeenCalled();
  });

  it('drops an oversized record without calling the sink', () => {
    const sink = mock(() => {});
    const oversize = { ...validRecord, attributes: { blob: 'x'.repeat(8_192) } };
    deliverForwardedWorkerLog(logMessage(oversize), sink, 4_096);
    expect(sink).not.toHaveBeenCalled();
  });

  it('falls a throwing sink back to console (a logging error never propagates)', () => {
    const sink = mock(() => {
      throw new Error('sink blew up');
    });
    const consoleInfo = mock(() => {});
    const originalConsoleInfo = console.info;
    console.info = consoleInfo as unknown as typeof console.info;
    try {
      expect(() => deliverForwardedWorkerLog(logMessage(validRecord), sink, 4_096)).not.toThrow();
      expect(sink).toHaveBeenCalledTimes(1);
      expect(consoleInfo).toHaveBeenCalledWith(expect.objectContaining({ message: 'hello' }));
    } finally {
      console.info = originalConsoleInfo;
    }
  });

  it('is a no-op when no sink is installed', () => {
    expect(() =>
      deliverForwardedWorkerLog(logMessage(validRecord), undefined, 4_096),
    ).not.toThrow();
  });
});
