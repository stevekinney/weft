import { describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeConformance } from './index.ts';

describe('executeConformance', () => {
  it('returns exitCode 2 when the worker command is missing', async () => {
    const result = await executeConformance({
      timeoutMs: 500,
      json: false,
      workerCommand: [],
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('worker command is required');
  });

  it('passes a conforming worker fixture', async () => {
    const result = await executeConformance({
      timeoutMs: 3_000,
      json: true,
      workerCommand: ['bun', './src/cli/__fixtures__/conformance-worker.ts'],
    });

    expect(result.exitCode).toBe(0);
    const report: {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean }>;
    } = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.name)).toEqual([
      'register',
      'task completion',
      'heartbeat',
      'cancellation',
      'reconnect',
      'revision echo',
      'graceful shutdown',
    ]);
  });

  it('formats conforming worker checks as plain text', async () => {
    const result = await executeConformance({
      timeoutMs: 3_000,
      json: false,
      workerCommand: ['bun', './src/cli/__fixtures__/conformance-worker.ts'],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PASS register:');
    expect(result.stdout).toContain('PASS graceful shutdown:');
  });

  it('fails a worker fixture that omits protocolVersion', async () => {
    const result = await executeConformance({
      timeoutMs: 500,
      json: true,
      workerCommand: ['bun', './src/cli/__fixtures__/conformance-broken-worker.ts'],
    });

    expect(result.exitCode).toBe(1);
    const report: { ok: boolean; checks: Array<{ ok: boolean }> } = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.checks.some((check) => !check.ok)).toBe(true);
  });

  it('formats failed checks as plain text when json output is disabled', async () => {
    const result = await executeConformance({
      timeoutMs: 500,
      json: false,
      workerCommand: ['bun', './src/cli/__fixtures__/conformance-broken-worker.ts'],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('FAIL conformance:');
  });

  it('fails when the registered worker does not advertise the required activities', async () => {
    const result = await executeConformance({
      timeoutMs: 750,
      json: true,
      workerCommand: ['bun', './src/cli/__fixtures__/conformance-wrong-activities-worker.ts'],
    });

    expect(result.exitCode).toBe(1);
    const report: {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; message: string }>;
    } = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.checks[0]).toEqual({
      name: 'conformance',
      ok: false,
      message: 'Timed out after 750ms waiting for conformance-echo to resolve as completed',
    });
  });

  it('surfaces a worker that disconnects before heartbeat readiness', async () => {
    const result = await executeConformance({
      timeoutMs: 1_000,
      json: true,
      workerCommand: ['bun', './src/cli/__fixtures__/conformance-register-exit-worker.ts'],
    });

    expect(result.exitCode).toBe(1);
    const report: {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; message: string }>;
    } = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.message).toMatch(
      /^Worker register-exit-worker-[0-9a-f-]+ disconnected before heartbeat was observed$/,
    );
  });

  it('surfaces a replacement worker that disconnects before graceful shutdown', async () => {
    const launchStateFile = join(tmpdir(), `weft-short-sleep-exit-${crypto.randomUUID()}.txt`);
    const result = await executeConformance({
      timeoutMs: 1_000,
      json: true,
      workerCommand: [
        'env',
        'WEFT_SHORT_SLEEP_EXIT_MODE=replacement-disconnect',
        `WEFT_SHORT_SLEEP_EXIT_STATE_FILE=${launchStateFile}`,
        'bun',
        './src/cli/__fixtures__/conformance-short-sleep-exit-worker.ts',
      ],
    });
    rmSync(launchStateFile, { force: true });

    expect(result.exitCode).toBe(1);
    const report: {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; message: string }>;
    } = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.message).toContain('to become idle');
  });
});
