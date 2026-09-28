import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  activityContractHash,
  buildWorkflowRevisionManifest,
  type WorkflowActivityContract,
} from '../core/contract/index.ts';
import { REGISTRY_VERSION } from '../core/registry-snapshot.ts';
import { WORKER_MANIFEST_VERSION, type WorkerManifest } from '../worker/manifest/index.ts';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../worker/protocol.ts';
import { executeWorkerVerify } from './worker-verify.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-worker-verify-'));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

function parseStderrJson(stderr: string | undefined): unknown {
  if (stderr === undefined) {
    throw new Error('expected stderr JSON');
  }
  return JSON.parse(stderr);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const formatGreetingContract = {
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  },
  outputSchema: { type: 'string' },
} satisfies WorkflowActivityContract;

async function writeFixtureFiles(
  dir: string,
  mutateManifest?: (manifest: WorkerManifest) => WorkerManifest,
): Promise<{ manifest: string; registry: string }> {
  const workflow = await buildWorkflowRevisionManifest({
    name: 'welcome',
    workflowVersion: '1.0.0',
    activities: { formatGreeting: formatGreetingContract },
  });
  const activityHash = await activityContractHash(formatGreetingContract);
  const manifest: WorkerManifest = {
    manifestVersion: WORKER_MANIFEST_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    sdkVersion: '0.0.0-test',
    runtime: { name: 'bun', version: Bun.version },
    deployment: {
      name: 'greeting-worker',
      buildId: 'build-1',
      artifactDigest: 'sha256:artifact',
    },
    workflows: {
      welcome: {
        workflowVersion: workflow.workflowVersion,
        workflowRevision: workflow.revision,
        contractHash: workflow.contractHash,
        activities: {
          formatGreeting: {
            contractHash: activityHash,
            implementationRevision: 'implementation-1',
          },
        },
      },
    },
    capabilities: {},
  };
  const registry = {
    registryVersion: REGISTRY_VERSION,
    generatedAt: '2026-01-01T00:00:00.000Z',
    workflows: [workflow],
    activeRevisions: { welcome: workflow.revision },
    activities: {},
  };
  const manifestPath = join(dir, 'worker-manifest.json');
  const registryPath = join(dir, 'registry.json');
  writeJson(manifestPath, mutateManifest?.(manifest) ?? manifest);
  writeJson(registryPath, registry);
  return { manifest: manifestPath, registry: registryPath };
}

describe('executeWorkerVerify', () => {
  it('accepts a worker manifest that matches the active registry contracts', async () => {
    const paths = await writeFixtureFiles(makeTempDir());
    const result = await executeWorkerVerify({ manifest: paths.manifest, from: paths.registry });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('worker verify: manifest matches registry snapshot');
  });

  it('detects stale workflow and activity contract hashes', async () => {
    const paths = await writeFixtureFiles(makeTempDir(), (manifest) => ({
      ...manifest,
      workflows: {
        welcome: {
          ...manifest.workflows['welcome']!,
          contractHash: 'sha256:stale-workflow',
          activities: {
            formatGreeting: {
              ...manifest.workflows['welcome']!.activities['formatGreeting']!,
              contractHash: 'sha256:stale-activity',
            },
          },
        },
      },
    }));
    const result = await executeWorkerVerify({ manifest: paths.manifest, from: paths.registry });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('workflow "welcome" contract hash mismatch');
    expect(result.stderr).toContain('activity "welcome.formatGreeting" contract hash mismatch');
  });

  it('detects missing and extra generated worker activity declarations', async () => {
    const paths = await writeFixtureFiles(makeTempDir(), (manifest) => ({
      ...manifest,
      workflows: {
        welcome: {
          ...manifest.workflows['welcome']!,
          activities: {
            extraActivity: {
              contractHash: 'sha256:extra',
              implementationRevision: 'implementation-2',
            },
          },
        },
      },
    }));
    const result = await executeWorkerVerify({ manifest: paths.manifest, from: paths.registry });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('extra activity "welcome.extraActivity"');
    expect(result.stderr).toContain('missing activity "welcome.formatGreeting"');
  });

  it('detects workflow revision and version mismatches', async () => {
    const paths = await writeFixtureFiles(makeTempDir(), (manifest) => ({
      ...manifest,
      workflows: {
        welcome: {
          ...manifest.workflows['welcome']!,
          workflowRevision: 'sha256:stale-revision',
          workflowVersion: '2.0.0',
        },
      },
    }));
    const result = await executeWorkerVerify({ manifest: paths.manifest, from: paths.registry });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('workflow "welcome" revision mismatch');
    expect(result.stderr).toContain('workflow "welcome" version mismatch');
  });

  it('detects extra and missing workflows', async () => {
    const paths = await writeFixtureFiles(makeTempDir(), (manifest) => ({
      ...manifest,
      workflows: {
        orphan: {
          workflowVersion: '1.0.0',
          workflowRevision: 'sha256:orphan',
          contractHash: 'sha256:orphan-contract',
          activities: {},
        },
      },
    }));
    const result = await executeWorkerVerify({ manifest: paths.manifest, from: paths.registry });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('extra workflow "orphan"');
    expect(result.stderr).toContain('missing workflow "welcome"');
  });

  it('reports malformed manifest JSON', async () => {
    const dir = makeTempDir();
    const manifest = join(dir, 'bad-manifest.json');
    writeFileSync(manifest, '{ not json');
    const result = await executeWorkerVerify({ manifest, from: join(dir, 'registry.json') });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('worker verify: failed to parse manifest JSON');
  });

  it('reports invalid manifests in JSON mode', async () => {
    const dir = makeTempDir();
    const manifest = join(dir, 'invalid-manifest.json');
    writeJson(manifest, { manifestVersion: 1 });
    const result = await executeWorkerVerify({
      manifest,
      from: join(dir, 'registry.json'),
      json: true,
    });

    expect(result.exitCode).toBe(1);
    expect(parseStderrJson(result.stderr)).toEqual({
      ok: false,
      error: expect.stringContaining('worker verify: invalid manifest'),
    });
  });

  it('emits drift diagnostics as JSON when requested', async () => {
    const paths = await writeFixtureFiles(makeTempDir(), (manifest) => ({
      ...manifest,
      workflows: {
        welcome: {
          ...manifest.workflows['welcome']!,
          contractHash: 'sha256:stale-workflow',
        },
      },
    }));
    const result = await executeWorkerVerify({
      manifest: paths.manifest,
      from: paths.registry,
      json: true,
    });

    expect(result.exitCode).toBe(1);
    expect(parseStderrJson(result.stderr)).toEqual({
      ok: false,
      diagnostics: ['workflow "welcome" contract hash mismatch'],
    });
  });
});
