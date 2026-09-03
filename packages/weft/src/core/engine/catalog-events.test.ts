import { describe, expect, it } from 'bun:test';

import type { WorkflowCatalogActivePointer } from '../catalog/index.ts';
import {
  WorkflowRevisionActivatedEvent,
  WorkflowRevisionDrainingEvent,
  WorkflowRevisionInstalledEvent,
} from '../events/catalog-events.ts';
import { dispatchCatalogInstallAndActivatedEvents } from './catalog-events.ts';
import { Engine } from './index.ts';

function pointer(revision: string, generation: number): WorkflowCatalogActivePointer {
  return { revision, generation, activatedAt: Date.now() };
}

describe('dispatchCatalogInstallAndActivatedEvents', () => {
  it('first-ever activation: fires installed and activated (no draining), previousRevision undefined', async () => {
    await using engine = new Engine({ backgroundTasks: 'manual' });
    const installed: WorkflowRevisionInstalledEvent[] = [];
    const activated: WorkflowRevisionActivatedEvent[] = [];
    const draining: WorkflowRevisionDrainingEvent[] = [];
    engine.addEventListener(WorkflowRevisionInstalledEvent.type, (e) => installed.push(e));
    engine.addEventListener(WorkflowRevisionActivatedEvent.type, (e) => activated.push(e));
    engine.addEventListener(WorkflowRevisionDrainingEvent.type, (e) => draining.push(e));

    dispatchCatalogInstallAndActivatedEvents(
      engine,
      'checkout',
      'r1',
      false,
      null,
      pointer('r1', 1),
    );

    expect(installed).toHaveLength(1);
    expect(installed[0]?.workflowType).toBe('checkout');
    expect(installed[0]?.revision).toBe('r1');
    expect(draining).toHaveLength(0);
    expect(activated).toHaveLength(1);
    expect(activated[0]?.revision).toBe('r1');
    expect(activated[0]?.generation).toBe(1);
    expect(activated[0]?.previousRevision).toBeUndefined();
  });

  it('new revision replacing an active one: fires installed, draining(old), activated(new) with previousRevision set', async () => {
    await using engine = new Engine({ backgroundTasks: 'manual' });
    const installed: WorkflowRevisionInstalledEvent[] = [];
    const activated: WorkflowRevisionActivatedEvent[] = [];
    const draining: WorkflowRevisionDrainingEvent[] = [];
    engine.addEventListener(WorkflowRevisionInstalledEvent.type, (e) => installed.push(e));
    engine.addEventListener(WorkflowRevisionActivatedEvent.type, (e) => activated.push(e));
    engine.addEventListener(WorkflowRevisionDrainingEvent.type, (e) => draining.push(e));

    dispatchCatalogInstallAndActivatedEvents(
      engine,
      'checkout',
      'r2',
      false,
      pointer('r1', 1),
      pointer('r2', 2),
    );

    expect(installed).toHaveLength(1);
    expect(installed[0]?.revision).toBe('r2');
    expect(draining).toHaveLength(1);
    expect(draining[0]?.revision).toBe('r1');
    expect(activated).toHaveLength(1);
    expect(activated[0]?.revision).toBe('r2');
    expect(activated[0]?.generation).toBe(2);
    expect(activated[0]?.previousRevision).toBe('r1');
  });

  it('byte-identical no-op reactivation: no installed event (content not new), no activated/draining', async () => {
    await using engine = new Engine({ backgroundTasks: 'manual' });
    const installed: WorkflowRevisionInstalledEvent[] = [];
    const activated: WorkflowRevisionActivatedEvent[] = [];
    const draining: WorkflowRevisionDrainingEvent[] = [];
    engine.addEventListener(WorkflowRevisionInstalledEvent.type, (e) => installed.push(e));
    engine.addEventListener(WorkflowRevisionActivatedEvent.type, (e) => activated.push(e));
    engine.addEventListener(WorkflowRevisionDrainingEvent.type, (e) => draining.push(e));

    dispatchCatalogInstallAndActivatedEvents(
      engine,
      'checkout',
      'r1',
      true,
      pointer('r1', 1),
      pointer('r1', 1),
    );

    expect(installed).toHaveLength(0);
    expect(draining).toHaveLength(0);
    expect(activated).toHaveLength(0);
  });

  it('reinstall of already-durably-present content: no installed event, but activation still fires when the pointer moves', async () => {
    await using engine = new Engine({ backgroundTasks: 'manual' });
    const installed: WorkflowRevisionInstalledEvent[] = [];
    const activated: WorkflowRevisionActivatedEvent[] = [];
    engine.addEventListener(WorkflowRevisionInstalledEvent.type, (e) => installed.push(e));
    engine.addEventListener(WorkflowRevisionActivatedEvent.type, (e) => activated.push(e));

    dispatchCatalogInstallAndActivatedEvents(
      engine,
      'checkout',
      'r2',
      true,
      pointer('r1', 1),
      pointer('r2', 2),
    );

    expect(installed).toHaveLength(0);
    expect(activated).toHaveLength(1);
    expect(activated[0]?.revision).toBe('r2');
  });
});
