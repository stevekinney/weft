import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { buildWorkflowContract } from '../contract/build.ts';
import { buildWorkflowRevisionManifest } from '../contract/manifest.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import {
  WorkflowRevisionActivatedEvent,
  WorkflowRevisionActivationRejectedEvent,
  WorkflowRevisionDrainingEvent,
  WorkflowRevisionInstalledEvent,
} from '../events/catalog-events.ts';
import { activateCatalogRevisionCandidate } from './catalog-activation.ts';
import { Engine } from './index.ts';

async function manifestFor(
  name: string,
  version: string,
  overrides?: { revision?: string; description?: string },
): Promise<WorkflowRevisionManifest> {
  const contract = buildWorkflowContract({
    name,
    version,
    ...(overrides?.description === undefined ? {} : { description: overrides.description }),
  });
  return buildWorkflowRevisionManifest(
    contract,
    overrides?.revision === undefined ? undefined : { revision: overrides.revision },
  );
}

type Collected = {
  installed: WorkflowRevisionInstalledEvent[];
  activated: WorkflowRevisionActivatedEvent[];
  draining: WorkflowRevisionDrainingEvent[];
  rejected: WorkflowRevisionActivationRejectedEvent[];
};

function collectCatalogEvents(engine: Engine): Collected {
  const collected: Collected = { installed: [], activated: [], draining: [], rejected: [] };
  engine.addEventListener(WorkflowRevisionInstalledEvent.type, (e) => collected.installed.push(e));
  engine.addEventListener(WorkflowRevisionActivatedEvent.type, (e) => collected.activated.push(e));
  engine.addEventListener(WorkflowRevisionDrainingEvent.type, (e) => collected.draining.push(e));
  engine.addEventListener(WorkflowRevisionActivationRejectedEvent.type, (e) =>
    collected.rejected.push(e),
  );
  return collected;
}

describe('activateCatalogRevisionCandidate', () => {
  it('applied: dispatches installed + activated (first-ever activation)', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    const events = collectCatalogEvents(engine);
    const v1 = await manifestFor('checkout', '1.0.0');

    await activateCatalogRevisionCandidate(engine, 'checkout', v1);

    expect(events.installed).toHaveLength(1);
    expect(events.activated).toHaveLength(1);
    expect(events.activated[0]?.previousRevision).toBeUndefined();
    expect(events.draining).toHaveLength(0);
    expect(events.rejected).toHaveLength(0);
  });

  it('applied: displacing an active revision dispatches installed + draining(old) + activated(new)', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    const events = collectCatalogEvents(engine);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '1.0.0', { description: 'a later revision' });
    await activateCatalogRevisionCandidate(engine, 'checkout', v1);

    await activateCatalogRevisionCandidate(engine, 'checkout', v2, {
      expectedGeneration: 1,
      policy: { requireExactRevision: false },
    });

    expect(events.installed).toHaveLength(2);
    expect(events.draining).toHaveLength(1);
    expect(events.draining[0]?.revision).toBe(v1.revision);
    expect(events.activated).toHaveLength(2);
    expect(events.activated[1]?.revision).toBe(v2.revision);
    expect(events.activated[1]?.previousRevision).toBe(v1.revision);
    expect(events.rejected).toHaveLength(0);
  });

  it('incompatible: dispatches activation-rejected with the reason code and bounded incompatibilityReasons, never the full verdict', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    const events = collectCatalogEvents(engine);
    const v1 = await manifestFor('checkout', '1.0.0');
    // A candidate with a genuinely different contract hash under the
    // default (requireExactRevision: true) policy is incompatible.
    const v2 = await manifestFor('checkout', '2.0.0');
    await activateCatalogRevisionCandidate(engine, 'checkout', v1);

    // expectedGeneration is required once `checkout` has an active pointer
    // (WFT-11) — supplying the correct one here isolates this test to the
    // `incompatible` refusal specifically, not `expected-generation-required`.
    await activateCatalogRevisionCandidate(engine, 'checkout', v2, { expectedGeneration: 1 });

    expect(events.rejected).toHaveLength(1);
    const rejection = events.rejected[0]!;
    expect(rejection.reason).toBe('incompatible');
    expect(Array.isArray(rejection.incompatibilityReasons)).toBe(true);
    expect(rejection.incompatibilityReasons!.length).toBeGreaterThan(0);
    // The event never carries a `verdict` field — only the primitive reason array.
    expect((rejection as unknown as { verdict?: unknown }).verdict).toBeUndefined();
    expect(events.activated).toHaveLength(1); // only the first activation
  });

  it('stale-generation: dispatches activation-rejected without incompatibilityReasons', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    const events = collectCatalogEvents(engine);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '1.0.0', { description: 'later' });
    await activateCatalogRevisionCandidate(engine, 'checkout', v1);

    await activateCatalogRevisionCandidate(engine, 'checkout', v2, {
      expectedGeneration: 99,
      policy: { requireExactRevision: false },
    });

    expect(events.rejected).toHaveLength(1);
    expect(events.rejected[0]?.reason).toBe('stale-generation');
    expect(events.rejected[0]?.incompatibilityReasons).toBeUndefined();
  });

  it('expected-generation-required (WFT-11): dispatches activation-rejected, returns the result, and returns the same result even on success', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    const events = collectCatalogEvents(engine);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '1.0.0', { description: 'later' });
    const first = await activateCatalogRevisionCandidate(engine, 'checkout', v1);
    expect(first.applied).toBe(true);

    // Omitting expectedGeneration on a 2nd-or-later activation refuses —
    // the wrapper must return this refusal verbatim, not just dispatch it.
    const second = await activateCatalogRevisionCandidate(engine, 'checkout', v2, {
      policy: { requireExactRevision: false },
    });

    expect(second.applied).toBe(false);
    if (!second.applied) {
      expect(second.reason).toBe('expected-generation-required');
    }
    expect(events.rejected).toHaveLength(1);
    expect(events.rejected[0]?.reason).toBe('expected-generation-required');
    expect(events.rejected[0]?.incompatibilityReasons).toBeUndefined();
  });

  it('conflict: dispatches activation-rejected when the CAS write itself loses the race', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage, backgroundTasks: 'manual' });
    const events = collectCatalogEvents(engine);
    const v1 = await manifestFor('checkout', '1.0.0');
    await activateCatalogRevisionCandidate(engine, 'checkout', v1);
    // Stub AFTER the real install/activation above so the CAS failure
    // exercises activateCandidate's own write, not install()'s entry CAS.
    storage.conditionalBatch = async () => false;

    await activateCatalogRevisionCandidate(engine, 'checkout', v1, { expectedGeneration: 1 });

    expect(events.rejected).toHaveLength(1);
    expect(events.rejected[0]?.reason).toBe('conflict');
    expect(events.rejected[0]?.incompatibilityReasons).toBeUndefined();
  });

  it('does not dispatch installed for a reinstall of already-durably-present content, but still reports the generation bump with no previousRevision (nothing was displaced)', async () => {
    await using storage = new MemoryStorage();
    await using engineA = new Engine({ storage, backgroundTasks: 'manual' });
    const v1 = await manifestFor('checkout', '1.0.0');
    await activateCatalogRevisionCandidate(engineA, 'checkout', v1);

    await using engineB = new Engine({ storage, backgroundTasks: 'manual' });
    const events = collectCatalogEvents(engineB);

    // activateCandidate (unlike activateRegistered) always bumps the
    // generation, even reactivating the same revision — so this is not a
    // true no-op, but nothing was DISPLACED either (draining stays silent).
    // `engineB` never observed `engineA`'s activation in-process, but the
    // durable generation is already 1 — expectedGeneration is required
    // (WFT-11) once a durable active pointer exists, regardless of which
    // process last observed it.
    await activateCatalogRevisionCandidate(engineB, 'checkout', v1, { expectedGeneration: 1 });

    expect(events.installed).toHaveLength(0);
    expect(events.draining).toHaveLength(0);
    expect(events.activated).toHaveLength(1);
    expect(events.activated[0]?.revision).toBe(v1.revision);
    expect(events.activated[0]?.generation).toBe(2);
    expect(events.activated[0]?.previousRevision).toBeUndefined();
  });
});
