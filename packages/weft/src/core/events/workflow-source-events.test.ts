import { describe, expect, it } from 'bun:test';

import {
  WorkflowSourceLoadCancelledEvent,
  WorkflowSourceLoadFailedEvent,
  WorkflowSourceLoadReadyEvent,
  WorkflowSourceLoadStartedEvent,
} from './workflow-source-events.ts';

describe('WorkflowSourceLoadStartedEvent', () => {
  it('carries type, workflowType, revision, and kind', () => {
    const event = new WorkflowSourceLoadStartedEvent('checkout', 'r1', 'module');
    expect(event.type).toBe('workflow-source:load-started');
    expect(WorkflowSourceLoadStartedEvent.type).toBe('workflow-source:load-started');
    expect(event.workflowType).toBe('checkout');
    expect(event.revision).toBe('r1');
    expect(event.kind).toBe('module');
  });
});

describe('WorkflowSourceLoadReadyEvent', () => {
  it('carries type, workflowType, revision, kind, and loadDurationMs', () => {
    const event = new WorkflowSourceLoadReadyEvent('checkout', 'r1', 'module', 42);
    expect(event.type).toBe('workflow-source:load-ready');
    expect(event.workflowType).toBe('checkout');
    expect(event.revision).toBe('r1');
    expect(event.kind).toBe('module');
    expect(event.loadDurationMs).toBe(42);
  });
});

describe('WorkflowSourceLoadFailedEvent', () => {
  it('carries type, workflowType, revision, kind, loadDurationMs, and failureCategory', () => {
    const event = new WorkflowSourceLoadFailedEvent('checkout', 'r1', 'module', 42, 'application');
    expect(event.type).toBe('workflow-source:load-failed');
    expect(event.workflowType).toBe('checkout');
    expect(event.revision).toBe('r1');
    expect(event.kind).toBe('module');
    expect(event.loadDurationMs).toBe(42);
    expect(event.failureCategory).toBe('application');
  });
});

describe('WorkflowSourceLoadCancelledEvent', () => {
  it('carries type, workflowType, revision, and kind', () => {
    const event = new WorkflowSourceLoadCancelledEvent('checkout', 'r1', 'module');
    expect(event.type).toBe('workflow-source:load-cancelled');
    expect(event.workflowType).toBe('checkout');
    expect(event.revision).toBe('r1');
    expect(event.kind).toBe('module');
  });
});
