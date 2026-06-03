import { describe, expect, it } from 'bun:test';

import packageJson from '../package.json';
import { workflow } from './core/types/workflow-function.ts';
import type { WorkflowOperation, WorkflowReplay, WorkflowTimelineEntry } from './index';
import { Engine, MemoryStorage, VERSION, WorkflowAlreadyExistsError } from './index';

describe('weft', () => {
  it('exports a version string that matches package.json', () => {
    // VERSION is hand-maintained in src/version.ts; pin it to package.json so the
    // two cannot drift. scripts/verify-release-version.ts enforces the same
    // invariant at release time against the git tag.
    expect(VERSION).toBe(packageJson.version);
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
    const duplicate = workflow({ name: 'duplicate-id' }).execute(async function* () {
      return 'ok';
    });
    engine.register(duplicate);

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
