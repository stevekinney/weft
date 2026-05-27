import { describe, expect, it } from 'bun:test';

import {
  assertIdenticalFaultCode,
  assertIdenticalJson,
  assertShapeEquivalent,
} from './track8-parity-invariants.test-support.ts';

describe('track8 parity invariants', () => {
  it('accepts identical JSON payloads', () => {
    expect(() =>
      assertIdenticalJson(
        { workflowId: 'workflow-123', nested: { count: 1 } },
        { workflowId: 'workflow-123', nested: { count: 1 } },
        'identical-json success',
      ),
    ).not.toThrow();
  });

  it('reports a descriptive error when identical JSON payloads differ', () => {
    expect(() =>
      assertIdenticalJson(
        { workflowId: 'workflow-123', nested: { count: 1 } },
        { workflowId: 'workflow-123', nested: { count: 2 } },
        'identical-json mismatch',
      ),
    ).toThrow(/Parity invariant violated \[identical-json mismatch\]/);
  });

  it('accepts shape-equivalent payloads when values differ but structure matches', () => {
    expect(() =>
      assertShapeEquivalent(
        {
          workflowId: 'workflow-123',
          metadata: { createdAt: '2026-04-29T00:00:00.000Z', status: 'running' },
        },
        {
          workflowId: 'workflow-456',
          metadata: { createdAt: '2026-04-30T00:00:00.000Z', status: 'completed' },
        },
        'shape-equivalent success',
      ),
    ).not.toThrow();
  });

  it('rejects shape-equivalent payloads when types differ', () => {
    expect(() =>
      assertShapeEquivalent(
        { metadata: { count: 1 } },
        { metadata: { count: '1' } },
        'shape-equivalent type mismatch',
      ),
    ).toThrow(/same typeof at path "shape-equivalent type mismatch\.metadata\.count"/);
  });

  it('rejects shape-equivalent payloads when keys differ', () => {
    expect(() =>
      assertShapeEquivalent(
        { metadata: { createdAt: '2026-04-29T00:00:00.000Z', status: 'running' } },
        { metadata: { createdAt: '2026-04-29T00:00:00.000Z', workflowId: 'workflow-123' } },
        'shape-equivalent key mismatch',
      ),
    ).toThrow(/same keys at path "shape-equivalent key mismatch\.metadata"/);
  });

  it('accepts identical fault codes', () => {
    expect(() =>
      assertIdenticalFaultCode('WorkflowNotFound', 'WorkflowNotFound', 'fault-code success'),
    ).not.toThrow();
  });

  it('rejects mismatched fault codes with both codes in the message', () => {
    expect(() =>
      assertIdenticalFaultCode('WorkflowNotFound', 'ValidationError', 'fault-code mismatch'),
    ).toThrow(/Transport A code: WorkflowNotFound[\s\S]*Transport B code: ValidationError/);
  });
});
