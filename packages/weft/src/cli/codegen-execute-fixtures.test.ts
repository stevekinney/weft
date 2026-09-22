import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import manifest from '../../package.json';

import { codegenPackageName, executeCodegen } from './codegen.ts';

const FIXTURE_DIR = resolve(import.meta.dir, '__fixtures__/codegen');
const REGISTRY_FIXTURE = join(FIXTURE_DIR, 'registry.json');
const EXPECTED_DTS = join(FIXTURE_DIR, 'expected.d.txt');
const TYPECHECK_GENERATED_DTS = join(FIXTURE_DIR, 'typecheck', 'weft.generated.d.ts');

/**
 * The one token in the golden that is not literal output.
 *
 * `weft codegen` augments whatever this package is published as, so the golden
 * cannot hold a package name and still be right in more than one repository:
 * the mirror transform rewrites module specifiers in files it can parse, and
 * `.d.txt` is not one of them, so a literal name here would keep naming this
 * workspace downstream while the emitter named the published package. Every
 * other byte of the golden is compared exactly; only this token is filled in.
 */
const PACKAGE_NAME_PLACEHOLDER = '@@PACKAGE_NAME@@';

async function readGolden(): Promise<string> {
  const template = await Bun.file(EXPECTED_DTS).text();
  if (!template.includes(PACKAGE_NAME_PLACEHOLDER)) {
    throw new Error(
      `${EXPECTED_DTS} no longer carries ${PACKAGE_NAME_PLACEHOLDER}; a golden with a literal package name silently stops checking the emitted module name`,
    );
  }
  return template.replaceAll(PACKAGE_NAME_PLACEHOLDER, codegenPackageName);
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

describe('executeCodegen end-to-end', () => {
  it('emits the expected .d.ts from the registry fixture', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    const result = await executeCodegen({ from: REGISTRY_FIXTURE, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('codegen: wrote');
    const written = await Bun.file(out).text();
    expect(written).toBe(await readGolden());
  });

  it('augments the module name this package is published under, not a hardcoded one', async () => {
    // The generated declaration is only useful if `declare module '…'` names
    // the specifier the consumer types, which is this package's published
    // name. Asserting against the manifest rather than against the string the
    // checkout happens to use is what makes this fail if the emitter ever goes
    // back to a literal: a literal survives being republished under another
    // name, and the manifest does not.
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    const result = await executeCodegen({ from: REGISTRY_FIXTURE, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(0);
    const written = await Bun.file(out).text();
    expect(codegenPackageName).toBe(manifest.name);
    expect(written).toContain(`declare module '${manifest.name}' {`);
  });

  it('keeps the tsc typecheck fixture (weft.generated.d.ts) in sync with expected.d.txt', async () => {
    // `codegen-typecheck.test.ts` feeds `weft.generated.d.ts` to a real `tsc`
    // subprocess as a structural proof that the generated `.d.ts` actually
    // compiles (in particular the alias-hoisting this batch adds). That file
    // is hand-maintained, independent of this test's `executeCodegen` ->
    // `expected.d.txt` pipeline, so nothing previously tethered the two
    // together: a future registry/schema change updated here without a
    // matching manual edit there would leave the `tsc` proof silently
    // compiling stale content while this file's string assertions still
    // passed. Byte-comparing them here makes that drift fail loudly instead.
    //
    // The fixture keeps a real package name rather than the golden's
    // placeholder because `tsc` has to parse it, and the mirror transform
    // rewrites that name along with every other module specifier it emits.
    const typecheckFixture = await Bun.file(TYPECHECK_GENERATED_DTS).text();
    expect(typecheckFixture).toBe(await readGolden());
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
});
