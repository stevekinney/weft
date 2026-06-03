/**
 * Guards the test preload's no-auth warning filter (`tests/test-preload.ts`).
 *
 * The preload drops `console.warn` calls containing a stable substring of the
 * no-auth posture warning so the hundreds of bare `serve()` calls across the
 * server suites don't flood test output. This test pins that substring against
 * the real production constant (so a reworded warning fails loudly instead of
 * slipping past the filter) and confirms the filter logic suppresses the
 * no-auth warning while letting unrelated warnings through.
 */
import { describe, expect, it } from 'bun:test';

import { NO_AUTHENTICATION_WARNING } from '../src/server/serve-internals.ts';

// Keep in sync with `NO_AUTHENTICATION_WARNING_FRAGMENT` in tests/test-preload.ts.
const FILTER_FRAGMENT = 'server started with NO authentication';

/**
 * Re-create the preload's filter around a controllable sink so we can assert its
 * behavior without reaching through the preload's closure over the real
 * `console.warn`. Mirrors the wrapper in `tests/test-preload.ts` — keep in sync.
 */
function makeFilteredWarn(sink: (...args: unknown[]) => void) {
  return (...args: unknown[]): void => {
    if (typeof args[0] === 'string' && args[0].includes(FILTER_FRAGMENT)) {
      return;
    }
    sink(...args);
  };
}

describe('auth-warning test filter', () => {
  it('matches a substring actually present in the production warning', () => {
    // Drift guard: if the production warning is reworded so it no longer
    // contains this fragment, the preload filter would silently stop matching
    // and the noise would return. Fail loudly instead.
    expect(NO_AUTHENTICATION_WARNING).toContain(FILTER_FRAGMENT);
  });

  it('drops the no-auth warning and forwards everything else', () => {
    const forwarded: unknown[][] = [];
    const warn = makeFilteredWarn((...args) => forwarded.push(args));

    warn(NO_AUTHENTICATION_WARNING);
    warn('an unrelated warning that must survive');
    warn('another with a structured payload', { detail: true });
    warn(42); // non-string first arg must pass through untouched

    expect(forwarded).toEqual([
      ['an unrelated warning that must survive'],
      ['another with a structured payload', { detail: true }],
      [42],
    ]);
  });
});
