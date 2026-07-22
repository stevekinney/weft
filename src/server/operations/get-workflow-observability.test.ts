import { describe, expect, it } from 'bun:test';

import { encode } from '../../core/codec.ts';
import { Engine } from '../../core/engine.ts';
import { encodeScheduleRunMetadata } from '../../core/engine/schedule-run-metadata.ts';
import { KEYS } from '../../storage/interface.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import {
  getWorkflowFinalizerOperation,
  getWorkflowFinalizerRestBinding,
  getWorkflowScheduleProvenanceOperation,
  getWorkflowScheduleProvenanceRestBinding,
} from './get-workflow-observability.ts';

const registry = createOperationRegistry([
  getWorkflowScheduleProvenanceOperation,
  getWorkflowFinalizerOperation,
]);
const restBindings = [getWorkflowScheduleProvenanceRestBinding, getWorkflowFinalizerRestBinding];

describe('workflow observability reads', () => {
  it('returns schedule provenance over REST', async () => {
    await using engine = new Engine();
    await engine.storage.put(
      KEYS.scheduleRunLink('scheduled-run'),
      encodeScheduleRunMetadata('nightly-schedule', 1_000),
    );

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/scheduled-run/schedule-provenance'),
      engine,
      { operationRegistry: registry, restBindings },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ scheduleId: 'nightly-schedule', occurrence: 1_000 });
  });

  it('returns finalizer progress over REST', async () => {
    await using engine = new Engine();
    await engine.storage.put(
      KEYS.teardownOwed('cancelled-run'),
      encode({ status: 'running', attempts: 1, token: 'claim', claimedAt: 500 }),
    );

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/cancelled-run/finalizer'),
      engine,
      { operationRegistry: registry, restBindings },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'running', attempts: 2, startedAt: 500 });
  });

  it('returns null when a workflow has neither schedule nor finalizer metadata', async () => {
    await using engine = new Engine();
    for (const path of ['schedule-provenance', 'finalizer']) {
      const response = await handleRequest(
        new Request(`http://localhost/v1/workflows/ordinary-run/${path}`),
        engine,
        { operationRegistry: registry, restBindings },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toBeNull();
    }
  });
});
