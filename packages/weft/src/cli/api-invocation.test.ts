import { describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWeftClient, Engine, serve } from '../index.ts';
import { executeApi, normalizeValidatedInput } from './api.ts';

describe('api command', () => {
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
        server: server.url,
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
      const client = createWeftClient({ server: server.url });
      const result = await client['weft.workflows.list']({});

      expect(result).toMatchObject({ items: [] });
    } finally {
      await server.stop();
      engine[Symbol.dispose]();
    }
  });

  it('reads input from files, rejects missing files, and surfaces operation failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'weft-api-input-'));
    const inputPath = join(directory, 'input.json');
    await Bun.write(inputPath, JSON.stringify({ workflowId: 'missing-workflow' }));

    const engine = new Engine();
    const server = serve({ engine, port: 0 });
    try {
      const failedOperation = await executeApi({
        command: 'api',
        operationName: 'weft.workflows.get',
        server: server.url,
        inputFile: inputPath,
        list: false,
        yes: false,
        help: false,
        json: true,
      });

      expect(failedOperation.exitCode).toBe(1);
      expect(JSON.parse(failedOperation.stdout)).toMatchObject({ ok: false });

      const missingFile = await executeApi({
        command: 'api',
        operationName: 'weft.workflows.get',
        inputFile: join(directory, 'missing.json'),
        list: false,
        yes: false,
        help: false,
        json: false,
      });
      expect(missingFile.exitCode).toBe(3);
      expect(missingFile.stderr).toContain('input file not found');
    } finally {
      await server.stop();
      engine[Symbol.dispose]();
    }
  });

  it('rejects non-object JSON input and connection failures', async () => {
    const arrayInput = await executeApi({
      command: 'api',
      operationName: 'weft.workflows.get',
      input: '[]',
      list: false,
      yes: false,
      help: false,
      json: false,
    });
    expect(arrayInput.exitCode).toBe(3);
    expect(arrayInput.stderr).toContain('expected object, received array');

    const connectionFailure = await executeApi({
      command: 'api',
      operationName: 'weft.workflows.list',
      server: 'http://127.0.0.1:1/',
      input: '{}',
      list: false,
      yes: false,
      help: false,
      json: false,
    });
    expect(connectionFailure.exitCode).toBe(2);
    expect(connectionFailure.stderr).toContain('connection failed');
  });

  it('defaults omitted input to an empty object, rejects malformed JSON, and renders human operation faults', async () => {
    const engine = new Engine();
    const server = serve({ engine, port: 0 });
    try {
      const omittedInput = await executeApi({
        command: 'api',
        operationName: 'weft.workflows.list',
        server: server.url,
        list: false,
        yes: false,
        help: false,
        json: true,
      });
      expect(omittedInput.exitCode).toBe(0);
      expect(JSON.parse(omittedInput.stdout)).toMatchObject({ items: [] });

      const malformedInput = await executeApi({
        command: 'api',
        operationName: 'weft.workflows.list',
        input: '{"limit":',
        list: false,
        yes: false,
        help: false,
        json: false,
      });
      expect(malformedInput.exitCode).toBe(3);
      expect(malformedInput.stderr).toContain('invalid JSON input');

      const humanReadableFailure = await executeApi({
        command: 'api',
        operationName: 'weft.workflows.get',
        server: server.url,
        input: '{"workflowId":"missing-workflow"}',
        list: false,
        yes: false,
        help: false,
        json: false,
      });
      expect(humanReadableFailure.exitCode).toBe(1);
      expect(humanReadableFailure.stdout).toBe('');
      expect(humanReadableFailure.stderr).toContain('api:');
    } finally {
      await server.stop();
      engine[Symbol.dispose]();
    }
  });

  it('rejects validated inputs that are not JSON objects', () => {
    expect(normalizeValidatedInput('weft.workflows.list', null)).toMatchObject({
      ok: false,
      output: { exitCode: 3 },
    });
    expect(normalizeValidatedInput('weft.workflows.list', ['item'])).toMatchObject({
      ok: false,
      output: { exitCode: 3 },
    });
  });
});
