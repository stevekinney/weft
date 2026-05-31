import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../../storage/memory.ts';
import {
  DEFAULT_RETENTION_SWEEP_BATCH_SIZE,
  DEFAULT_RETENTION_SWEEP_INTERVAL_MS,
  type Duration,
  type RetentionPolicy,
} from '../../types.ts';
import {
  createExecutionStrategyBundle,
  normalizeWorkerExecutionConfiguration,
  resolveEngineOptions,
} from '../construction.ts';
import { normalizeRetentionDuration, normalizeRetentionPolicy } from '../validation.ts';

const getNow = () => 1_234;

describe('resolveEngineOptions', () => {
  it('uses default values when constructor options are omitted', () => {
    const storage = new MemoryStorage();
    const resolved = resolveEngineOptions(storage, undefined, getNow);

    expect(resolved.development).toBe(false);
    expect(resolved.checkpointHistory).toBe(10);
    expect(resolved.checkpointSizeWarningThreshold).toBe(65_536);
    expect(resolved.maxNestingDepth).toBe(10);
    expect(resolved.broadcastEvents).toBe(false);
    expect(resolved.retentionSweepIntervalMs).toBe(DEFAULT_RETENTION_SWEEP_INTERVAL_MS);
    expect(resolved.retentionSweepBatchSize).toBe(DEFAULT_RETENTION_SWEEP_BATCH_SIZE);
    expect(resolved.storage).toBe(storage);
    expect(resolved.getNow).toBe(getNow);
    expect(resolved.retention).toEqual(normalizeRetentionPolicy(undefined, 'options.retention'));
  });

  it('passes explicit constructor option values through', () => {
    const storage = new MemoryStorage();
    const suppliedRetention = {
      completed: '1d',
      failed: 12_000,
      cancelled: '2h',
      timedOut: '30m',
    } satisfies RetentionPolicy;
    const suppliedInterval = '15s' satisfies Duration;

    const resolved = resolveEngineOptions(
      storage,
      {
        development: true,
        checkpointHistory: 25,
        checkpointSizeWarningThreshold: 131_072,
        maxNestingDepth: 6,
        broadcastEvents: true,
        retention: suppliedRetention,
        retentionSweepInterval: suppliedInterval,
        retentionSweepBatchSize: 42,
      },
      getNow,
    );

    expect(resolved.development).toBe(true);
    expect(resolved.checkpointHistory).toBe(25);
    expect(resolved.checkpointSizeWarningThreshold).toBe(131_072);
    expect(resolved.maxNestingDepth).toBe(6);
    expect(resolved.broadcastEvents).toBe(true);
    expect(resolved.retention).toEqual(
      normalizeRetentionPolicy(suppliedRetention, 'options.retention'),
    );
    const normalizedSweepInterval = normalizeRetentionDuration(
      suppliedInterval,
      'options.retentionSweepInterval',
    );
    if (normalizedSweepInterval === undefined) {
      throw new Error('Expected supplied retention sweep interval to normalize');
    }
    expect(resolved.retentionSweepIntervalMs).toBe(normalizedSweepInterval);
    expect(resolved.retentionSweepBatchSize).toBe(42);
    expect(resolved.storage).toBe(storage);
    expect(resolved.getNow).toBe(getNow);
  });

  it('clamps fractional retention sweep batch sizes below one', () => {
    const resolved = resolveEngineOptions(
      new MemoryStorage(),
      { retentionSweepBatchSize: 0.4 },
      getNow,
    );

    expect(resolved.retentionSweepBatchSize).toBe(1);
  });

  it('floors fractional retention sweep batch sizes above one', () => {
    const resolved = resolveEngineOptions(
      new MemoryStorage(),
      { retentionSweepBatchSize: 3.7 },
      getNow,
    );

    expect(resolved.retentionSweepBatchSize).toBe(3);
  });

  it('returns null for invalid-shape retention input (non-record value)', () => {
    // Original normalizeRetentionPolicy uses `if (!policy)` -- a non-record truthy value like
    // a string passes that check, accesses undefined properties for each duration field,
    // and returns null because isEmpty is true.
    expect(normalizeRetentionPolicy('invalid-shape' as any, 'options.retention')).toBeNull();
    expect(
      resolveEngineOptions(new MemoryStorage(), { retention: 'invalid-shape' as any }, getNow)
        .retention,
    ).toBeNull();
  });

  it('coerces explicit-null scalar fields to documented defaults (JS-caller safety)', () => {
    // Untyped JavaScript callers can pass `null` even though TypeScript types
    // forbid it. The pre-refactor `options?.field ?? default` pattern coerced
    // null to the default; defaulting must preserve that behavior so non-TS
    // callers don't see null slip into ResolvedOptions.
    const resolved = resolveEngineOptions(
      new MemoryStorage(),
      {
        development: null as any,
        checkpointHistory: null as any,
        checkpointSizeWarningThreshold: null as any,
        maxNestingDepth: null as any,
        broadcastEvents: null as any,
      },
      getNow,
    );

    expect(resolved.development).toBe(false);
    expect(resolved.checkpointHistory).toBe(10);
    expect(resolved.checkpointSizeWarningThreshold).toBe(65_536);
    expect(resolved.maxNestingDepth).toBe(10);
    expect(resolved.broadcastEvents).toBe(false);
  });
});

describe('normalizeWorkerExecutionConfiguration', () => {
  const workerUrl = new URL('../../../workers/test-browser-worker.ts', import.meta.url);

  it('defaults to inline when workflowExecutionMode is omitted', () => {
    expect(normalizeWorkerExecutionConfiguration(undefined)).toEqual({
      mode: 'inline',
      workerExecution: null,
    });
    expect(normalizeWorkerExecutionConfiguration({})).toEqual({
      mode: 'inline',
      workerExecution: null,
    });
  });

  it('rejects worker configuration without explicit worker mode', () => {
    expect(() =>
      normalizeWorkerExecutionConfiguration({ workerExecution: { workerUrl } }),
    ).toThrow('options.workflowExecutionMode must be "worker"');
  });

  it('applies hardened defaults for explicit worker mode', () => {
    expect(
      normalizeWorkerExecutionConfiguration({
        workflowExecutionMode: 'worker',
        workerExecution: { workerUrl },
      }),
    ).toMatchObject({
      mode: 'worker',
      workflowTurnTimeoutMs: 1_000,
      maxProtocolMessageBytes: 1_048_576,
      requireProtocolVersion: true,
      discardOnCancel: true,
    });
  });

  it('always hardens worker mode even without timeout or protocol overrides', () => {
    // Worker mode is reachable only via explicit `workflowExecutionMode: 'worker'`,
    // so the protocol-version and discard-on-cancel guards are always on and the
    // timeout/protocol-size defaults always apply — there is no weaker branch.
    expect(
      normalizeWorkerExecutionConfiguration({
        workflowExecutionMode: 'worker',
        workerExecution: { workerUrl },
      }),
    ).toEqual({
      mode: 'worker',
      workerExecution: { workerUrl },
      workflowTurnTimeoutMs: 1_000,
      maxProtocolMessageBytes: 1_048_576,
      requireProtocolVersion: true,
      discardOnCancel: true,
    });
  });

  it('rejects explicit worker mode without worker configuration', () => {
    expect(() =>
      normalizeWorkerExecutionConfiguration({ workflowExecutionMode: 'worker' }),
    ).toThrow('workerExecution is required');
  });

  it('rejects explicit inline mode with worker configuration', () => {
    expect(() =>
      normalizeWorkerExecutionConfiguration({
        workflowExecutionMode: 'inline',
        workerExecution: { workerUrl },
      }),
    ).toThrow('cannot be provided');
  });

  it('allows explicit inline mode without worker configuration', () => {
    expect(
      normalizeWorkerExecutionConfiguration({
        workflowExecutionMode: 'inline',
      }),
    ).toEqual({
      mode: 'inline',
      workerExecution: null,
    });
  });

  it('rejects unknown workflow execution modes', () => {
    expect(() =>
      normalizeWorkerExecutionConfiguration({
        workflowExecutionMode: 'remote' as never,
      }),
    ).toThrow('workflowExecutionMode');
  });

  for (const value of [
    Number.NaN,
    Infinity,
    1.5,
    -1,
    0,
    null,
    '1000',
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    it(`rejects invalid worker turn timeout value ${String(value)}`, () => {
      expect(() =>
        normalizeWorkerExecutionConfiguration({
          workflowExecutionMode: 'worker',
          workerExecution: { workerUrl, workflowTurnTimeoutMs: value as any },
        }),
      ).toThrow('workflowTurnTimeoutMs');
    });
  }

  it('rejects protocol message limits below the bounded failure envelope minimum', () => {
    expect(() =>
      normalizeWorkerExecutionConfiguration({
        workflowExecutionMode: 'worker',
        workerExecution: { workerUrl, maxProtocolMessageBytes: 4_095 },
      }),
    ).toThrow('at least 4096');
  });

  it('routes explicit worker mode through the Worker execution strategy bundle', () => {
    const bundle = createExecutionStrategyBundle({
      options: {
        workflowExecutionMode: 'worker',
        workerExecution: { workerUrl },
      },
      getNow,
      maxNestingDepth: 10,
      development: false,
      broadcastEvents: false,
      getRegistration: () => undefined,
      resolveWorkflowType: (target) => String(target),
    });

    expect(bundle.inlineStrategy).toBeNull();
  });
});
