/**
 * `createConformanceTargetRunner` — target validation, lookup safety, and
 * in-flight run sharing (COR-1365). These tests never spawn a worker: the
 * injected `serve` throws, so `runConformanceReport` resolves immediately
 * with its single failed `conformance` check.
 *
 * That throwing `serve` is also the regression test for a sandbox leak: the
 * run used to construct its `Engine` before calling `serve()` and dispose it
 * only in a `finally` entered after `serve()` returned, so a `serve()` that
 * threw left the engine's interval timers running. The suite's real-timer
 * leak guard fails these tests if that disposal goes missing again.
 */

import { describe, expect, it } from 'bun:test';

import type { WeftServer } from '../server/index.ts';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../worker/protocol-version.ts';
import { createConformanceTargetRunner, DEFAULT_CONFORMANCE_TARGET_TIMEOUT_MS } from './targets.ts';

function failingServe(): WeftServer {
  throw new Error('sandbox unavailable');
}

describe('createConformanceTargetRunner — validation', () => {
  // spawn-free: the injected serve throws, so no run ever spawns a worker.
  it('lists target names and resolved timeouts, never commands', () => {
    const runner = createConformanceTargetRunner(
      {
        reference: { command: ['bun', './worker.ts', '--secret-flag'] },
        slow: { command: ['./worker'], timeoutMs: 60_000 },
      },
      failingServe,
    );

    expect(runner.list()).toEqual([
      { name: 'reference', timeoutMs: DEFAULT_CONFORMANCE_TARGET_TIMEOUT_MS },
      { name: 'slow', timeoutMs: 60_000 },
    ]);
    expect(JSON.stringify(runner.list())).not.toContain('secret-flag');
  });

  // spawn-free: the injected serve throws, so no run ever spawns a worker.
  it('rejects an empty command, an empty argument, a bad timeout, and an unroutable name', () => {
    expect(() => createConformanceTargetRunner({ a: { command: [] } }, failingServe)).toThrow(
      'conformanceTargets.a.command must be a non-empty array of non-empty strings',
    );
    expect(() =>
      createConformanceTargetRunner({ a: { command: ['bun', ''] } }, failingServe),
    ).toThrow('conformanceTargets.a.command');
    expect(() =>
      createConformanceTargetRunner({ a: { command: ['bun'], timeoutMs: 0 } }, failingServe),
    ).toThrow('conformanceTargets.a.timeoutMs must be a positive integer');
    expect(() =>
      createConformanceTargetRunner({ 'a/b': { command: ['bun'] } }, failingServe),
    ).toThrow('target name "a/b"');
  });
});

describe('createConformanceTargetRunner — run', () => {
  // spawn-free: the injected serve throws, so no run ever spawns a worker.
  it('returns undefined for an unknown name, including inherited Object.prototype keys', () => {
    const runner = createConformanceTargetRunner({ reference: { command: ['bun'] } }, failingServe);

    expect(runner.run('missing')).toBeUndefined();
    expect(runner.run('constructor')).toBeUndefined();
    expect(runner.run('__proto__')).toBeUndefined();
    expect(runner.run('toString')).toBeUndefined();
  });

  // spawn-free: the injected serve throws, so no run ever spawns a worker.
  it('stamps the shared report with the target name and run timestamps', async () => {
    let now = 100;
    const runner = createConformanceTargetRunner(
      { reference: { command: ['bun'] } },
      failingServe,
      () => (now += 5),
    );

    const report = await runner.run('reference');

    expect(report).toEqual({
      target: 'reference',
      startedAt: 105,
      completedAt: 110,
      ok: false,
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      supportedProtocolVersions: [REMOTE_WORKER_PROTOCOL_VERSION],
      checks: [{ name: 'conformance', ok: false, message: 'sandbox unavailable' }],
    });
  });

  // spawn-free: the injected serve throws, so no run ever spawns a worker.
  it('shares one in-flight run between concurrent callers and starts a fresh run afterwards', async () => {
    let serveCalls = 0;
    const runner = createConformanceTargetRunner({ reference: { command: ['bun'] } }, () => {
      serveCalls += 1;
      throw new Error('stop');
    });

    const first = runner.run('reference');
    const second = runner.run('reference');
    expect(second).toBe(first);
    await first;
    expect(serveCalls).toBe(1);

    await runner.run('reference');
    expect(serveCalls).toBe(2);
  });
});
