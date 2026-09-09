import { describe, expect, it } from 'bun:test';

import { ActivityRegistry } from '../activity-registry.ts';
import { copyWorkflowDefinition } from '../engine/construction.ts';
import { Engine } from '../engine/index.ts';
import { buildRegistrationEntry } from '../engine/registration.ts';
import {
  buildOneWorkflowManifest,
  buildWorkflowManifestFromDefinition,
} from '../registry-workflow-manifest.ts';
import { workflow, type WorkflowDefinition } from '../types.ts';
import type { WorkflowSourceDescriptor } from './types.ts';
import { validateResolvedWorkflowSource } from './validate.ts';

function descriptorFor(
  overrides: Partial<WorkflowSourceDescriptor> &
    Pick<WorkflowSourceDescriptor, 'name' | 'revision'>,
): WorkflowSourceDescriptor {
  return {
    kind: 'module',
    location: './checkout.ts',
    exportName: 'checkout',
    ...overrides,
  };
}

const checkoutDefinition = workflow({ name: 'checkout' }).execute(async function* (
  _ctx,
  input: { orderId: string },
) {
  return { shipped: true, orderId: input.orderId };
});

async function actualCheckoutManifest() {
  // Widen to the general `WorkflowDefinition` shape — the same widening a
  // real caller gets for free by routing through `unknown` first
  // (`engine.register(definition: unknown)`), applied explicitly here.
  const definition = checkoutDefinition as WorkflowDefinition;
  const entry = buildRegistrationEntry(definition.name, definition);
  const registered = copyWorkflowDefinition(definition.name, entry);
  const registry = new ActivityRegistry();
  return buildWorkflowManifestFromDefinition(registered, registry.listDefinitions());
}

describe('validateResolvedWorkflowSource()', () => {
  it('rejects a moduleValue that is not a plain record with missing-export', async () => {
    const outcome = await validateResolvedWorkflowSource(
      descriptorFor({ name: 'checkout', revision: 'r1' }),
      'not a module object',
    );
    expect(outcome).toEqual({ ok: false, reasons: ['missing-export'] });
  });

  it('rejects when the named export is absent with missing-export', async () => {
    const outcome = await validateResolvedWorkflowSource(
      descriptorFor({ name: 'checkout', revision: 'r1', exportName: 'checkout' }),
      { somethingElse: checkoutDefinition },
    );
    expect(outcome).toEqual({ ok: false, reasons: ['missing-export'] });
  });

  it('rejects an export that is itself a module namespace object with ambiguous-export', async () => {
    const namespaceObject: Record<string, unknown> = { bar: 2 };
    Object.setPrototypeOf(namespaceObject, null);
    // Simulate `Object.prototype.toString.call` reporting `[object Module]`,
    // as a real ES module namespace object does (verified empirically
    // against Bun's own `import()` — see the batch's implementation notes).
    Object.defineProperty(namespaceObject, Symbol.toStringTag, {
      value: 'Module',
      configurable: false,
    });
    const outcome = await validateResolvedWorkflowSource(
      descriptorFor({ name: 'checkout', revision: 'r1', exportName: 'ns' }),
      { ns: namespaceObject },
    );
    expect(outcome).toEqual({ ok: false, reasons: ['ambiguous-export'] });
  });

  it('rejects a hand-rolled { name, handler } export (removed bare-handler shape) with invalid-definition', async () => {
    const bareHandlerExport = {
      name: 'bareHandler',
      handler: async function* bareHandler() {
        return undefined;
      },
    };
    const outcome = await validateResolvedWorkflowSource(
      descriptorFor({ name: 'bareHandler', revision: 'r1', exportName: 'bareHandler' }),
      { bareHandler: bareHandlerExport },
    );
    expect(outcome).toEqual({ ok: false, reasons: ['invalid-definition'] });
  });

  it('rejects a builder-shaped export whose activities field is an array or Map, not a plain record, with invalid-definition', async () => {
    // A bare `typeof value === 'object' && value !== null` check also
    // accepts an array, `Map`, `Date`, or other exotic-prototype value —
    // `Object.values(new Map(...))` is empty, so validation would otherwise
    // successfully install a manifest that silently omits the source's
    // intended activities instead of being rejected.
    const arrayActivitiesExport = {
      name: 'arrayActivities',
      handler: async function* arrayActivities() {
        return undefined;
      },
      activities: [],
      signals: {},
      updates: {},
      queries: {},
      searchAttributes: {},
    };
    const outcomeArray = await validateResolvedWorkflowSource(
      descriptorFor({ name: 'arrayActivities', revision: 'r1', exportName: 'arrayActivities' }),
      { arrayActivities: arrayActivitiesExport },
    );
    expect(outcomeArray).toEqual({ ok: false, reasons: ['invalid-definition'] });

    const mapActivitiesExport = {
      name: 'mapActivities',
      handler: async function* mapActivities() {
        return undefined;
      },
      activities: new Map([['doStuff', { execute: async () => undefined }]]),
      signals: {},
      updates: {},
      queries: {},
      searchAttributes: {},
    };
    const outcomeMap = await validateResolvedWorkflowSource(
      descriptorFor({ name: 'mapActivities', revision: 'r1', exportName: 'mapActivities' }),
      { mapActivities: mapActivitiesExport },
    );
    expect(outcomeMap).toEqual({ ok: false, reasons: ['invalid-definition'] });
  });

  it('rejects a builder-shaped export whose handler is not callable with invalid-definition', async () => {
    // All five builder-produced object maps are present, so
    // `isBuilderWorkflowDefinition()`'s structural check alone would
    // pass — only an explicit `typeof handler === 'function'` check
    // catches a `handler` that was replaced with something non-callable
    // (`null` here) rather than dropped or omitted entirely.
    const nonCallableHandlerExport = {
      name: 'nonCallableHandler',
      handler: null,
      activities: {},
      signals: {},
      updates: {},
      queries: {},
      searchAttributes: {},
    };
    const outcome = await validateResolvedWorkflowSource(
      descriptorFor({
        name: 'nonCallableHandler',
        revision: 'r1',
        exportName: 'nonCallableHandler',
      }),
      { nonCallableHandler: nonCallableHandlerExport },
    );
    expect(outcome).toEqual({ ok: false, reasons: ['invalid-definition'] });
  });

  it('rejects a builder-shaped export with a malformed activity name with invalid-definition', async () => {
    const malformedExport = {
      name: 'malformedActivities',
      handler: async function* malformedActivities() {
        return undefined;
      },
      activities: { bad: { name: 'not a valid name!', execute: async () => undefined } },
      signals: {},
      updates: {},
      queries: {},
      searchAttributes: {},
    };
    const outcome = await validateResolvedWorkflowSource(
      descriptorFor({
        name: 'malformedActivities',
        revision: 'r1',
        exportName: 'malformedActivities',
      }),
      { malformedActivities: malformedExport },
    );
    expect(outcome).toEqual({ ok: false, reasons: ['invalid-definition'] });
  });

  it('rejects a definition whose version exceeds the hostile-input identifier limit with manifest-build-failed', async () => {
    const oversizedVersionDefinition = workflow({
      name: 'oversizedVersion',
      version: 'x'.repeat(600),
    }).execute(async function* () {
      return undefined;
    });
    const outcome = await validateResolvedWorkflowSource(
      descriptorFor({ name: 'oversizedVersion', revision: 'r1', exportName: 'oversizedVersion' }),
      { oversizedVersion: oversizedVersionDefinition },
    );
    expect(outcome).toEqual({ ok: false, reasons: ['manifest-build-failed'] });
  });

  it('rejects a name mismatch between the descriptor and the loaded definition', async () => {
    const outcome = await validateResolvedWorkflowSource(
      descriptorFor({ name: 'somethingElse', revision: 'r1', exportName: 'checkout' }),
      { checkout: checkoutDefinition },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reasons).toContain('name-mismatch');
    }
  });

  it('rejects an artifact-revision mismatch between the descriptor and the derived revision', async () => {
    const outcome = await validateResolvedWorkflowSource(
      descriptorFor({
        name: 'checkout',
        revision: 'definitely-the-wrong-revision',
        exportName: 'checkout',
      }),
      { checkout: checkoutDefinition },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reasons).toContain('artifact-revision-mismatch');
    }
  });

  it('rejects an incompatible pinned workflowVersion', async () => {
    const actual = await actualCheckoutManifest();
    const outcome = await validateResolvedWorkflowSource(
      descriptorFor({
        name: 'checkout',
        revision: actual.revision,
        exportName: 'checkout',
        workflowVersion: '99.99.99',
      }),
      { checkout: checkoutDefinition },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reasons).toContain('workflow-version-incompatible');
    }
  });

  it('rejects a wrong pinned contractHash', async () => {
    const actual = await actualCheckoutManifest();
    const outcome = await validateResolvedWorkflowSource(
      descriptorFor({
        name: 'checkout',
        revision: actual.revision,
        exportName: 'checkout',
        contractHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      }),
      { checkout: checkoutDefinition },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reasons).toContain('contract-hash-mismatch');
    }
  });

  it('accepts a matching descriptor and produces a manifest byte-identical to the eager registration path', async () => {
    const actual = await actualCheckoutManifest();

    const outcome = await validateResolvedWorkflowSource(
      descriptorFor({ name: 'checkout', revision: actual.revision, exportName: 'checkout' }),
      { checkout: checkoutDefinition },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    await using engine = new Engine();
    engine.register(checkoutDefinition);
    const eagerManifest = await buildOneWorkflowManifest(
      engine,
      engine.getWorkflowDefinition('checkout')!,
    );

    expect(outcome.manifest).toEqual(eagerManifest);
    expect(outcome.manifest).toEqual(actual);
  });
});
