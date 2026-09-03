import { describe, expect, it } from 'bun:test';

import { Engine } from '../../engine.ts';
import { getInternals, getWorkflowCatalog, initializeInternals } from '../internals.ts';

describe('engine internals', () => {
  it('throws when internals are not initialized', () => {
    const fake = Object.create(Engine.prototype) as Engine;

    expect(() => getInternals(fake)).toThrow(/Engine internals not initialized/);
  });

  it('returns internals with engine field after initialization', () => {
    const fake = Object.create(Engine.prototype) as Engine;

    initializeInternals(fake);
    const internals = getInternals(fake);

    expect(internals.engine).toBe(fake);
  });

  it('gives each engine its own internals', () => {
    const engine1 = Object.create(Engine.prototype) as Engine;
    const engine2 = Object.create(Engine.prototype) as Engine;

    initializeInternals(engine1);
    initializeInternals(engine2);

    expect(getInternals(engine1)).not.toBe(getInternals(engine2));
  });

  it('getWorkflowCatalog throws a clear diagnostic when the catalog was never drained', () => {
    const fake = Object.create(Engine.prototype) as Engine;
    initializeInternals(fake);
    getInternals(fake).workflowCatalog = null;

    expect(() => getWorkflowCatalog(fake)).toThrow(/Workflow catalog not restored/);
  });
});
