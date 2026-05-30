import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { composeRegistryUrl, executeCodegen } from './codegen.ts';
import { CODEGEN_HELP_TEXT } from './help-text.ts';
import { parseCliArguments } from './parse-arguments.ts';

const FIXTURE_DIR = resolve(import.meta.dir, '__fixtures__/codegen');
const REGISTRY_FIXTURE = join(FIXTURE_DIR, 'registry.json');
const EXPECTED_DTS = join(FIXTURE_DIR, 'expected.d.ts');
const TYPECHECK_FIXTURE_DIR = join(FIXTURE_DIR, 'typecheck');

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-codegen-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

describe('executeCodegen end-to-end', () => {
  it('emits the expected .d.ts from the registry fixture', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    const result = await executeCodegen({ from: REGISTRY_FIXTURE, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('codegen: wrote');
    const written = await Bun.file(out).text();
    const expected = await Bun.file(EXPECTED_DTS).text();
    expect(written).toBe(expected);
  });

  it('reports "up to date" on the second run and does not rewrite content', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    await executeCodegen({ from: REGISTRY_FIXTURE, out, timeoutMs: 30_000 });
    const first = await Bun.file(out).text();

    const second = await executeCodegen({ from: REGISTRY_FIXTURE, out, timeoutMs: 30_000 });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('is up to date');
    const after = await Bun.file(out).text();
    expect(after).toBe(first);
  });

  it('fails with a clear diagnostic on registry version mismatch and writes no output', async () => {
    const dir = makeTempDir();
    const bad = join(dir, 'bad.json');
    const out = join(dir, 'weft.d.ts');
    const raw = await Bun.file(REGISTRY_FIXTURE).text();
    writeFileSync(bad, raw.replace('"registryVersion": 1', '"registryVersion": 2'));
    const result = await executeCodegen({ from: bad, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('registryVersion 2');
    expect(existsSync(out)).toBe(false);
  });

  it('fails when --from points at a missing file', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    const missing = join(dir, 'no-such-file.json');
    const result = await executeCodegen({ from: missing, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--from file not found');
    expect(existsSync(out)).toBe(false);
  });

  it('fails on malformed JSON without writing partial output', async () => {
    const dir = makeTempDir();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not valid json');
    const out = join(dir, 'weft.d.ts');
    const result = await executeCodegen({ from: bad, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('failed to parse JSON');
    expect(existsSync(out)).toBe(false);
  });

  it('fails when the parent directory does not exist', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'no-such-subdir', 'weft.d.ts');
    const result = await executeCodegen({ from: REGISTRY_FIXTURE, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('does not exist');
    expect(existsSync(out)).toBe(false);
  });

  it('fails when the output directory is not writable', async () => {
    const dir = makeTempDir();
    chmodSync(dir, 0o555);
    const out = join(dir, 'weft.d.ts');
    try {
      const result = await executeCodegen({ from: REGISTRY_FIXTURE, out, timeoutMs: 30_000 });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/failed to write|EACCES|permission/i);
      expect(existsSync(out)).toBe(false);
    } finally {
      // Restore so afterEach can clean up.
      chmodSync(dir, 0o755);
    }
  });

  it('fails on Zod validation errors (valid version, missing required field)', async () => {
    const dir = makeTempDir();
    const bad = join(dir, 'bad.json');
    const out = join(dir, 'weft.d.ts');
    writeFileSync(
      bad,
      JSON.stringify({
        registryVersion: 1,
        workflows: {},
        // Activity missing the required `queue` field.
        activities: { broken: { outputSchema: { type: 'string' } } },
      }),
    );
    const result = await executeCodegen({ from: bad, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid registry snapshot');
    expect(existsSync(out)).toBe(false);
  });

  it('catches CodegenEmitError from a pathologically deep schema', async () => {
    const dir = makeTempDir();
    const bad = join(dir, 'deep.json');
    const out = join(dir, 'weft.d.ts');
    // Build a 200-deep nested object schema. The emitter caps recursion
    // at 64 and throws CodegenEmitError, which `executeCodegen` must
    // translate to exitCode 1 — never reject.
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 200; i++) {
      deep = {
        type: 'object',
        properties: { nested: deep },
        required: ['nested'],
        additionalProperties: false,
      };
    }
    writeFileSync(
      bad,
      JSON.stringify({
        registryVersion: 1,
        workflows: { tooDeep: { inputSchema: deep } },
        activities: {},
      }),
    );
    const result = await executeCodegen({ from: bad, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/nesting|recursion|levels of/i);
    expect(existsSync(out)).toBe(false);
  });

  it('accepts boolean root schemas (true/false) and emits valid TypeScript', async () => {
    // JSON Schema permits a boolean at any schema position. Vendored
    // snapshots may use this form; the validator should accept it and
    // the emitter should produce a usable `.d.ts`.
    const dir = makeTempDir();
    const bool = join(dir, 'bool.json');
    const out = join(dir, 'weft.d.ts');
    writeFileSync(
      bool,
      JSON.stringify({
        registryVersion: 1,
        workflows: { permissive: { inputSchema: true, outputSchema: false } },
        activities: { wild: { queue: 'q', inputSchema: true, outputSchema: true } },
      }),
    );
    const result = await executeCodegen({ from: bool, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(0);
    const written = await Bun.file(out).text();
    // Boolean roots normalize to `{}` in projection, which the
    // emitter resolves to `unknown`. The output should at least
    // compile (we don't pin the exact type because the normalization
    // is documented as a coarsening). Activity names are no longer
    // emitted globally — they live on per-workflow builders.
    expect(written).toContain('"permissive"');
    expect(written).not.toContain('"wild"');
  });

  it('rejects passing both --server and --from to executeCodegen directly', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    const result = await executeCodegen({
      server: 'http://example.invalid',
      from: REGISTRY_FIXTURE,
      out,
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--server and --from cannot be used together');
    expect(existsSync(out)).toBe(false);
  });

  it('emits a single JSON object on stdout with --json on success', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    const first = await executeCodegen({
      from: REGISTRY_FIXTURE,
      out,
      timeoutMs: 30_000,
      json: true,
    });
    expect(first.exitCode).toBe(0);
    const parsed = JSON.parse(first.stdout) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(parsed['action']).toBe('wrote');
    expect(parsed['out']).toBe(out);
    expect(parsed['workflows']).toBeGreaterThan(0);
    expect(parsed['activities']).toBeGreaterThan(0);

    const second = await executeCodegen({
      from: REGISTRY_FIXTURE,
      out,
      timeoutMs: 30_000,
      json: true,
    });
    expect(second.exitCode).toBe(0);
    const repeat = JSON.parse(second.stdout) as Record<string, unknown>;
    expect(repeat['ok']).toBe(true);
    expect(repeat['action']).toBe('unchanged');
    expect(repeat['out']).toBe(out);
    // Counts are included in both `wrote` and `unchanged` payloads so
    // machine consumers see a stable shape.
    expect(repeat['workflows']).toBeGreaterThan(0);
    expect(repeat['activities']).toBeGreaterThan(0);
  });

  it('emits {ok:false,error} on stderr with --json on failure', async () => {
    const dir = makeTempDir();
    const result = await executeCodegen({
      from: join(dir, 'no-such-file.json'),
      out: join(dir, 'weft.d.ts'),
      timeoutMs: 30_000,
      json: true,
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr ?? '') as Record<string, unknown>;
    expect(parsed['ok']).toBe(false);
    expect(parsed['error']).toContain('--from file not found');
  });
});

type FetchHandler = (request: Request) => Response | Promise<Response>;

function serveOnce(handler: FetchHandler) {
  return Bun.serve({ port: 0, fetch: handler });
}

describe('executeCodegen HTTP fetch path', () => {
  it('sends Authorization: Bearer when --token is provided', async () => {
    let observedAuth: string | null | undefined;
    const server = serveOnce((request) => {
      observedAuth = request.headers.get('authorization');
      return new Response(Bun.file(REGISTRY_FIXTURE), {
        headers: { 'content-type': 'application/json' },
      });
    });
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      const result = await executeCodegen({
        server: server.url.toString(),
        token: 'sekret',
        out,
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(0);
      expect(observedAuth).toBe('Bearer sekret');
    } finally {
      await server.stop(true);
    }
  });

  it('uses WEFT_TOKEN when --token is not provided', async () => {
    let observedAuth: string | null | undefined;
    const server = serveOnce((request) => {
      observedAuth = request.headers.get('authorization');
      return new Response(Bun.file(REGISTRY_FIXTURE), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const prior = Bun.env['WEFT_TOKEN'];
    Bun.env['WEFT_TOKEN'] = 'env-token';
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      const result = await executeCodegen({
        server: server.url.toString(),
        out,
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(0);
      expect(observedAuth).toBe('Bearer env-token');
    } finally {
      if (prior === undefined) delete Bun.env['WEFT_TOKEN'];
      else Bun.env['WEFT_TOKEN'] = prior;
      await server.stop(true);
    }
  });

  it('--token overrides WEFT_TOKEN', async () => {
    let observedAuth: string | null | undefined;
    const server = serveOnce((request) => {
      observedAuth = request.headers.get('authorization');
      return new Response(Bun.file(REGISTRY_FIXTURE), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const prior = Bun.env['WEFT_TOKEN'];
    Bun.env['WEFT_TOKEN'] = 'env-token';
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      await executeCodegen({
        server: server.url.toString(),
        token: 'flag-token',
        out,
        timeoutMs: 30_000,
      });
      expect(observedAuth).toBe('Bearer flag-token');
    } finally {
      if (prior === undefined) delete Bun.env['WEFT_TOKEN'];
      else Bun.env['WEFT_TOKEN'] = prior;
      await server.stop(true);
    }
  });

  it('uses WEFT_ADDR and WEFT_TOKEN through the shared connection resolver', async () => {
    let observedAuth: string | null | undefined;
    let observedUrl: string | undefined;
    const server = serveOnce((request) => {
      observedAuth = request.headers.get('authorization');
      observedUrl = request.url;
      return new Response(Bun.file(REGISTRY_FIXTURE), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const priorAddress = Bun.env['WEFT_ADDR'];
    const priorToken = Bun.env['WEFT_TOKEN'];
    Bun.env['WEFT_ADDR'] = server.url.toString();
    Bun.env['WEFT_TOKEN'] = 'environment-token';
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      const result = await executeCodegen({ out, timeoutMs: 30_000 });
      expect(result.exitCode).toBe(0);
      expect(observedAuth).toBe('Bearer environment-token');
      expect(observedUrl).toBe(new URL('/api/v1/registry', server.url).toString());
    } finally {
      if (priorAddress === undefined) delete Bun.env['WEFT_ADDR'];
      else Bun.env['WEFT_ADDR'] = priorAddress;
      if (priorToken === undefined) delete Bun.env['WEFT_TOKEN'];
      else Bun.env['WEFT_TOKEN'] = priorToken;
      await server.stop(true);
    }
  });

  it('reports malformed connection configuration as a user diagnostic', async () => {
    const home = makeTempDir();
    writeFileSync(join(home, 'config'), 'server = "missing-closing-quote');
    const out = join(home, 'weft.d.ts');
    const priorHome = Bun.env['WEFT_HOME'];
    const priorAddress = Bun.env['WEFT_ADDR'];
    Bun.env['WEFT_HOME'] = home;
    delete Bun.env['WEFT_ADDR'];

    try {
      const result = await executeCodegen({ out, timeoutMs: 30_000 });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('codegen: Failed to read connection configuration');
      expect(existsSync(out)).toBe(false);
    } finally {
      if (priorHome === undefined) delete Bun.env['WEFT_HOME'];
      else Bun.env['WEFT_HOME'] = priorHome;
      if (priorAddress === undefined) delete Bun.env['WEFT_ADDR'];
      else Bun.env['WEFT_ADDR'] = priorAddress;
    }
  });

  it('reports a malformed --server as a CommandOutput, not a thrown TypeError', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    const priorAddress = Bun.env['WEFT_ADDR'];
    delete Bun.env['WEFT_ADDR'];
    try {
      // `resolveConnection` constructs `new URL(server)`, which throws a
      // `TypeError` for a malformed value. `executeCodegen` must translate that
      // into a clean diagnostic rather than rejecting.
      const result = await executeCodegen({
        server: 'not a url',
        out,
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('codegen: invalid server URL');
      expect(result.stderr).toContain('not a url');
      expect(existsSync(out)).toBe(false);
    } finally {
      if (priorAddress === undefined) delete Bun.env['WEFT_ADDR'];
      else Bun.env['WEFT_ADDR'] = priorAddress;
    }
  });

  it('reports a malformed WEFT_ADDR as a CommandOutput diagnostic', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    const priorAddress = Bun.env['WEFT_ADDR'];
    Bun.env['WEFT_ADDR'] = ':::not-a-url:::';
    try {
      const result = await executeCodegen({ out, timeoutMs: 30_000 });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('codegen: invalid server URL');
      expect(existsSync(out)).toBe(false);
    } finally {
      if (priorAddress === undefined) delete Bun.env['WEFT_ADDR'];
      else Bun.env['WEFT_ADDR'] = priorAddress;
    }
  });

  it('reports 401 responses with status and URL', async () => {
    const server = serveOnce(
      () => new Response('nope', { status: 401, statusText: 'Unauthorized' }),
    );
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      const result = await executeCodegen({
        server: server.url.toString(),
        out,
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('401');
      expect(result.stderr).toContain(server.url.toString());
      expect(existsSync(out)).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  it('reports 500 responses with status and URL', async () => {
    const server = serveOnce(
      () => new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    );
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      const result = await executeCodegen({
        server: server.url.toString(),
        out,
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('500');
    } finally {
      await server.stop(true);
    }
  });

  it('reports a content-type mismatch when the server returns HTML', async () => {
    const server = serveOnce(
      () => new Response('<html>not json</html>', { headers: { 'content-type': 'text/html' } }),
    );
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      const result = await executeCodegen({
        server: server.url.toString(),
        out,
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('content-type');
    } finally {
      await server.stop(true);
    }
  });

  it('reports a parse error when the body claims JSON but is malformed', async () => {
    const server = serveOnce(
      () => new Response('not actually json', { headers: { 'content-type': 'application/json' } }),
    );
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      const result = await executeCodegen({
        server: server.url.toString(),
        out,
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('failed to parse response body');
      expect(existsSync(out)).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  it('sends no Authorization header when neither --token nor WEFT_TOKEN is set', async () => {
    let observedAuth: string | null | undefined;
    const server = serveOnce((request) => {
      observedAuth = request.headers.get('authorization');
      return new Response(Bun.file(REGISTRY_FIXTURE), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const prior = Bun.env['WEFT_TOKEN'];
    delete Bun.env['WEFT_TOKEN'];
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      const result = await executeCodegen({
        server: server.url.toString(),
        out,
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(0);
      expect(observedAuth).toBeNull();
    } finally {
      if (prior !== undefined) Bun.env['WEFT_TOKEN'] = prior;
      await server.stop(true);
    }
  });

  it('reports a clear diagnostic when the host is unreachable', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    // Port 1 is reserved (TCPMUX). On every modern OS the connection is
    // refused or filtered, so `fetch` throws synchronously after a
    // short kernel-level rejection — fast enough not to trip the
    // 30s default timeout.
    const result = await executeCodegen({
      server: 'http://127.0.0.1:1/',
      out,
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('127.0.0.1:1');
  });

  it('reaches /base/api/v1/registry when given a path-prefixed server URL', async () => {
    let observedPath: string | null | undefined;
    const server = serveOnce((request) => {
      const url = new URL(request.url);
      observedPath = url.pathname;
      if (url.pathname === '/base/api/v1/registry') {
        return new Response(Bun.file(REGISTRY_FIXTURE), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      const url = new URL('/base', server.url).toString();
      const result = await executeCodegen({ server: url, out, timeoutMs: 30_000 });
      expect(result.exitCode).toBe(0);
      expect(observedPath).toBe('/base/api/v1/registry');
    } finally {
      await server.stop(true);
    }
  });

  it('times out cleanly against a hanging server', async () => {
    // A server that accepts the connection and never responds.
    const server = serveOnce(
      () =>
        new Promise<Response>(() => {
          /* never resolves */
        }),
    );
    try {
      const dir = makeTempDir();
      const out = join(dir, 'weft.d.ts');
      const result = await executeCodegen({
        server: server.url.toString(),
        out,
        timeoutMs: 50,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('50ms');
      expect(result.stderr).toContain(server.url.toString());
      expect(existsSync(out)).toBe(false);
    } finally {
      await server.stop(true);
    }
  });
});

describe('generated .d.ts typecheck fixture', () => {
  it('compiles under strict TypeScript with `@ts-expect-error` lines satisfied', async () => {
    // Resolve the TypeScript compiler from the fixture root and run it via
    // `bun` directly, rather than `bunx tsc`. `bunx` adds ~1.7s of package
    // resolution per call and offers nothing here; resolving the package entry
    // works in this worktree's layout (no local node_modules — deps resolve from
    // the project root) without relying on a PATH shim.
    const tscPath = Bun.resolveSync('typescript/bin/tsc', TYPECHECK_FIXTURE_DIR);
    const proc = Bun.spawn(['bun', tscPath, '-p', TYPECHECK_FIXTURE_DIR, '--noEmit'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (exitCode !== 0) {
      throw new Error(`typecheck fixture failed (exit ${exitCode}):\n${stdout}\n${stderr}`);
    }
    expect(exitCode).toBe(0);
    // The fixture imports `Engine` as a type only (see consumer.ts), so the
    // compile loads type declarations rather than the full engine runtime
    // closure. Measured ~3s isolated (down from 60–110s with a value import,
    // which flaked under parallel load). 30s leaves ample headroom under load.
  }, 30_000);
});

afterAll(() => {
  // The end-to-end fixture write tests use mkdtemp + afterEach
  // cleanup, so nothing should leak. This guard catches accidental
  // strays.
  expect(tempDirs).toHaveLength(0);
});
