import { describe, expect, it } from 'bun:test';

import { buildResumeMessage, buildRunMessage } from './worker-inbound-message.ts';
import { WORKER_PROTOCOL_VERSION } from './worker-protocol.ts';

describe('worker inbound message builders (#529)', () => {
  describe('buildRunMessage', () => {
    const base = {
      workflowId: 'wf-1',
      workflowType: 'demo',
      input: { value: 1 },
      checkpoint: new ArrayBuffer(0),
    };

    it('stamps protocol version, turn id, and defaults executionStateOwnerId to workflowId', () => {
      const message = buildRunMessage(base, {
        turnId: 7,
        maxProtocolMessageBytes: undefined,
        hasLogSink: false,
      });
      expect(message).toMatchObject({
        type: 'run',
        protocolVersion: WORKER_PROTOCOL_VERSION,
        turnId: 7,
        workflowId: 'wf-1',
        workflowType: 'demo',
        executionStateOwnerId: 'wf-1',
      });
      expect(message.maxProtocolMessageBytes).toBeUndefined();
      expect(message.hostHasLogSink).toBeUndefined();
    });

    it('carries maxProtocolMessageBytes, deadline, headers, hostHasLogSink, and explicit owner', () => {
      const message = buildRunMessage(
        {
          ...base,
          executionStateOwnerId: 'owner-9',
          deadline: 1234,
          headers: [['x-trace', 'abc']],
        },
        { turnId: 2, maxProtocolMessageBytes: 4_096, hasLogSink: true },
      );
      expect(message).toMatchObject({
        executionStateOwnerId: 'owner-9',
        maxProtocolMessageBytes: 4_096,
        deadline: 1234,
        headers: [['x-trace', 'abc']],
        hostHasLogSink: true,
      });
    });
  });

  describe('buildResumeMessage', () => {
    const base = {
      workflowId: 'wf-1',
      checkpoint: new ArrayBuffer(0),
      operationResult: { status: 'completed' as const, value: 'ok' },
    };

    it('stamps protocol version and turn id without optional fields', () => {
      const message = buildResumeMessage(base, {
        turnId: 5,
        maxProtocolMessageBytes: undefined,
        hasLogSink: false,
      });
      expect(message).toMatchObject({
        type: 'resume',
        protocolVersion: WORKER_PROTOCOL_VERSION,
        turnId: 5,
        workflowId: 'wf-1',
      });
      expect(message.maxProtocolMessageBytes).toBeUndefined();
      expect(message.hostHasLogSink).toBeUndefined();
    });

    it('carries maxProtocolMessageBytes and hostHasLogSink when set', () => {
      const message = buildResumeMessage(base, {
        turnId: 6,
        maxProtocolMessageBytes: 8_192,
        hasLogSink: true,
      });
      expect(message).toMatchObject({ maxProtocolMessageBytes: 8_192, hostHasLogSink: true });
    });
  });
});
