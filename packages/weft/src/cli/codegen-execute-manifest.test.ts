import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildWorkflowRevisionManifest, type WorkflowContract } from '../index.ts';
import { executeCodegen } from './codegen.ts';

const FIXTURE_DIR = resolve(import.meta.dir, '__fixtures__/codegen');
const REGISTRY_FIXTURE = join(FIXTURE_DIR, 'registry.json');

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

describe('executeCodegen end-to-end', () => {
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

  it('accepts boolean root schemas for activities while workflows require object schemas', async () => {
    // JSON Schema permits a boolean at any schema position. Activity
    // Activity entries are unversioned catalog metadata and the
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

  it('rejects a workflow manifest with a boolean root schema', async () => {
    // Workflow entries require an object root schema; boolean roots are
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
    const parsed: Record<string, unknown> = JSON.parse(result.stdout);
    expect(parsed['workflows']).toBe(1);
    const written = await Bun.file(out).text();
    expect(written).toContain('"checkout"');
  });
});
