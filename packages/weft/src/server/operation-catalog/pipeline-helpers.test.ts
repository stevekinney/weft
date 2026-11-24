/**
 * COR-1283: `transportToPolicyKey` maps a transport kind to its
 * `UnknownKeyPolicy` bucket — `'http-rest'` uses the dedicated `http` key,
 * every JSON-RPC transport (HTTP, WebSocket, stdio) shares the single
 * `jsonRpc` key.
 */
import { describe, expect, it } from 'bun:test';

import {
  classifyEngineError,
  transportToAvailabilityKey,
  transportToPolicyKey,
} from "../../embedded/backchannel/src/internals.ts";
import { WorkflowAlreadyExistsError, WorkflowNotFoundError } from '../../core/engine/errors.ts';
import { weftFaultPolicy } from '../weft-fault-policy.ts';

describe('transportToPolicyKey', () => {
  it('maps http-rest to the dedicated http policy key', () => {
    expect(transportToPolicyKey('http-rest')).toBe('http');
  });

  it('maps every JSON-RPC transport to the shared jsonRpc policy key', () => {
    expect(transportToPolicyKey('jsonRpcHttp')).toBe('jsonRpc');
    expect(transportToPolicyKey('jsonRpcWebSocket')).toBe('jsonRpc');
    expect(transportToPolicyKey('jsonRpcStdio')).toBe('jsonRpc');
  });
});

describe('transportToAvailabilityKey', () => {
  it('maps each supported transport to its availability flag', () => {
    expect(transportToAvailabilityKey('http-rest')).toBe('http');
    expect(transportToAvailabilityKey('jsonRpcHttp')).toBe('jsonRpcHttp');
    expect(transportToAvailabilityKey('jsonRpcWebSocket')).toBe('jsonRpcWebSocket');
    expect(transportToAvailabilityKey('jsonRpcStdio')).toBe('jsonRpcStdio');
  });

  it('throws naming an unknown transport kind rather than guessing a flag', () => {
    expect(() => transportToAvailabilityKey('carrier-pigeon' as never)).toThrow(
      'Unknown transport kind: "carrier-pigeon"',
    );
  });

  it('does not resolve an inherited Object.prototype key to a flag', () => {
    expect(() => transportToAvailabilityKey('constructor' as never)).toThrow(
      'Unknown transport kind: "constructor"',
    );
    expect(() => transportToAvailabilityKey('toString' as never)).toThrow(
      'Unknown transport kind: "toString"',
    );
  });
});

describe('classifyEngineError typed engine errors', () => {
  it('classifies a duplicate workflow id as a Conflict without echoing the message', () => {
    expect(classifyEngineError(new WorkflowAlreadyExistsError('wf-1'))).toEqual({
      code: 'Conflict',
      message: 'conflict',
      data: { reason: 'resource already exists' },
    });
  });

  it('classifies a missing workflow as a NotFound naming the workflow resource', () => {
    expect(
      classifyEngineError(new WorkflowNotFoundError('wf-1'), undefined, weftFaultPolicy),
    ).toEqual({
      code: 'NotFound',
      message: 'not found',
      data: { resource: 'workflow' },
    });
  });

  it('falls back to an opaque EngineFailure for a thrown non-Error value', () => {
    expect(classifyEngineError('boom')).toEqual({
      code: 'EngineFailure',
      message: 'internal error',
      data: {},
    });
  });
});
