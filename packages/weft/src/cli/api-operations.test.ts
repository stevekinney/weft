import { describe, expect, it } from 'bun:test';
import { createCatalogSnapshot } from '../index.ts';

import { executeApi } from './api.ts';

describe('api command', () => {
  it('describes each operation using the current source contract', async () => {
    for (const operation of createCatalogSnapshot().operations) {
      const description = await executeApi({
        command: 'api',
        describe: operation.name,
        list: false,
        yes: false,
        help: false,
        json: true,
      });
      expect(description.exitCode, operation.name).toBe(0);
      expect(JSON.parse(description.stdout), operation.name).toEqual(operation);
    }
  });

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

    const humanList = await executeApi({
      command: 'api',
      list: true,
      yes: false,
      help: false,
      json: false,
    });
    expect(humanList.exitCode).toBe(0);
    expect(humanList.stdout).toContain('name');
    expect(humanList.stdout).toContain('json-rpc-http');
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

  it('reports local usage errors before attempting a request', async () => {
    const missingSelector = await executeApi({
      command: 'api',
      list: false,
      yes: false,
      help: false,
      json: false,
    });
    expect(missingSelector.exitCode).toBe(3);
    expect(missingSelector.stderr).toContain('expected --list');

    const streamingOperation = await executeApi({
      command: 'api',
      operationName: 'weft.workflows.events',
      input: '{}',
      list: false,
      yes: false,
      help: false,
      json: false,
    });
    expect(streamingOperation.exitCode).toBe(3);
    expect(streamingOperation.stderr).toContain('supports unary operations only');
  });
});
