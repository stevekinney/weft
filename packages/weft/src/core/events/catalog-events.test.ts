import { describe, expect, it } from 'bun:test';

import {
  WorkflowRevisionActivatedEvent,
  WorkflowRevisionActivationRejectedEvent,
  WorkflowRevisionDrainingEvent,
  WorkflowRevisionInstalledEvent,
  WorkflowRevisionRemovedEvent,
} from './catalog-events.ts';

describe('WorkflowRevisionInstalledEvent', () => {
  it('carries type, workflowType, and revision', () => {
    const event = new WorkflowRevisionInstalledEvent('checkout', 'rev-1');
    expect(event.type).toBe('catalog:revision-installed');
    expect(WorkflowRevisionInstalledEvent.type).toBe('catalog:revision-installed');
    expect(event.workflowType).toBe('checkout');
    expect(event.revision).toBe('rev-1');
  });
});

describe('WorkflowRevisionActivatedEvent', () => {
  it('carries workflowType, revision, generation, and previousRevision', () => {
    const event = new WorkflowRevisionActivatedEvent('checkout', 'rev-2', 2, 'rev-1');
    expect(event.type).toBe('catalog:revision-activated');
    expect(event.workflowType).toBe('checkout');
    expect(event.revision).toBe('rev-2');
    expect(event.generation).toBe(2);
    expect(event.previousRevision).toBe('rev-1');
  });

  it('leaves previousRevision undefined on a first-ever activation', () => {
    const event = new WorkflowRevisionActivatedEvent('checkout', 'rev-1', 1, undefined);
    expect(event.previousRevision).toBeUndefined();
  });
});

describe('WorkflowRevisionActivationRejectedEvent', () => {
  it('carries the reason code without incompatibilityReasons for stale-generation', () => {
    const event = new WorkflowRevisionActivationRejectedEvent(
      'checkout',
      'rev-3',
      'stale-generation',
    );
    expect(event.type).toBe('catalog:activation-rejected');
    expect(event.workflowType).toBe('checkout');
    expect(event.candidateRevision).toBe('rev-3');
    expect(event.reason).toBe('stale-generation');
    expect(event.incompatibilityReasons).toBeUndefined();
  });

  it('carries the bounded incompatibilityReasons array for an incompatible candidate', () => {
    const event = new WorkflowRevisionActivationRejectedEvent('checkout', 'rev-3', 'incompatible', [
      'contract-hash-mismatch',
    ]);
    expect(event.reason).toBe('incompatible');
    expect(event.incompatibilityReasons).toEqual(['contract-hash-mismatch']);
  });

  it('carries the conflict reason', () => {
    const event = new WorkflowRevisionActivationRejectedEvent('checkout', 'rev-3', 'conflict');
    expect(event.reason).toBe('conflict');
  });
});

describe('WorkflowRevisionDrainingEvent', () => {
  it('carries workflowType and the draining revision', () => {
    const event = new WorkflowRevisionDrainingEvent('checkout', 'rev-1');
    expect(event.type).toBe('catalog:revision-draining');
    expect(event.workflowType).toBe('checkout');
    expect(event.revision).toBe('rev-1');
  });
});

describe('WorkflowRevisionRemovedEvent', () => {
  it('carries workflowType and the removed revision', () => {
    const event = new WorkflowRevisionRemovedEvent('checkout', 'rev-1');
    expect(event.type).toBe('catalog:revision-removed');
    expect(event.workflowType).toBe('checkout');
    expect(event.revision).toBe('rev-1');
  });
});
