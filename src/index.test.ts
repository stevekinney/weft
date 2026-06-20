import { describe, expect, it } from 'bun:test';

import packageJson from '../package.json';
import { workflow } from './core/types/workflow-function.ts';
import type {
  WorkflowOperation,
  WorkflowReplay,
  WorkflowServicesResolverInfo,
  WorkflowServicesResolverLaunchOptions,
  WorkflowServicesResolverScheduleInfo,
  WorkflowTimelineEntry,
} from './index';
import {
  Engine,
  IdempotencyKeyPurgedError,
  isWeftErrorLike,
  MemoryStorage,
  StartOrSignalConflictError,
  VERSION,
  WorkflowAlreadyExistsError,
  WorkflowTeardownPendingError,
} from './index';

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

  it('exports workflow services resolver context types', () => {
    const launchOptions: WorkflowServicesResolverLaunchOptions = {
      id: 'workflow-1',
      tags: ['alpha'],
    };
    const schedule: WorkflowServicesResolverScheduleInfo = {
      id: 'schedule-1',
      occurrence: 1,
    };
    const resolverInfo: WorkflowServicesResolverInfo = {
      workflowId: 'workflow-1',
      workflowType: 'checkout',
      input: { customerId: 'customer-1' },
      launchOptions,
      schedule,
    };

    expect(resolverInfo.launchOptions?.id).toBe('workflow-1');
    expect(resolverInfo.schedule?.id).toBe('schedule-1');
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

  it('exports StartOrSignalConflictError for startOrSignal against a terminal run', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const done = workflow({ name: 'startorsignal-terminal' }).execute(async function* () {
      return 'ok';
    });
    engine.register(done);

    try {
      const handle = await engine.start('startorsignal-terminal', null, { id: 'sos-export' });
      await handle.result();
      await expect(
        engine.startOrSignal(
          'startorsignal-terminal',
          null,
          { name: 'noop', signalId: 'x' },
          { id: 'sos-export' },
        ),
      ).rejects.toBeInstanceOf(StartOrSignalConflictError);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('exports IdempotencyKeyPurgedError for a spent key whose run was purged', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const done = workflow({ name: 'idempotency-purged' }).execute(async function* () {
      return 'ok';
    });
    engine.register(done);

    try {
      // First start with the key creates the run and the durable mapping.
      const handle = await engine.start('idempotency-purged', null, {
        idempotencyKey: 'spent-key',
      });
      await handle.result();
      // Purge the run while the `start-idem:` mapping intentionally lives on.
      await engine.purge({ idPrefix: handle.id });
      // The key now maps to a workflow that no longer exists.
      await expect(
        engine.start('idempotency-purged', null, { idempotencyKey: 'spent-key' }),
      ).rejects.toBeInstanceOf(IdempotencyKeyPurgedError);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('registers startOrSignal conflict errors as public codes', () => {
    // These errors are public exports, so isWeftErrorLike (the cross-realm/duplicate-
    // module discriminant) must recognize them — which only holds if their codes are
    // in PUBLIC_WEFT_ERROR_CODES. A consumer routing faults to HTTP status by code
    // would otherwise fall through to a 500 handler instead of the intended 409.
    expect(isWeftErrorLike(new StartOrSignalConflictError('wf-1', 'completed'))).toBe(true);
    expect(isWeftErrorLike(new WorkflowTeardownPendingError('wf-1'))).toBe(true);
    expect(isWeftErrorLike(new IdempotencyKeyPurgedError('wf-1'))).toBe(true);
  });
});
