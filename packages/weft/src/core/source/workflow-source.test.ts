import { describe, expect, it, mock } from 'bun:test';

import { workflowSource } from './workflow-source.ts';

// Typed `Record<string, unknown>` rather than `{}` so `TExportName extends
// keyof TModule & string` accepts an arbitrary key like `'checkout'` — these
// are runtime unit tests for `workflowSource()`'s own behavior, not the
// literal-import type-inference suite (that's `workflow-source.test-d.ts`),
// so a loosely-typed loader is the right fixture here.
function emptyLoader() {
  return mock(async (): Promise<Record<string, unknown>> => ({}));
}

describe('workflowSource()', () => {
  it('defaults descriptor.kind to "module"', () => {
    const loader = emptyLoader();
    const source = workflowSource(
      { name: 'checkout', location: './checkout.ts', exportName: 'checkout', revision: 'r1' },
      loader,
    );
    expect(source.descriptor.kind).toBe('module');
  });

  it('produces a plain, serializable descriptor with no function properties', () => {
    const loader = emptyLoader();
    const source = workflowSource(
      { name: 'checkout', location: './checkout.ts', exportName: 'checkout', revision: 'r1' },
      loader,
    );
    for (const value of Object.values(source.descriptor)) {
      expect(typeof value).not.toBe('function');
    }
    expect(() => JSON.stringify(source.descriptor)).not.toThrow();
  });

  it('never invokes the loader itself', () => {
    const loader = emptyLoader();
    workflowSource(
      { name: 'checkout', location: './checkout.ts', exportName: 'checkout', revision: 'r1' },
      loader,
    );
    expect(loader).not.toHaveBeenCalled();
  });

  it('stores the loader by identity, not wrapped', () => {
    const loader = emptyLoader();
    const source = workflowSource(
      { name: 'checkout', location: './checkout.ts', exportName: 'checkout', revision: 'r1' },
      loader,
    );
    expect(source.load).toBe(loader);
  });

  it('calls the loader with zero arguments when later invoked', () => {
    const loader = emptyLoader();
    const source = workflowSource(
      { name: 'checkout', location: './checkout.ts', exportName: 'checkout', revision: 'r1' },
      loader,
    );
    void source.load();
    expect(loader).toHaveBeenCalledWith();
  });

  it('carries descriptor.location verbatim — never reads or concatenates it', () => {
    const loader = emptyLoader();
    const location = './workflows/checkout.ts?should-not-be-mutated';
    const source = workflowSource(
      { name: 'checkout', location, exportName: 'checkout', revision: 'r1' },
      loader,
    );
    expect(source.descriptor.location).toBe(location);
  });

  it('omits optional workflowVersion/contractHash when not supplied', () => {
    const loader = emptyLoader();
    const source = workflowSource(
      { name: 'checkout', location: './checkout.ts', exportName: 'checkout', revision: 'r1' },
      loader,
    );
    expect('workflowVersion' in source.descriptor).toBe(false);
    expect('contractHash' in source.descriptor).toBe(false);
  });

  it('carries optional workflowVersion/contractHash verbatim when supplied', () => {
    const loader = emptyLoader();
    const source = workflowSource(
      {
        name: 'checkout',
        location: './checkout.ts',
        exportName: 'checkout',
        revision: 'r1',
        workflowVersion: '2.0.0',
        contractHash: 'sha256:abc',
      },
      loader,
    );
    expect(source.descriptor.workflowVersion).toBe('2.0.0');
    expect(source.descriptor.contractHash).toBe('sha256:abc');
  });

  it('freezes the returned handle and its descriptor', () => {
    const loader = emptyLoader();
    const source = workflowSource(
      { name: 'checkout', location: './checkout.ts', exportName: 'checkout', revision: 'r1' },
      loader,
    );
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.descriptor)).toBe(true);
  });

  it('respects an explicitly supplied kind rather than always defaulting', () => {
    const loader = emptyLoader();
    const source = workflowSource(
      {
        kind: 'module',
        name: 'checkout',
        location: './checkout.ts',
        exportName: 'checkout',
        revision: 'r1',
      },
      loader,
    );
    expect(source.descriptor.kind).toBe('module');
  });
});
