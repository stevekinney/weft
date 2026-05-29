import { describe, expect, it } from 'bun:test';

import { parseCliArguments } from './parse-arguments.ts';

describe('server argument parsing', () => {
  it('parses server health with wait and timeout', () => {
    expect(
      parseCliArguments(['server', 'health', '--wait', '--wait-timeout', '5000', '--json']),
    ).toMatchObject({
      command: 'server',
      action: 'health',
      wait: true,
      waitTimeoutMs: 5000,
      json: true,
    });
  });

  it('parses server info', () => {
    expect(parseCliArguments(['server', 'info'])).toMatchObject({
      command: 'server',
      action: 'info',
      wait: false,
      waitTimeoutMs: 30000,
    });
  });

  it('rejects an unknown server subcommand', () => {
    expect(() => parseCliArguments(['server', 'bogus'])).toThrow(/health or info/);
  });

  it('rejects a non-positive wait timeout', () => {
    expect(() => parseCliArguments(['server', 'health', '--wait-timeout', '0'])).toThrow(
      /positive integer/,
    );
  });
});

describe('workflow argument parsing', () => {
  it('parses workflow ls with filters', () => {
    expect(
      parseCliArguments([
        'workflow',
        'ls',
        '--type',
        'echo',
        '--status',
        'running',
        '--limit',
        '10',
      ]),
    ).toMatchObject({
      command: 'workflow',
      action: 'ls',
      type: 'echo',
      status: 'running',
      limit: 10,
    });
  });

  it('parses workflow get and events with a workflow id', () => {
    expect(parseCliArguments(['workflow', 'get', 'wf-1'])).toMatchObject({
      command: 'workflow',
      action: 'get',
      workflowId: 'wf-1',
    });
    expect(parseCliArguments(['workflow', 'events', 'wf-1'])).toMatchObject({
      command: 'workflow',
      action: 'events',
      workflowId: 'wf-1',
    });
  });

  it('parses workflow start with input and id', () => {
    expect(
      parseCliArguments(['workflow', 'start', 'echo', '--input', '{"x":1}', '--id', 'wf-x']),
    ).toMatchObject({
      command: 'workflow',
      action: 'start',
      workflowType: 'echo',
      input: '{"x":1}',
      id: 'wf-x',
    });
  });

  it('parses workflow cancel with yes and dry-run', () => {
    expect(parseCliArguments(['workflow', 'cancel', 'wf-1', '--yes'])).toMatchObject({
      command: 'workflow',
      action: 'cancel',
      workflowId: 'wf-1',
      yes: true,
      dryRun: false,
    });
    expect(parseCliArguments(['workflow', 'cancel', 'wf-1', '--dry-run'])).toMatchObject({
      action: 'cancel',
      dryRun: true,
    });
  });

  it('parses workflow signal with name and payload', () => {
    expect(
      parseCliArguments(['workflow', 'signal', 'wf-1', 'wake', '--input', '"hi"']),
    ).toMatchObject({
      command: 'workflow',
      action: 'signal',
      workflowId: 'wf-1',
      signalName: 'wake',
      input: '"hi"',
    });
  });

  it('requires a workflow id for get (without --help)', () => {
    expect(() => parseCliArguments(['workflow', 'get'])).toThrow(/missing required argument/);
  });

  it('allows --help without required positionals for subcommands that need them', () => {
    // weft workflow get --help should show help, not throw "missing required argument"
    expect(parseCliArguments(['workflow', 'get', '--help'])).toMatchObject({
      command: 'workflow',
      help: true,
    });
    expect(parseCliArguments(['workflow', 'cancel', '--help'])).toMatchObject({
      command: 'workflow',
      help: true,
    });
  });

  it('rejects ambiguous input sources', () => {
    expect(() =>
      parseCliArguments(['workflow', 'start', 'echo', '--input', '{}', '--input-file', 'in.json']),
    ).toThrow(/--input and --input-file/);
  });

  it('rejects an unknown workflow subcommand', () => {
    expect(() => parseCliArguments(['workflow', 'frobnicate'])).toThrow(/expected a subcommand/);
  });
});

describe('tail argument parsing', () => {
  it('parses tail with a workflow id', () => {
    expect(parseCliArguments(['tail', 'wf-1', '--json'])).toMatchObject({
      command: 'tail',
      workflowId: 'wf-1',
      json: true,
    });
  });

  it('parses a bare tail with no workflow id', () => {
    expect(parseCliArguments(['tail'])).toMatchObject({ command: 'tail', json: false });
    expect(parseCliArguments(['tail'])).not.toHaveProperty('workflowId');
  });
});

describe('completions argument parsing', () => {
  it('parses completions generate and install with a shell', () => {
    expect(parseCliArguments(['completions', 'generate', '--shell', 'zsh'])).toMatchObject({
      command: 'completions',
      action: 'generate',
      shell: 'zsh',
    });
    expect(parseCliArguments(['completions', 'install', '--shell', 'bash'])).toMatchObject({
      command: 'completions',
      action: 'install',
      shell: 'bash',
    });
  });

  it('requires a shell (without --help)', () => {
    expect(() => parseCliArguments(['completions', 'generate'])).toThrow(/--shell is required/);
  });

  it('allows --help without --shell', () => {
    expect(parseCliArguments(['completions', '--help'])).toMatchObject({
      command: 'completions',
      help: true,
    });
    expect(parseCliArguments(['completions', 'generate', '--help'])).toMatchObject({
      command: 'completions',
      action: 'generate',
      help: true,
    });
  });

  it('rejects an unsupported shell', () => {
    expect(() => parseCliArguments(['completions', 'generate', '--shell', 'powershell'])).toThrow(
      /unsupported shell/,
    );
  });

  it('rejects an unknown completions subcommand', () => {
    expect(() => parseCliArguments(['completions', 'bogus', '--shell', 'zsh'])).toThrow(
      /generate or install/,
    );
  });
});
