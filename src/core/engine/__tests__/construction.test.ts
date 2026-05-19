import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../../storage/memory.ts';
import type { TenantResolver } from '../../tenant.ts';
import {
  DEFAULT_RETENTION_SWEEP_BATCH_SIZE,
  DEFAULT_RETENTION_SWEEP_INTERVAL_MS,
  type Duration,
  type RetentionPolicy,
} from '../../types.ts';
import { resolveEngineOptions } from '../construction.ts';
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
    expect(resolved.suspendOnLlmWait).toBe(false);
    expect(resolved.tenantResolver).toBeUndefined();
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
    const tenantResolver: TenantResolver = {
      resolve: () => ({ id: 'tenant-a' }),
    };

    const resolved = resolveEngineOptions(
      storage,
      {
        development: true,
        checkpointHistory: 25,
        checkpointSizeWarningThreshold: 131_072,
        maxNestingDepth: 6,
        broadcastEvents: true,
        suspendOnLlmWait: false,
        retention: suppliedRetention,
        retentionSweepInterval: suppliedInterval,
        retentionSweepBatchSize: 42,
        tenantResolver,
      },
      getNow,
    );

    expect(resolved.development).toBe(true);
    expect(resolved.checkpointHistory).toBe(25);
    expect(resolved.checkpointSizeWarningThreshold).toBe(131_072);
    expect(resolved.maxNestingDepth).toBe(6);
    expect(resolved.broadcastEvents).toBe(true);
    expect(resolved.suspendOnLlmWait).toBe(false);
    expect(resolved.tenantResolver).toBe(tenantResolver);
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

  it('keeps the suspendOnLlmWait implementation guard', () => {
    expect(() =>
      resolveEngineOptions(new MemoryStorage(), { suspendOnLlmWait: true }, getNow),
    ).toThrow('suspendOnLlmWait is not yet implemented');
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
