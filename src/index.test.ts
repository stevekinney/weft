import { describe, expect, it } from 'bun:test';

import type { WorkflowOperation, WorkflowReplay, WorkflowTimelineEntry } from './index';
import { Engine, MemoryStorage, VERSION, WorkflowAlreadyExistsError } from './index';

describe('weft', () => {
  it('exports a version string', () => {
    expect(VERSION).toBe('0.0.1');
  });

  it('exports Engine class', () => {
    expect(Engine).toBeDefined();
  });

  it('exports MemoryStorage class', () => {
    expect(MemoryStorage).toBeDefined();
  });

  it('exports timeline and replay types', () => {
    const timelineEntry: WorkflowTimelineEntry = {
      step: 1,
      operationType: 'run',
      operationLabel: 'run',
      inputSummary: '{"value":"ok"}',
      timestamp: 1_000,
      status: 'completed',
    };
    const replay: WorkflowReplay = {
      checkpoint: {
        step: 1,
        locals: { value: 'ok' },
        searchAttributes: {},
        version: '1.0.0',
        createdAt: 1_000,
      },
      accumulatedResults: [[0, { value: 'ok' }]],
      events: [],
    };

    expect(timelineEntry.operationType).toBe('run');
    expect(replay.checkpoint.step).toBe(1);
  });

  it('exports WorkflowOperation type', () => {
    const operation: WorkflowOperation<string> | undefined = undefined;
    expect(operation).toBeUndefined();
  });

  it('exports WorkflowAlreadyExistsError for duplicate workflow ids', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register('duplicate-id', async function* () {
      return 'ok';
    });

    try {
      await engine.start('duplicate-id', null, { id: 'duplicate-id' });
      await expect(
        engine.start('duplicate-id', null, { id: 'duplicate-id' }),
      ).rejects.toBeInstanceOf(WorkflowAlreadyExistsError);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});
