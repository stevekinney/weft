import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { RealmStateChangedEvent } from '../events/fleet-state-events.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';

const workerUrl = new URL('../realm/__fixtures__/revision-realm-worker-entry.ts', import.meta.url);

describe('realm:state-changed on the Engine', () => {
  it('is dispatched for each realm transition with the realm id, revision, state and restart count', async () => {
    await using engine = new Engine({
      storage: new MemoryStorage(),
      backgroundTasks: 'manual',
      workflowExecutionMode: 'realm',
      revisionRealmExecution: { resolveRevisionRealmConfig: () => undefined },
    });
    const seen: RealmStateChangedEvent[] = [];
    engine.addEventListener(RealmStateChangedEvent.type, (event) => {
      seen.push(event);
    });
    const registry = getInternals(engine).revisionRealmRegistry;
    if (registry === undefined) throw new Error('realm mode installs a registry');

    registry.ensurePool('order-workflow', 'revision-a', {
      workerUrl,
      expectedWorkflowTypes: ['order-workflow'],
      expectedArtifactDigest: 'digest-a',
      workerName: 'digest-a',
      concurrency: 1,
    });
    const outcome = await registry.acquireForExecution('order-workflow', 'revision-a', 'run-1');
    if (!outcome.ok) throw new Error('unreachable');

    expect(seen.map((event) => [event.revision, event.state, event.restartCount])).toEqual([
      ['revision-a', 'ready', 0],
      ['revision-a', 'active', 0],
    ]);
    expect(seen[0]?.realmId).toBe(seen[1]?.realmId);
    expect(seen[0]?.realmId).toMatch(/^[0-9a-f-]{36}$/);
    registry.releaseAfterExecution('order-workflow', 'revision-a', outcome.realm);
  });
});
