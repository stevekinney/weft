import { describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveConnection } from '../connection.ts';
import { Engine } from '../core/engine.ts';
import { serve } from '../server/index.ts';
import { executeApi } from './api.ts';
import { createWeftClient } from './generated/operation-client.generated.ts';
import { jsonRpcEndpoint } from './json-rpc-client.ts';
import { parseCliArguments } from './parse-arguments.ts';
import { findCliSubcommandName } from './subcommand-detection.ts';

describe('api argument parser', () => {
  it('parses list, describe, input, and confirmation flags', () => {
    expect(parseCliArguments(['api', '--list', '--json'])).toEqual({
      command: 'api',
      list: true,
      yes: false,
      help: false,
      json: true,
    });

    expect(parseCliArguments(['api', '--describe', 'weft.workflows.list'])).toEqual({
      command: 'api',
      describe: 'weft.workflows.list',
      list: false,
      yes: false,
      help: false,
      json: false,
    });

    expect(parseCliArguments(['--describe', 'weft.workflows.list', 'api'])).toEqual({
      command: 'api',
      describe: 'weft.workflows.list',
      list: false,
      yes: false,
      help: false,
      json: false,
    });
    expect(findCliSubcommandName(['--describe', 'api', 'doctor'])).toBe('doctor');

    expect(
      parseCliArguments([
        'api',
        'weft.workflows.cancel',
        '--input',
        '{"workflowId":"wf"}',
        '--yes',
        '--profile',
        'local',
      ]),
    ).toMatchObject({
      command: 'api',
      operationName: 'weft.workflows.cancel',
      input: '{"workflowId":"wf"}',
      yes: true,
      profile: 'local',
    });
  });

  it('rejects ambiguous input sources', () => {
    expect(() =>
      parseCliArguments(['api', 'weft.workflows.list', '--input', '{}', '--input-file', 'in.json']),
    ).toThrow(/--input and --input-file/);
  });
});

describe('api command', () => {
  it('lists and describes generated catalog operations', async () => {
    const list = await executeApi({
      command: 'api',
      list: true,
      yes: false,
      help: false,
      json: true,
    });
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain('weft.workflows.list');

    const description = await executeApi({
      command: 'api',
      describe: 'weft.workflows.cancel',
      list: false,
      yes: false,
      help: false,
      json: true,
    });
    expect(description.exitCode).toBe(0);
    expect(JSON.parse(description.stdout)).toMatchObject({
      name: 'weft.workflows.cancel',
      destructive: true,
    });

    const readableDescription = await executeApi({
      command: 'api',
      describe: 'weft.workflows.cancel',
      list: false,
      yes: false,
      help: false,
      json: false,
    });
    expect(readableDescription.exitCode).toBe(0);
    expect(readableDescription.stdout).toContain('Name: weft.workflows.cancel');
    expect(readableDescription.stdout).toContain('Safety: destructive');
    expect(() => JSON.parse(readableDescription.stdout)).toThrow();
  });

  it('shows the longer-form description for an operation that declares one', async () => {
    // weft.workflows.cancel is in the interactive subset and declares a
    // multi-sentence description that is longer than its short summary.
    const result = await executeApi({
      command: 'api',
      describe: 'weft.workflows.cancel',
      list: false,
      yes: false,
      help: false,
      json: false,
    });
    expect(result.exitCode).toBe(0);

    const summaryLine = result.stdout.split('\n').find((line) => line.startsWith('Summary: '));
    const descriptionLine = result.stdout
      .split('\n')
      .find((line) => line.startsWith('Description: '));
    expect(summaryLine).toBeDefined();
    expect(descriptionLine).toBeDefined();
    // The description line carries the longer-form prose, distinct from and
    // longer than the short summary line.
    expect(descriptionLine).not.toBe(summaryLine?.replace('Summary:', 'Description:'));
    expect((descriptionLine ?? '').length).toBeGreaterThan((summaryLine ?? '').length);
  });

  it('falls back to the summary when an operation declares no description', async () => {
    // weft.storage.get is not in the interactive subset and declares no
    // description, so --describe must echo the summary on the Description line.
    const result = await executeApi({
      command: 'api',
      describe: 'weft.storage.get',
      list: false,
      yes: false,
      help: false,
      json: false,
    });
    expect(result.exitCode).toBe(0);

    const lines = result.stdout.split('\n');
    const summaryLine = lines.find((line) => line.startsWith('Summary: '));
    const descriptionLine = lines.find((line) => line.startsWith('Description: '));
    expect(summaryLine).toBeDefined();
    expect(descriptionLine).toBeDefined();
    const summaryText = (summaryLine ?? '').slice('Summary: '.length);
    const descriptionText = (descriptionLine ?? '').slice('Description: '.length);
    expect(descriptionText).toBe(summaryText);
  });

  it('blocks destructive operations unless --yes is present', async () => {
    const result = await executeApi({
      command: 'api',
      operationName: 'weft.workflows.cancel',
      input: '{"workflowId":"wf"}',
      list: false,
      yes: false,
      help: false,
      json: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('destructive');
  });

  it('validates input locally before sending a request', async () => {
    const result = await executeApi({
      command: 'api',
      operationName: 'weft.workflows.list',
      input: '{"limit":0}',
      list: false,
      yes: false,
      help: false,
      json: false,
    });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('input validation failed');
  });

  it('suggests nearby operation names for unknown operations', async () => {
    const result = await executeApi({
      command: 'api',
      operationName: 'weft.workflow.list',
      input: '{}',
      list: false,
      yes: false,
      help: false,
      json: false,
    });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('weft.workflows.list');
    expect(result.stderr).toContain('--list');
  });

  it('rejects unary operations that are unavailable over JSON-RPC HTTP', async () => {
    const result = await executeApi({
      command: 'api',
      operationName: 'weft.storage.get',
      input: '{"key":"item"}',
      list: false,
      yes: false,
      help: false,
      json: false,
    });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('not available over JSON-RPC HTTP');
  });

  it('invokes a unary catalog operation against a live server', async () => {
    const engine = new Engine();
    const server = serve({ engine, port: 0 });
    try {
      const result = await executeApi({
        command: 'api',
        operationName: 'weft.workflows.list',
        server: server.url.toString(),
        input: '{}',
        list: false,
        yes: false,
        help: false,
        json: true,
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ items: [] });
    } finally {
      await server.stop();
      engine[Symbol.dispose]();
    }
  });

  it('invokes a unary catalog operation through the generated typed client', async () => {
    const engine = new Engine();
    const server = serve({ engine, port: 0 });
    try {
      const client = createWeftClient({ server: server.url.toString() });
      const result = await client['weft.workflows.list']({});

      expect(result).toMatchObject({ items: [] });
    } finally {
      await server.stop();
      engine[Symbol.dispose]();
    }
  });
});

describe('api connection resolution', () => {
  it('uses a named profile with env token indirection', async () => {
    const priorHome = Bun.env['WEFT_HOME'];
    const priorToken = Bun.env['PROFILE_TOKEN'];
    const home = await mkdtemp(join(tmpdir(), 'weft-home-'));
    Bun.env['WEFT_HOME'] = home;
    Bun.env['PROFILE_TOKEN'] = 'profile-secret';
    await Bun.write(
      join(home, 'config'),
      [
        'default_profile = "local"',
        '',
        '[profiles.local]',
        'server = "http://profile.example:9000"',
        'token = "env:PROFILE_TOKEN"',
      ].join('\n'),
    );

    try {
      const connection = resolveConnection({});
      expect(connection.server.toString()).toBe('http://profile.example:9000/');
      expect(connection.token).toBe('profile-secret');
    } finally {
      if (priorHome === undefined) delete Bun.env['WEFT_HOME'];
      else Bun.env['WEFT_HOME'] = priorHome;
      if (priorToken === undefined) delete Bun.env['PROFILE_TOKEN'];
      else Bun.env['PROFILE_TOKEN'] = priorToken;
    }
  });

  it('falls back to the local run lockfile before localhost', async () => {
    const priorHome = Bun.env['WEFT_HOME'];
    const priorAddress = Bun.env['WEFT_ADDR'];
    const home = await mkdtemp(join(tmpdir(), 'weft-home-'));
    Bun.env['WEFT_HOME'] = home;
    delete Bun.env['WEFT_ADDR'];
    await Bun.write(join(home, 'run'), `${JSON.stringify({ server: 'http://127.0.0.1:4321' })}\n`);

    try {
      const connection = resolveConnection({});
      expect(connection.server.toString()).toBe('http://127.0.0.1:4321/');
    } finally {
      if (priorHome === undefined) delete Bun.env['WEFT_HOME'];
      else Bun.env['WEFT_HOME'] = priorHome;
      if (priorAddress === undefined) delete Bun.env['WEFT_ADDR'];
      else Bun.env['WEFT_ADDR'] = priorAddress;
    }
  });

  it('ignores a malformed local run lockfile', async () => {
    const priorHome = Bun.env['WEFT_HOME'];
    const priorAddress = Bun.env['WEFT_ADDR'];
    const home = await mkdtemp(join(tmpdir(), 'weft-home-'));
    Bun.env['WEFT_HOME'] = home;
    delete Bun.env['WEFT_ADDR'];
    await Bun.write(join(home, 'run'), '{');

    try {
      const connection = resolveConnection({});
      expect(connection.server.toString()).toBe('http://localhost:7233/');
    } finally {
      if (priorHome === undefined) delete Bun.env['WEFT_HOME'];
      else Bun.env['WEFT_HOME'] = priorHome;
      if (priorAddress === undefined) delete Bun.env['WEFT_ADDR'];
      else Bun.env['WEFT_ADDR'] = priorAddress;
    }
  });

  it('preserves configured base paths when building the JSON-RPC endpoint', () => {
    expect(jsonRpcEndpoint(new URL('http://localhost:7233/base')).toString()).toBe(
      'http://localhost:7233/base/jsonrpc',
    );
  });
});
