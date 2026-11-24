/**
 * The routing pointer's `previousBuildId` (COR-1813): derived inside the conditional write when the
 * current build changes, carried over by a write that keeps it, and absent on a record written
 * before the field existed.
 */
import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { describe, expect, it } from 'bun:test';
import { encode } from '../core/codec/index.ts';
import { routingKey } from './deployment-records.ts';
import { WorkerDeploymentCatalog } from './deployment-routing.ts';
import type { WorkerManifest } from './manifest/types.ts';

function manifest(buildId: string): WorkerManifest {
  return {
    manifestVersion: 1,
    protocolVersion: 1,
    sdkVersion: 'test',
    runtime: { name: 'bun', version: 'test' },
    deployment: { name: 'billing', buildId, artifactDigest: `sha256:${buildId}` },
    workflows: {},
    capabilities: {},
  };
}

async function catalogWith(
  storage: MemoryStorage,
  buildIds: readonly string[],
): Promise<WorkerDeploymentCatalog> {
  const catalog = new WorkerDeploymentCatalog(storage);
  for (const buildId of buildIds) {
    await catalog.registerVersion({
      deploymentName: 'billing',
      buildId,
      artifactDigest: `sha256:${buildId}`,
      manifestDigest: `sha256:m-${buildId}`,
      manifest: manifest(buildId),
      state: 'ready',
      firstSeenAt: 1,
    });
  }
  return catalog;
}

describe('routing previousBuildId', () => {
  it('has none on the first write, and names the replaced build once the current build changes', async () => {
    const catalog = await catalogWith(new MemoryStorage(), ['build-a', 'build-b', 'build-c']);
    const first = await catalog.setRouting({
      deploymentName: 'billing',
      currentBuildId: 'build-a',
      rampBasisPoints: 0,
      updatedAt: 1,
    });
    expect(first).not.toBeNull();
    expect(first !== null && 'previousBuildId' in first).toBe(false);

    const second = await catalog.setRouting({
      deploymentName: 'billing',
      currentBuildId: 'build-b',
      rampBasisPoints: 0,
      updatedAt: 2,
    });
    expect(second?.previousBuildId).toBe('build-a');

    const third = await catalog.setRouting({
      deploymentName: 'billing',
      currentBuildId: 'build-c',
      rampBasisPoints: 0,
      updatedAt: 3,
    });
    expect(third?.previousBuildId).toBe('build-b');
    const stored = await catalog.getRouting('billing');
    expect(stored?.previousBuildId).toBe('build-b');
  });

  it('carries previousBuildId across a ramp that keeps the current build', async () => {
    const catalog = await catalogWith(new MemoryStorage(), ['build-a', 'build-b', 'build-c']);
    for (const [buildId, updatedAt] of [
      ['build-a', 1],
      ['build-b', 2],
    ] as const) {
      await catalog.setRouting({
        deploymentName: 'billing',
        currentBuildId: buildId,
        rampBasisPoints: 0,
        updatedAt,
      });
    }
    const ramped = await catalog.setRouting({
      deploymentName: 'billing',
      currentBuildId: 'build-b',
      rampingBuildId: 'build-c',
      rampBasisPoints: 2500,
      updatedAt: 3,
    });
    expect(ramped?.previousBuildId).toBe('build-a');
    const cleared = await catalog.setRouting({
      deploymentName: 'billing',
      currentBuildId: 'build-b',
      rampBasisPoints: 0,
      updatedAt: 4,
    });
    expect(cleared?.previousBuildId).toBe('build-a');
  });

  it('does not let a caller supply previousBuildId', async () => {
    const catalog = await catalogWith(new MemoryStorage(), ['build-a', 'build-b']);
    const written = await catalog.setRouting({
      deploymentName: 'billing',
      currentBuildId: 'build-a',
      rampBasisPoints: 0,
      updatedAt: 1,
      previousBuildId: 'build-b',
    } as Parameters<WorkerDeploymentCatalog['setRouting']>[0]);
    expect(written !== null && 'previousBuildId' in written).toBe(false);
  });

  it('reads a record written before the field existed, with no previousBuildId', async () => {
    const storage = new MemoryStorage();
    const catalog = await catalogWith(storage, ['build-a', 'build-b']);
    await storage.put(
      routingKey('billing'),
      encode({
        deploymentName: 'billing',
        currentBuildId: 'build-a',
        rampBasisPoints: 0,
        generation: 4,
        updatedAt: 9,
      }),
    );
    const routing = await catalog.getRouting('billing');
    expect(routing?.generation).toBe(4);
    expect(routing !== null && 'previousBuildId' in routing).toBe(false);

    const promoted = await catalog.setRouting({
      deploymentName: 'billing',
      currentBuildId: 'build-b',
      rampBasisPoints: 0,
      updatedAt: 10,
      expectedGeneration: 4,
    });
    expect(promoted?.generation).toBe(5);
    expect(promoted?.previousBuildId).toBe('build-a');
  });

  it('refuses a stored previousBuildId that is not a string', async () => {
    const storage = new MemoryStorage();
    const catalog = await catalogWith(storage, ['build-a']);
    await storage.put(
      routingKey('billing'),
      encode({
        deploymentName: 'billing',
        currentBuildId: 'build-a',
        previousBuildId: 7,
        rampBasisPoints: 0,
        generation: 1,
        updatedAt: 1,
      }),
    );
    let message = '';
    try {
      await catalog.getRouting('billing');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Invalid worker deployment routing record.');
  });
});
