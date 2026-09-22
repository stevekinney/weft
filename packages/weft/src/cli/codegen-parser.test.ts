import { describe, expect, it } from 'bun:test';
import { composeRegistryUrl } from './codegen.ts';
import { CODEGEN_HELP_TEXT } from './help-text.ts';
import { parseCliArguments } from './parse-arguments.ts';

describe('codegen parser', () => {
  it('rejects --server combined with --from', () => {
    expect(() =>
      parseCliArguments(['codegen', '--server', 'http://h', '--from', 'r.json', '--out', 'o.d.ts']),
    ).toThrow(/--server and --from cannot be used together/);
  });

  it('allows omitting --server so connection configuration can resolve it', () => {
    const parsed = parseCliArguments(['codegen', '--out', 'o.d.ts']);
    if (parsed.command !== 'codegen') throw new Error('expected codegen command');
    expect(parsed.server).toBeUndefined();
    expect(parsed.from).toBeUndefined();
    expect(parsed.out).toBe('o.d.ts');
  });

  it('rejects when --out is missing', () => {
    expect(() => parseCliArguments(['codegen', '--from', 'r.json'])).toThrow(/--out is required/);
  });

  it('rejects --token when reading from a file', () => {
    expect(() =>
      parseCliArguments(['codegen', '--from', 'r.json', '--out', 'o.d.ts', '--token', 'abc']),
    ).toThrow(/--token cannot be used with --from/);
  });

  it('short-circuits on --help without requiring other flags', () => {
    const parsed = parseCliArguments(['codegen', '--help']);
    if (parsed.command !== 'codegen') throw new Error('expected codegen command');
    expect(parsed.help).toBe(true);
  });

  it('accepts a positive integer --timeout', () => {
    const parsed = parseCliArguments([
      'codegen',
      '--from',
      'r.json',
      '--out',
      'o.d.ts',
      '--timeout',
      '50',
    ]);
    if (parsed.command !== 'codegen') throw new Error('expected codegen command');
    expect(parsed.timeoutMs).toBe(50);
  });

  it.each([['0'], ['1.5'], ['NaN'], ['nope']])('rejects --timeout %p', (value: string) => {
    expect(() =>
      parseCliArguments(['codegen', '--from', 'r.json', '--out', 'o.d.ts', '--timeout', value]),
    ).toThrow(/--timeout must be a positive integer/);
  });

  it('rejects a negative --timeout (via --timeout=-1 form)', () => {
    expect(() =>
      parseCliArguments(['codegen', '--from', 'r.json', '--out', 'o.d.ts', '--timeout=-1']),
    ).toThrow(/--timeout must be a positive integer/);
  });

  it('defaults --timeout to 30000 when omitted', () => {
    const parsed = parseCliArguments(['codegen', '--from', 'r.json', '--out', 'o.d.ts']);
    if (parsed.command !== 'codegen') throw new Error('expected codegen command');
    expect(parsed.timeoutMs).toBe(30_000);
  });

  it('accepts --json and -j as boolean flags', () => {
    const long = parseCliArguments(['codegen', '--from', 'r.json', '--out', 'o.d.ts', '--json']);
    const short = parseCliArguments(['codegen', '--from', 'r.json', '--out', 'o.d.ts', '-j']);
    if (long.command !== 'codegen' || short.command !== 'codegen') {
      throw new Error('expected codegen command');
    }
    expect(long.json).toBe(true);
    expect(short.json).toBe(true);
  });

  it('defaults --json to false when omitted', () => {
    const parsed = parseCliArguments(['codegen', '--from', 'r.json', '--out', 'o.d.ts']);
    if (parsed.command !== 'codegen') throw new Error('expected codegen command');
    expect(parsed.json).toBe(false);
  });

  it('captures --from, --out, --server, --token in the parsed command', () => {
    const parsed = parseCliArguments([
      'codegen',
      '--server',
      'http://example/base',
      '--out',
      '/tmp/x.d.ts',
      '--token',
      'abc',
    ]);
    if (parsed.command !== 'codegen') throw new Error('expected codegen command');
    expect(parsed.server).toBe('http://example/base');
    expect(parsed.out).toBe('/tmp/x.d.ts');
    expect(parsed.token).toBe('abc');
  });
});

describe('codegen help text', () => {
  it('documents shared connection resolution and from-file token restrictions', () => {
    expect(CODEGEN_HELP_TEXT).toContain('weft codegen --out <file>');
    expect(CODEGEN_HELP_TEXT).toContain('WEFT_ADDR');
    expect(CODEGEN_HELP_TEXT).toContain('WEFT_TOKEN');
    expect(CODEGEN_HELP_TEXT).toContain('~/.weft/config');
    expect(CODEGEN_HELP_TEXT).toContain('Cannot be');
    expect(CODEGEN_HELP_TEXT).toContain('combined with --from');
  });

  it('documents the run lockfile fallback that resolveConnection consults for the CLI', () => {
    // `executeCodegen` calls `resolveConnection` without disabling the lockfile,
    // so the documented resolution order must include it between the profile
    // and the localhost default.
    expect(CODEGEN_HELP_TEXT).toContain('run lockfile');
    expect(CODEGEN_HELP_TEXT).toContain('http://localhost:7233');
  });
});

describe('composeRegistryUrl', () => {
  it('appends /api/v1/registry to a bare origin', () => {
    expect(composeRegistryUrl('http://host').toString()).toBe('http://host/api/v1/registry');
  });

  it('appends /api/v1/registry to a path prefix', () => {
    expect(composeRegistryUrl('http://host/base').toString()).toBe(
      'http://host/base/api/v1/registry',
    );
  });

  it('handles a trailing slash on the base URL', () => {
    expect(composeRegistryUrl('http://host/base/').toString()).toBe(
      'http://host/base/api/v1/registry',
    );
  });

  it('does not double-append when /api/v1/registry is already present', () => {
    expect(composeRegistryUrl('http://host/api/v1/registry').toString()).toBe(
      'http://host/api/v1/registry',
    );
    expect(composeRegistryUrl('http://host/api/v1/registry/').toString()).toBe(
      'http://host/api/v1/registry',
    );
  });
});
