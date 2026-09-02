import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildWorkflowRevisionManifest, type WorkflowContract } from '../core/contract/index.ts';
import { composeRegistryUrl, executeCodegen } from './codegen.ts';
import { CODEGEN_HELP_TEXT } from './help-text.ts';
import { parseCliArguments } from './parse-arguments.ts';

const FIXTURE_DIR = resolve(import.meta.dir, '__fixtures__/codegen');
const REGISTRY_FIXTURE = join(FIXTURE_DIR, 'registry.json');
const EXPECTED_DTS = join(FIXTURE_DIR, 'expected.d.ts');
const TYPECHECK_GENERATED_DTS = join(FIXTURE_DIR, 'typecheck', 'weft.generated.d.ts');

/** Real, hash-verifiable manifest for `--from`-mode fixtures — `parseWorkflowRevisionManifest` recomputes and checks `contractHash`, so a hand-written literal cannot satisfy it. */
function fixtureManifest(contract: WorkflowContract) {
  return buildWorkflowRevisionManifest(contract);
}

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

  it('keeps the tsc typecheck fixture (weft.generated.d.ts) in sync with expected.d.ts', async () => {
    // `codegen-typecheck.test.ts` feeds `weft.generated.d.ts` to a real `tsc`
    // subprocess as a structural proof that the generated `.d.ts` actually
    // compiles (in particular the alias-hoisting this batch adds). That file
    // is hand-maintained, independent of this test's `executeCodegen` ->
    // `expected.d.ts` pipeline, so nothing previously tethered the two
    // together: a future registry/schema change updated here without a
    // matching manual edit there would leave the `tsc` proof silently
    // compiling stale content while this file's string assertions still
    // passed. Byte-comparing them here makes that drift fail loudly instead.
    const expected = await Bun.file(EXPECTED_DTS).text();
    const typecheckFixture = await Bun.file(TYPECHECK_GENERATED_DTS).text();
    expect(typecheckFixture).toBe(expected);
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

  it('codegen output is identical for two snapshots differing only in generatedAt', async () => {
    // generatedAt is informational only — it must not affect the generated
    // declaration (acceptance criterion: "generatedAt must not affect
    // generated declarations or drift checks").
    const dir = makeTempDir();
    const raw = await Bun.file(REGISTRY_FIXTURE).text();

    const early = join(dir, 'early.json');
    writeFileSync(
      early,
      raw.replace(
        '"generatedAt": "2026-01-01T00:00:00.000Z"',
        '"generatedAt": "2020-06-15T12:34:56.000Z"',
      ),
    );
    const late = join(dir, 'late.json');
    writeFileSync(
      late,
      raw.replace(
        '"generatedAt": "2026-01-01T00:00:00.000Z"',
        '"generatedAt": "2030-11-30T23:59:59.999Z"',
      ),
    );

    const outEarly = join(dir, 'early.d.ts');
    const outLate = join(dir, 'late.d.ts');
    const resultEarly = await executeCodegen({ from: early, out: outEarly, timeoutMs: 30_000 });
    const resultLate = await executeCodegen({ from: late, out: outLate, timeoutMs: 30_000 });
    expect(resultEarly.exitCode).toBe(0);
    expect(resultLate.exitCode).toBe(0);
    expect(await Bun.file(outEarly).text()).toBe(await Bun.file(outLate).text());
  });

  it('fails with a clear diagnostic on registry version mismatch and writes no output', async () => {
    const dir = makeTempDir();
    const bad = join(dir, 'bad.json');
    const out = join(dir, 'weft.d.ts');
    const raw = await Bun.file(REGISTRY_FIXTURE).text();
    writeFileSync(bad, raw.replace('"registryVersion": 2', '"registryVersion": 3'));
    const result = await executeCodegen({ from: bad, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('registryVersion 3');
    expect(existsSync(out)).toBe(false);
  });

  it('rejects a v1 snapshot with a clear upgrade diagnostic (no compatibility layer)', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    const v1 = join(dir, 'v1.json');
    writeFileSync(
      v1,
      JSON.stringify({
        registryVersion: 1,
        workflows: { welcome: { inputSchema: { type: 'string' } } },
        activities: {},
      }),
    );
    const result = await executeCodegen({ from: v1, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      'codegen: registryVersion 1 is not supported (expected 2); upgrade or regenerate the snapshot',
    );
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
        registryVersion: 2,
        generatedAt: new Date(0).toISOString(),
        workflows: [],
        activeRevisions: {},
        // Activity missing the required `queue` field.
        activities: { broken: { outputSchema: { type: 'string' } } },
      }),
    );
    const result = await executeCodegen({ from: bad, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid registry snapshot');
    expect(existsSync(out)).toBe(false);
  });

  it('rejects a workflow manifest with a pathologically deep schema (WFT-5 hostile-input limit, before the emitter ever sees it)', async () => {
    const dir = makeTempDir();
    const bad = join(dir, 'deep.json');
    const out = join(dir, 'weft.d.ts');
    // Build a 200-deep nested object schema — well past
    // MAX_CONTRACT_SCHEMA_DEPTH (64). `parseWorkflowRevisionManifest`
    // walks `contract.inputSchema` (inside `parseContract`) before it ever
    // checks `contractHash`, so this is rejected at the manifest-parse
    // stage — the emitter's own (still-present) 64-deep recursion cap is
    // now unreachable through the `--from`/`--server` path, since nothing
    // this deep can survive to reach it. Placeholder `revision`/`contractHash`
    // values are fine: the depth check fires first.
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
        registryVersion: 2,
        generatedAt: new Date(0).toISOString(),
        workflows: [
          {
            manifestVersion: 1,
            name: 'tooDeep',
            workflowVersion: '0.0.0',
            revision: 'sha256:placeholder',
            contractHash: 'sha256:placeholder',
            contract: { name: 'tooDeep', workflowVersion: '0.0.0', inputSchema: deep },
          },
        ],
        activeRevisions: { tooDeep: 'sha256:placeholder' },
        activities: {},
      }),
    );
    const result = await executeCodegen({ from: bad, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/schema depth|nests deeper/i);
    expect(existsSync(out)).toBe(false);
  });

  it('accepts boolean root schemas for activities (activities keep v1 tolerance; workflows do not — see next test)', async () => {
    // JSON Schema permits a boolean at any schema position. Activity
    // entries are unversioned catalog metadata (unchanged from v1) and the
    // emitter never reads activity schemas anyway, so this Zod-level
    // tolerance is preserved.
    const dir = makeTempDir();
    const bool = join(dir, 'bool.json');
    const out = join(dir, 'weft.d.ts');
    writeFileSync(
      bool,
      JSON.stringify({
        registryVersion: 2,
        generatedAt: new Date(0).toISOString(),
        workflows: [],
        activeRevisions: {},
        activities: { wild: { queue: 'q', inputSchema: true, outputSchema: true } },
      }),
    );
    const result = await executeCodegen({ from: bool, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(0);
    const written = await Bun.file(out).text();
    // Activity names are never emitted globally — they live on
    // per-workflow builders.
    expect(written).not.toContain('"wild"');
  });

  it('rejects a workflow manifest with a boolean root schema (deliberate v2 narrowing — see CHANGELOG.md)', async () => {
    // v1 tolerated a boolean root schema on a *workflow* entry too
    // (`normalizeRootSchema` coarsened it to `{}`). v2 validates every
    // `workflows[]` element as a `WorkflowRevisionManifest` via
    // `parseWorkflowRevisionManifest`, whose schema-fragment parser
    // requires a JSON object at every `inputSchema`/`outputSchema`
    // position — matching what a real registry snapshot always produces
    // (`definitionSchemaToJsonSchema` never emits a boolean root). A
    // hand-vendored file using one is now rejected with a clear
    // diagnostic instead of silently coarsened.
    const dir = makeTempDir();
    const bad = join(dir, 'bool-workflow.json');
    const out = join(dir, 'weft.d.ts');
    writeFileSync(
      bad,
      JSON.stringify({
        registryVersion: 2,
        generatedAt: new Date(0).toISOString(),
        workflows: [
          {
            manifestVersion: 1,
            name: 'permissive',
            workflowVersion: '0.0.0',
            revision: 'sha256:placeholder',
            contractHash: 'sha256:placeholder',
            contract: { name: 'permissive', workflowVersion: '0.0.0', inputSchema: true },
          },
        ],
        activeRevisions: { permissive: 'sha256:placeholder' },
        activities: {},
      }),
    );
    const result = await executeCodegen({ from: bad, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('must be a JSON object');
    expect(existsSync(out)).toBe(false);
  });

  it('emits only the active manifest when a workflow name has an installed-but-inactive revision', async () => {
    // Two manifests for the same workflow name: same payload contract
    // (same `contractHash`) but a different `description`, so `revision`
    // (the broader, description-inclusive identity) differs between them —
    // a live demonstration of the two identities `WorkflowRevisionManifest`
    // carries. Only `activeRevisions["checkout"]` names which one codegen
    // actually emits from; the other, present in `workflows` but not
    // pointed at, is silently excluded (a future installed-but-inactive
    // revision, not an error).
    const dir = makeTempDir();
    const file = join(dir, 'multi-revision.json');
    const out = join(dir, 'weft.d.ts');

    const inputSchema = {
      type: 'object',
      properties: { cartId: { type: 'string' } },
      required: ['cartId'],
      additionalProperties: false,
    };
    const activeManifest = await fixtureManifest({
      name: 'checkout',
      workflowVersion: '1.0.0',
      inputSchema,
    });
    const inactiveManifest = await fixtureManifest({
      name: 'checkout',
      workflowVersion: '1.0.0',
      description: 'An older documented revision.',
      inputSchema,
    });
    expect(inactiveManifest.contractHash).toBe(activeManifest.contractHash);
    expect(inactiveManifest.revision).not.toBe(activeManifest.revision);

    writeFileSync(
      file,
      JSON.stringify({
        registryVersion: 2,
        generatedAt: new Date(0).toISOString(),
        workflows: [activeManifest, inactiveManifest],
        activeRevisions: { checkout: activeManifest.revision },
        activities: {},
      }),
    );

    const result = await executeCodegen({ from: file, out, timeoutMs: 30_000, json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed['workflows']).toBe(1);
    const written = await Bun.file(out).text();
    expect(written).toContain('"checkout"');
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
      // `resolveConnection` raises a `ConnectionConfigurationError` for a
      // malformed server value; `executeCodegen` must translate that into a
      // clean diagnostic naming the offending URL rather than rejecting.
      const result = await executeCodegen({
        server: 'not a url',
        out,
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("codegen: Invalid server URL 'not a url'");
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
      expect(result.stderr).toContain("codegen: Invalid server URL ':::not-a-url:::'");
      expect(existsSync(out)).toBe(false);
    } finally {
      if (priorAddress === undefined) delete Bun.env['WEFT_ADDR'];
      else Bun.env['WEFT_ADDR'] = priorAddress;
    }
  });

  it('names the actual invalid URL when it comes from a profile (not --server/WEFT_ADDR)', async () => {
    // Regression for the misleading empty-URL diagnostic: when neither --server
    // nor WEFT_ADDR is set, the malformed URL resolves from the profile, and the
    // diagnostic must still report the offending value rather than an empty
    // string.
    const home = makeTempDir();
    writeFileSync(
      join(home, 'config'),
      ['default_profile = "main"', '', '[profiles.main]', 'server = "http://[::bad"'].join('\n'),
    );
    const out = join(home, 'weft.d.ts');
    const priorHome = Bun.env['WEFT_HOME'];
    const priorAddress = Bun.env['WEFT_ADDR'];
    const priorProfile = Bun.env['WEFT_PROFILE'];
    Bun.env['WEFT_HOME'] = home;
    delete Bun.env['WEFT_ADDR'];
    // resolveConnectionContext reads WEFT_PROFILE before the config's
    // default_profile, so an externally-set WEFT_PROFILE would select a profile
    // other than "main" and break this test in CI/dev environments. Clear it so
    // the malformed URL resolves from the config's "main" profile as intended.
    delete Bun.env['WEFT_PROFILE'];
    try {
      const result = await executeCodegen({ out, timeoutMs: 30_000 });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("codegen: Invalid server URL 'http://[::bad'");
      expect(result.stderr).not.toContain("URL ''");
      expect(existsSync(out)).toBe(false);
    } finally {
      if (priorHome === undefined) delete Bun.env['WEFT_HOME'];
      else Bun.env['WEFT_HOME'] = priorHome;
      if (priorAddress === undefined) delete Bun.env['WEFT_ADDR'];
      else Bun.env['WEFT_ADDR'] = priorAddress;
      if (priorProfile === undefined) delete Bun.env['WEFT_PROFILE'];
      else Bun.env['WEFT_PROFILE'] = priorProfile;
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
      // Deliberately not awaited: the handler promise never settles, and
      // Bun's stop() completion promise waits on it, so awaiting here hangs
      // past the test timeout whenever the aborted connection has not fully
      // torn down first. The force-stop itself closes the listener.
      void server.stop(true);
    }
  });
});

// The `generated .d.ts typecheck fixture` test moved to codegen-typecheck.test.ts:
// it spawns a real `tsc` subprocess whose wall-clock cost is unbounded under CPU
// contention, so it is isolated via LOAD_SENSITIVE_TEST_PATHS rather than slowing
// or flaking this fast, deterministic parser/codegen suite.

afterAll(() => {
  // The end-to-end fixture write tests use mkdtemp + afterEach
  // cleanup, so nothing should leak. This guard catches accidental
  // strays.
  expect(tempDirs).toHaveLength(0);
});
