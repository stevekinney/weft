/**
 * Verifies binary storage snapshots remain readable by the engine.
 *
 * Contract: These fixtures freeze observable behavior. Engine PRs must not
 * change them; if a fixture changes, that is a regression.
 */

import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../src/core/engine.ts';
import type { Storage } from '../../src/storage/interface.ts';
import {
  registerScenarioHandlers,
  scenarioNames,
} from '../../src/testing/replay-scenarios.test-support.ts';
import { storageBackends, teardown } from '../../src/testing/storage-backends.ts';
import type { TraceFixture } from '../../src/testing/trace-fixture-support.test-support.ts';

const checkpointFixtureDirectory = 'tests/checkpoint-compat';
const replayFixtureDirectory = 'tests/replay-fixtures';
const expectedFixtureCount = 10;
const textDecoder = new TextDecoder();
const binaryFixtureGlob = new Bun.Glob('*.bin');
const fixtureFiles = [...binaryFixtureGlob.scanSync(checkpointFixtureDirectory)].toSorted();

function deserializeSnapshot(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  const readUint32 = (): number => {
    if (offset + 4 > bytes.byteLength) {
      throw new Error('Snapshot ended while reading a uint32 field');
    }

    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };

  const readBytes = (length: number): Uint8Array => {
    if (offset + length > bytes.byteLength) {
      throw new Error('Snapshot ended while reading an entry field');
    }

    const value = bytes.slice(offset, offset + length);
    offset += length;
    return value;
  };

  const count = readUint32();
  const map = new Map<string, Uint8Array>();

  for (let index = 0; index < count; index += 1) {
    const keyLength = readUint32();
    const keyBytes = readBytes(keyLength);
    const key = textDecoder.decode(keyBytes);
    const valueLength = readUint32();
    const value = readBytes(valueLength);
    map.set(key, value);
  }

  if (offset !== bytes.byteLength) {
    throw new Error('Snapshot contains trailing bytes');
  }

  return map;
}

async function populateStorage(storage: Storage, snapshot: Map<string, Uint8Array>): Promise<void> {
  for (const [key, value] of snapshot) {
    await storage.put(key, value);
  }
}

async function loadJsonFixture(scenario: string): Promise<TraceFixture> {
  const value = await Bun.file(`${replayFixtureDirectory}/${scenario}.json`).json();
  return value as TraceFixture;
}

describe('checkpoint fixture scenario coverage', () => {
  it('keeps checkpoint fixtures and registered scenario handlers in sync', async () => {
    const onDisk = new Set<string>();
    for (const fixtureFile of fixtureFiles) {
      const scenario = fixtureFile.replace(/\.bin$/, '');
      const fixture = await loadJsonFixture(scenario);
      expect(fixture.scenario).toBe(scenario);
      onDisk.add(fixture.scenario);
    }
    const registered = new Set(scenarioNames);
    expect([...onDisk].toSorted()).toEqual([...registered].toSorted());
  });
});

for (const backend of storageBackends) {
  describe(`checkpoint compatibility fixtures [${backend.name}]`, () => {
    let engine: Engine | undefined;
    let cleanup: (() => void | Promise<void>) | undefined;

    afterEach(async () => {
      await teardown(engine, cleanup);
      engine = undefined;
      cleanup = undefined;
    });

    it('has the expected fixture count', () => {
      expect(fixtureFiles).toHaveLength(expectedFixtureCount);
    });

    for (const fixtureFile of fixtureFiles) {
      it(`reads ${fixtureFile}`, async () => {
        const scenario = fixtureFile.replace(/\.bin$/, '');
        const fixture = await loadJsonFixture(scenario);
        const bytes = await Bun.file(`${checkpointFixtureDirectory}/${fixtureFile}`).bytes();
        const snapshot = deserializeSnapshot(bytes);
        const result = backend.factory();
        cleanup = result.cleanup;
        await populateStorage(result.storage, snapshot);
        engine = new Engine({ storage: result.storage });
        registerScenarioHandlers(engine, scenario);

        const workflowId = fixture.finalState.id;
        await expect(engine.get(workflowId)).resolves.toEqual(fixture.finalState);
        await expect(engine.getTimeline(workflowId)).resolves.toEqual(fixture.timeline);
        await expect(engine.getEvents(workflowId)).resolves.toEqual(fixture.events);

        const recoveredHandles = await engine.recoverAll();
        expect(recoveredHandles).toHaveLength(0);

        if (scenario === 'fork-from-checkpoint') {
          const forkedWorkflows = await engine.list({ type: 'fork-from-checkpoint' });
          expect(forkedWorkflows.total).toBe(2);
          expect(forkedWorkflows.items.map((item) => item.status).toSorted()).toEqual([
            'completed',
            'completed',
          ]);
        }
      });
    }
  });
}
