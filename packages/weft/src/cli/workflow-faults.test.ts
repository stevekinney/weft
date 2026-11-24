/**
 * A failed `weft workflow` or `weft schedule` command reports the structured fault the server (or
 * the CLI) found: `{ ok: false, error: { code, message, retryable, remediation? } }` under
 * `--json`, and the message with a `Try:` line otherwise, with the exit codes unchanged.
 */

import { describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Engine, serve } from '../index.ts';
import { executeSchedule } from './schedule.ts';
import type { ScheduleCommand, WorkflowCommand } from './types.ts';
import { executeWorkflow } from './workflow-commands.ts';

const GOLDEN_PATH = join(import.meta.dir, '__fixtures__', 'workflow-get-not-found.golden.json');

const base = { command: 'workflow' as const, help: false, json: true, quiet: false };

async function withServer<Result>(run: (url: string) => Promise<Result>): Promise<Result> {
  const engine = new Engine();
  const server = serve({ engine, port: 0 });
  try {
    return await run(server.url);
  } finally {
    await server.stop();
    engine[Symbol.dispose]();
  }
}

describe('weft workflow failures', () => {
  it('pins the JSON error of `workflow get` for a workflow the server does not have', async () => {
    const result = await withServer((url) =>
      executeWorkflow({
        ...base,
        action: 'get',
        server: url,
        workflowId: 'missing-workflow',
      } satisfies WorkflowCommand),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBeUndefined();
    expect(`${result.stdout}\n`).toBe(await Bun.file(GOLDEN_PATH).text());
  });

  it('prints the message and a Try line without --json, and keeps the exit code', async () => {
    const result = await executeWorkflow({
      ...base,
      json: false,
      action: 'get',
      server: 'http://127.0.0.1:1/',
      workflowId: 'unreachable',
    } satisfies WorkflowCommand);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    const [message, tryLine, ...rest] = (result.stderr ?? '').split('\n');
    expect(message).toStartWith('connection failed: ');
    expect(tryLine).toStartWith('Try: Start a server with');
    expect(rest).toEqual([]);
  });

  it('prints no Try line when the fault has no remediation', async () => {
    const result = await withServer((url) =>
      executeWorkflow({
        ...base,
        json: false,
        action: 'get',
        server: url,
        workflowId: 'missing-workflow',
      } satisfies WorkflowCommand),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('Workflow "missing-workflow" not found');
  });

  it('reports a connection failure as Unavailable, retryable, with a remediation', async () => {
    const result = await executeWorkflow({
      ...base,
      action: 'ls',
      server: 'http://127.0.0.1:1/',
    } satisfies WorkflowCommand);

    expect(result.exitCode).toBe(2);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({
      ok: false,
      error: { code: 'Unavailable', retryable: true },
    });
    expect(typeof body.error.remediation).toBe('string');
  });

  it('does not tell a caller to retry a refused credential, or an unusable server URL', async () => {
    const engine = new Engine();
    const key = 'weft_key_valid123456789012345678901';
    const server = serve({
      engine,
      port: 0,
      auth: { apiKeys: [key], defaultApiKeyScopes: ['workflows:read'] },
    });
    try {
      for (const token of [undefined, 'weft_key_wrong1234567890123456789012']) {
        const result = await executeWorkflow({
          ...base,
          action: 'get',
          server: server.url,
          ...(token === undefined ? {} : { token }),
          workflowId: 'wf',
        } satisfies WorkflowCommand);
        expect(result.exitCode).toBe(2);
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: {
            code: 'Unauthorized',
            message: 'connection failed: the server refused the credentials (HTTP 401)',
            retryable: false,
            remediation: 'Pass a valid token with --token, WEFT_TOKEN or --profile',
          },
        });
      }
    } finally {
      await server.stop();
      engine[Symbol.dispose]();
    }

    const unusable = await executeWorkflow({
      ...base,
      action: 'get',
      server: 'not-a-url',
      workflowId: 'wf',
    } satisfies WorkflowCommand);
    expect(unusable.exitCode).toBe(2);
    expect(JSON.parse(unusable.stdout)).toMatchObject({
      ok: false,
      error: { code: 'InvalidParams', retryable: false },
    });
  });

  it('reports an unreadable --input as InvalidParams with exit code 3, for start and signal', async () => {
    for (const command of [
      { ...base, action: 'start', workflowType: 'echo', input: '{nope' },
      { ...base, action: 'signal', workflowId: 'wf', signalName: 'go', input: '{nope' },
    ] satisfies WorkflowCommand[]) {
      const result = await executeWorkflow(command);
      expect(result.exitCode).toBe(3);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: 'InvalidParams', retryable: false },
      });
    }
  });

  it('reports a refused cancel as a fault with the --yes remediation', async () => {
    const priorIsTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      const result = await executeWorkflow({
        ...base,
        action: 'cancel',
        workflowId: 'wf',
        yes: false,
        dryRun: false,
      } satisfies WorkflowCommand);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: 'InvalidParams',
          message: 'workflow cancel: refusing to cancel wf without confirmation',
          remediation: 'Pass --yes to proceed in a non-interactive shell',
        },
      });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: priorIsTty, configurable: true });
    }
  });

  it('reports the not-found dry run under --json with exit code 5', async () => {
    const result = await withServer((url) =>
      executeWorkflow({
        ...base,
        action: 'cancel',
        server: url,
        workflowId: 'missing-workflow',
        yes: false,
        dryRun: true,
      } satisfies WorkflowCommand),
    );

    expect(result.exitCode).toBe(5);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'NotFound' } });
  });
});

describe('weft schedule failures', () => {
  const schedule = {
    command: 'schedule' as const,
    database: ':memory:',
    storage: 'sqlite' as const,
    help: false,
  };

  it('reports a usage error as InvalidParams under --json, and as text otherwise', async () => {
    const pause = { ...schedule, action: 'pause' as const, scheduleId: '' };

    const json = await executeSchedule({ ...pause, json: true } satisfies ScheduleCommand);
    expect(json.exitCode).toBe(1);
    expect(json.stderr).toBeUndefined();
    expect(JSON.parse(json.stdout)).toEqual({
      ok: false,
      error: {
        code: 'InvalidParams',
        message: 'scheduleId is required for schedule pause',
        retryable: false,
      },
    });

    const text = await executeSchedule({ ...pause, json: false } satisfies ScheduleCommand);
    expect(text).toEqual({
      stdout: '',
      stderr: 'Error: scheduleId is required for schedule pause',
      exitCode: 1,
    });
  });

  it('reports a schedule that does not exist as NotFound, not as an engine failure', async () => {
    const database = join(tmpdir(), `weft-schedule-missing-${crypto.randomUUID()}.db`);
    try {
      const result = await executeSchedule({
        ...schedule,
        database,
        action: 'pause',
        scheduleId: 'no-such-schedule',
        json: true,
      } satisfies ScheduleCommand);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        error: {
          code: 'NotFound',
          message: 'Schedule "no-such-schedule" not found',
          retryable: false,
        },
      });
    } finally {
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true });
    }
  });

  it('reports a cadence the engine refuses as InvalidParams', async () => {
    const database = join(tmpdir(), `weft-schedule-cadence-${crypto.randomUUID()}.db`);
    try {
      const result = await executeSchedule({
        ...schedule,
        database,
        action: 'create',
        workflows: new URL('./__fixtures__/validation/hello-world/src/index.ts', import.meta.url)
          .pathname,
        workflowType: 'helloWorld',
        cronExpression: 'not a cron',
        input: 'null',
        backfill: false,
        json: true,
      } satisfies ScheduleCommand);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: 'InvalidParams', retryable: false },
      });
    } finally {
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true });
    }
  });

  it('classifies an engine error by its class, keeping the engine message', async () => {
    const database = join(tmpdir(), `weft-schedule-faults-${crypto.randomUUID()}.db`);
    try {
      const result = await executeSchedule({
        ...schedule,
        database,
        action: 'create' as const,
        workflows: new URL('./__fixtures__/validation/hello-world/src/index.ts', import.meta.url)
          .pathname,
        workflowType: 'notRegisteredAnywhere',
        cronExpression: '* * * * *',
        input: 'null',
        backfill: false,
        json: true,
      } satisfies ScheduleCommand);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        error: {
          code: 'InvalidParams',
          message: 'No workflow registered with name "notRegisteredAnywhere"',
          retryable: false,
        },
      });
    } finally {
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true });
    }
  });
});
