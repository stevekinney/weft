/**
 * Unit tests for `source-load-diagnostics-view.ts` (WFT-116) — the pure
 * `weft.catalog.diagnostics` → render-ready mapping, exercised without a
 * DOM. Covers the runtime guard's accept/reject surface (every field, both
 * optionals, present-but-wrong-typed), the dynamic/not-dynamic split, and
 * every bounded state/category label including the unrecognized fallbacks.
 */
import { describe, expect, it } from 'bun:test';

import {
  failureCategoryDescription,
  isCatalogDiagnosticsLike,
  isSourceLoadInFlight,
  KNOWN_FAILURE_CATEGORIES,
  KNOWN_SOURCE_LOAD_STATES,
  sourceLoadStateDescription,
  sourceLoadStateLabel,
  sourceLoadStateTone,
  summarizeSourceLoad,
  type CatalogDiagnosticsLike,
} from './source-load-diagnostics-view.ts';

function diagnostics(overrides: Partial<CatalogDiagnosticsLike> = {}): CatalogDiagnosticsLike {
  return {
    name: 'dynamic-invoice',
    revision: 'r1',
    installed: true,
    active: false,
    ...overrides,
  };
}

function source(
  overrides: Partial<NonNullable<CatalogDiagnosticsLike['source']>> = {},
): NonNullable<CatalogDiagnosticsLike['source']> {
  return {
    kind: 'module',
    requestedRevision: 'r1',
    state: 'ready',
    waiterCount: 0,
    ...overrides,
  };
}

describe('isCatalogDiagnosticsLike', () => {
  it('accepts a minimal response with no source block', () => {
    expect(isCatalogDiagnosticsLike(diagnostics())).toBe(true);
  });

  it('accepts a response whose source block carries both optional fields', () => {
    expect(
      isCatalogDiagnosticsLike(
        diagnostics({
          source: source({ state: 'failed', loadDurationMs: 12, lastFailureCategory: 'resource' }),
        }),
      ),
    ).toBe(true);
  });

  it('rejects null, primitives, and arrays outright', () => {
    expect(isCatalogDiagnosticsLike(null)).toBe(false);
    expect(isCatalogDiagnosticsLike(42)).toBe(false);
    expect(isCatalogDiagnosticsLike('r1')).toBe(false);
    expect(isCatalogDiagnosticsLike(undefined)).toBe(false);
    expect(isCatalogDiagnosticsLike([])).toBe(false);
  });

  it.each([
    ['name', { name: 1 }],
    ['revision', { revision: 1 }],
    ['installed', { installed: 'yes' }],
    ['active', { active: 'no' }],
  ])('rejects a response whose %s has the wrong type', (_field, override) => {
    expect(isCatalogDiagnosticsLike({ ...diagnostics(), ...override })).toBe(false);
  });

  it.each([
    ['kind', { kind: 1 }],
    ['requestedRevision', { requestedRevision: 1 }],
    ['state', { state: 1 }],
    ['waiterCount', { waiterCount: '0' }],
  ])('rejects a source block whose %s has the wrong type', (_field, override) => {
    expect(
      isCatalogDiagnosticsLike(diagnostics({ source: { ...source(), ...override } as never })),
    ).toBe(false);
  });

  it('rejects a source block that is not an object', () => {
    expect(isCatalogDiagnosticsLike({ ...diagnostics(), source: 'module' })).toBe(false);
    expect(isCatalogDiagnosticsLike({ ...diagnostics(), source: null })).toBe(false);
  });

  it('rejects a present-but-wrong-typed loadDurationMs rather than treating it as absent', () => {
    expect(
      isCatalogDiagnosticsLike(
        diagnostics({ source: { ...source(), loadDurationMs: 'fast' } as never }),
      ),
    ).toBe(false);
  });

  it('rejects a present-but-wrong-typed lastFailureCategory rather than treating it as absent', () => {
    expect(
      isCatalogDiagnosticsLike(
        diagnostics({ source: { ...source(), lastFailureCategory: 7 } as never }),
      ),
    ).toBe(false);
  });
});

describe('summarizeSourceLoad', () => {
  it('reports an installed revision with no dynamic source, claiming nothing about how it got there', () => {
    const summary = summarizeSourceLoad(diagnostics({ installed: true }));
    expect(summary.kind).toBe('not-dynamic');
    if (summary.kind !== 'not-dynamic') throw new Error('expected not-dynamic');
    expect(summary.installed).toBe(true);
    expect(summary.message).toContain('No dynamic source is registered');
    expect(summary.message).toContain('installed in the catalog');
    // `weft.catalog.diagnostics` cannot tell an eagerly registered revision
    // from one installed via `weft.workflows.revisions.install`, so this copy
    // must never claim either.
    expect(summary.message).not.toContain('eager');
  });

  it('distinguishes a key that is neither dynamic nor installed', () => {
    const summary = summarizeSourceLoad(diagnostics({ installed: false }));
    if (summary.kind !== 'not-dynamic') throw new Error('expected not-dynamic');
    expect(summary.installed).toBe(false);
    expect(summary.message).toContain('not installed');
  });

  it('maps a ready source to its full meta grid', () => {
    const summary = summarizeSourceLoad(
      diagnostics({ source: source({ state: 'ready', loadDurationMs: 1_500, waiterCount: 0 }) }),
    );
    if (summary.kind !== 'dynamic') throw new Error('expected dynamic');
    expect(summary.stateLabel).toBe('Ready');
    expect(summary.tone).toBe('positive');
    expect(summary.lastFailureCategory).toBeUndefined();
    expect(summary.meta.map((item) => item.term)).toEqual([
      'Source kind',
      'Requested revision',
      'Load duration',
      'Waiters',
      'Last failure',
    ]);
    expect(summary.meta[2]?.value).toBe('1s');
    expect(summary.meta[3]?.value).toBe('0 callers waiting');
    expect(summary.meta[4]?.value).toBe('None recorded');
  });

  it('renders an absent load duration as "Not loaded yet" for an idle source, never as zero', () => {
    const summary = summarizeSourceLoad(diagnostics({ source: source({ state: 'idle' }) }));
    if (summary.kind !== 'dynamic') throw new Error('expected dynamic');
    expect(summary.meta[2]?.value).toBe('Not loaded yet');
    expect(summary.tone).toBe('neutral');
  });

  it('renders an absent load duration as "In flight" while loading', () => {
    const summary = summarizeSourceLoad(
      diagnostics({ source: source({ state: 'loading', waiterCount: 1 }) }),
    );
    if (summary.kind !== 'dynamic') throw new Error('expected dynamic');
    expect(summary.meta[2]?.value).toBe('In flight');
    expect(summary.meta[3]?.value).toBe('1 caller waiting');
    expect(summary.tone).toBe('progress');
  });

  it('surfaces a bounded failure category with its explanatory copy', () => {
    const summary = summarizeSourceLoad(
      diagnostics({
        source: source({ state: 'failed', lastFailureCategory: 'timeout', loadDurationMs: 30_000 }),
      }),
    );
    if (summary.kind !== 'dynamic') throw new Error('expected dynamic');
    expect(summary.tone).toBe('attention');
    expect(summary.lastFailureCategory).toBe('timeout');
    expect(summary.lastFailureDescription).toBe('The load exceeded its time budget.');
    expect(summary.meta[4]?.value).toBe('timeout');
  });

  it('renders an unrecognized failure category without inventing copy for it', () => {
    const summary = summarizeSourceLoad(
      diagnostics({ source: source({ state: 'failed', lastFailureCategory: 'quantum' }) }),
    );
    if (summary.kind !== 'dynamic') throw new Error('expected dynamic');
    expect(summary.lastFailureCategory).toBe('quantum');
    expect(summary.lastFailureDescription).toBeUndefined();
  });

  it('renders an unrecognized state as its raw value with no description and a neutral tone', () => {
    const summary = summarizeSourceLoad(diagnostics({ source: source({ state: 'evicted' }) }));
    if (summary.kind !== 'dynamic') throw new Error('expected dynamic');
    expect(summary.stateLabel).toBe('evicted');
    expect(summary.stateDescription).toBeUndefined();
    expect(summary.tone).toBe('neutral');
  });

  it('carries the source kind and requested revision through verbatim', () => {
    const summary = summarizeSourceLoad(
      diagnostics({ source: source({ kind: 'module', requestedRevision: 'candidate-9' }) }),
    );
    if (summary.kind !== 'dynamic') throw new Error('expected dynamic');
    expect(summary.sourceKind).toBe('module');
    expect(summary.requestedRevision).toBe('candidate-9');
    expect(summary.meta[1]?.title).toBe('candidate-9');
  });
});

describe('label tables', () => {
  it.each([...KNOWN_SOURCE_LOAD_STATES])('labels and describes the %s state', (state) => {
    expect(sourceLoadStateLabel(state)).not.toBe(state);
    expect(sourceLoadStateDescription(state)).toBeDefined();
    expect(sourceLoadStateTone(state)).toBeDefined();
  });

  it.each([...KNOWN_FAILURE_CATEGORIES])('describes the %s failure category', (category) => {
    expect(failureCategoryDescription(category)).toBeDefined();
  });

  it('falls back honestly for unrecognized values', () => {
    expect(sourceLoadStateLabel('warp')).toBe('warp');
    expect(sourceLoadStateDescription('warp')).toBeUndefined();
    expect(failureCategoryDescription('warp')).toBeUndefined();
    expect(sourceLoadStateTone('warp')).toBe('neutral');
  });
});

describe('isSourceLoadInFlight', () => {
  it('is true only for a dynamic source that is actively loading', () => {
    expect(
      isSourceLoadInFlight(
        summarizeSourceLoad(diagnostics({ source: source({ state: 'loading' }) })),
      ),
    ).toBe(true);
  });

  it.each(['idle', 'ready', 'failed', 'cancelled'])('is false for the %s state', (state) => {
    expect(
      isSourceLoadInFlight(summarizeSourceLoad(diagnostics({ source: source({ state }) }))),
    ).toBe(false);
  });

  it('is false when there is no dynamic source at all', () => {
    expect(isSourceLoadInFlight(summarizeSourceLoad(diagnostics()))).toBe(false);
  });
});
