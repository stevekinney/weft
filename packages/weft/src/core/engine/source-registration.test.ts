import { describe, expect, it, mock } from 'bun:test';

import { Engine } from '../engine.ts';
import { workflowSource } from '../source/index.ts';
import { workflow } from '../types.ts';
import { getInternals } from './internals.ts';

function checkoutSource(revision = 'r1') {
  const loader = mock(async (): Promise<Record<string, unknown>> => ({}));
  const source = workflowSource(
    { name: 'checkout', location: './checkout.ts', exportName: 'checkout', revision },
    loader,
  );
  return { source, loader };
}

describe('engine.registerSource()', () => {
  it('records a candidate without ever invoking the loader', () => {
    const engine = new Engine();
    const { source, loader } = checkoutSource();

    engine.registerSource(source);

    expect(loader).not.toHaveBeenCalled();
    const internals = getInternals(engine);
    expect(internals.workflowSourcesByName.get('checkout')?.get('r1')).toBe(source);

    engine[Symbol.dispose]();
  });

  it('lets one eagerly-registered workflow coexist with a differently-named lazy source', () => {
    const engine = new Engine();
    const { source } = checkoutSource();

    engine.register(workflow({ name: 'eagerWorkflow' }).execute(async function* () {}));
    engine.registerSource(source);

    const internals = getInternals(engine);
    expect(internals.workflowDefinitionsByName.has('eagerWorkflow')).toBe(true);
    expect(internals.workflowSourcesByName.get('checkout')?.has('r1')).toBe(true);

    engine[Symbol.dispose]();
  });

  it('throws when the name is already eagerly registered', () => {
    const engine = new Engine();
    engine.register(workflow({ name: 'checkout' }).execute(async function* () {}));
    const { source } = checkoutSource();

    expect(() => engine.registerSource(source)).toThrow(/already registered as an eager workflow/);

    engine[Symbol.dispose]();
  });

  it('throws when the name is already eagerly registered as a plain (non-builder) WorkflowDefinition, not just a builder-produced one', () => {
    // `internals.workflowDefinitionsByName` is only populated by the
    // builder-produced branch of `engine.register()` — a hand-rolled
    // `{ name, handler }` literal (still a valid `WorkflowDefinition`; the
    // public type is structural) goes through `commitWorkflowDefinition()`
    // directly and only ever touches `internals.registrations`. The
    // collision check here must catch this shape too, or a workflow name
    // could end up simultaneously eager and a dynamic source.
    const engine = new Engine();
    engine.register({
      name: 'checkout',
      handler: async function* () {
        return undefined;
      },
    });
    const { source } = checkoutSource();

    expect(() => engine.registerSource(source)).toThrow(/already registered as an eager workflow/);

    engine[Symbol.dispose]();
  });

  it('throws when registering a source for a name already claimed by an eager registration, via commitWorkflowDefinition symmetric guard', () => {
    const engine = new Engine();
    const { source } = checkoutSource();
    engine.registerSource(source);

    expect(() =>
      engine.register(workflow({ name: 'checkout' }).execute(async function* () {})),
    ).toThrow(/already registered as a dynamic workflow source/);

    engine[Symbol.dispose]();
  });

  it('is idempotent when re-registering the identical handle reference for the same (name, revision)', () => {
    const engine = new Engine();
    const { source } = checkoutSource();

    engine.registerSource(source);
    expect(() => engine.registerSource(source)).not.toThrow();

    const internals = getInternals(engine);
    expect(internals.workflowSourcesByName.get('checkout')?.get('r1')).toBe(source);

    engine[Symbol.dispose]();
  });

  it('throws when a different handle is registered under the same (name, revision)', () => {
    const engine = new Engine();
    const { source: first } = checkoutSource();
    const { source: second } = checkoutSource();

    engine.registerSource(first);

    expect(() => engine.registerSource(second)).toThrow(
      /a different source handle is already registered/,
    );

    engine[Symbol.dispose]();
  });

  it('allows multiple different revisions of the same lazy name to coexist unresolved', () => {
    const engine = new Engine();
    const { source: revisionOne } = checkoutSource('r1');
    const { source: revisionTwo } = checkoutSource('r2');

    engine.registerSource(revisionOne);
    engine.registerSource(revisionTwo);

    const internals = getInternals(engine);
    const byRevision = internals.workflowSourcesByName.get('checkout');
    expect(byRevision?.size).toBe(2);

    engine[Symbol.dispose]();
  });
});

describe('engine.registerSource() structural validation', () => {
  // Every case below bypasses `workflowSource()`'s typed surface — a
  // hand-built handle is the only way to reach these, exactly like the
  // hostile/manually-constructed input this check exists to catch.
  it('throws when descriptor.kind is not a non-empty string', () => {
    const engine = new Engine();
    expect(() =>
      engine.registerSource({
        descriptor: {
          kind: '' as never,
          name: 'checkout',
          location: './checkout.ts',
          exportName: 'checkout',
          revision: 'r1',
        },
        load: async () => ({}),
      }),
    ).toThrow(/descriptor\.kind must be a non-empty string/);
    engine[Symbol.dispose]();
  });

  it('throws when descriptor.name is not a non-empty string', () => {
    const engine = new Engine();
    expect(() =>
      engine.registerSource({
        descriptor: {
          kind: 'module',
          name: '',
          location: './checkout.ts',
          exportName: 'checkout',
          revision: 'r1',
        },
        load: async () => ({}),
      }),
    ).toThrow(/descriptor\.name must be a non-empty string/);
    engine[Symbol.dispose]();
  });

  it('throws when descriptor.revision is not a non-empty string', () => {
    const engine = new Engine();
    expect(() =>
      engine.registerSource({
        descriptor: {
          kind: 'module',
          name: 'checkout',
          location: './checkout.ts',
          exportName: 'checkout',
          revision: '',
        },
        load: async () => ({}),
      }),
    ).toThrow(/descriptor\.revision must be a non-empty string/);
    engine[Symbol.dispose]();
  });

  it('throws when descriptor.revision exceeds the maximum identifier byte size', () => {
    const engine = new Engine();
    expect(() =>
      engine.registerSource({
        descriptor: {
          kind: 'module',
          name: 'checkout',
          location: './checkout.ts',
          exportName: 'checkout',
          revision: 'x'.repeat(513),
        },
        load: async () => ({}),
      }),
    ).toThrow(/exceeding the maximum identifier size/);
    engine[Symbol.dispose]();
  });

  it("freezes a manually-constructed handle's mutable descriptor, so a post-registration mutation of name/revision throws instead of silently retargeting the registered key", () => {
    // `workflowSource()` already returns a frozen descriptor — this can only
    // be reached by bypassing that typed surface with a hand-built handle
    // whose descriptor is a plain mutable object (still valid TypeScript,
    // since `WorkflowSourceDescriptor`'s `readonly` fields are compile-time
    // only). Without registerSource() freezing it, mutating `revision` here
    // would leave `internals.workflowSourcesByName` still indexed under the
    // ORIGINAL revision while `resolveWorkflowSource()` reads the mutated
    // descriptor off the same stored reference.
    const engine = new Engine();
    const mutableDescriptor = {
      kind: 'module' as const,
      name: 'checkout',
      location: './checkout.ts',
      exportName: 'checkout',
      revision: 'original-revision',
    };
    const source = { descriptor: mutableDescriptor, load: async () => ({}) };

    engine.registerSource(source);

    expect(() => {
      mutableDescriptor.revision = 'mutated-after-registration';
    }).toThrow(TypeError);
    expect(source.descriptor.revision).toBe('original-revision');

    const internals = getInternals(engine);
    expect(internals.workflowSourcesByName.get('checkout')?.get('original-revision')).toBe(source);
    expect(
      internals.workflowSourcesByName.get('checkout')?.get('mutated-after-registration'),
    ).toBeUndefined();

    engine[Symbol.dispose]();
  });
});
