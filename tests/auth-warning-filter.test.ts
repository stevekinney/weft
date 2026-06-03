/**
 * Guards the test preload's no-auth warning filter (`tests/test-preload.ts`).
 *
 * The preload drops `console.warn` calls containing a stable substring of the
 * no-auth posture warning so the hundreds of bare `serve()` calls across the
 * server suites don't flood test output. This test pins that substring against
 * the real production constant (so a reworded warning fails loudly instead of
 * slipping past the filter) and confirms the actual installed predicate
 * suppresses the no-auth warning while letting unrelated warnings through.
 */
import { describe, expect, it } from 'bun:test';

import { NO_AUTHENTICATION_WARNING } from '../src/server/serve-internals.ts';
// Import the exact predicate and fragment the preload installs (not copies), so
// the guards below pin the real installed filter against the production text.
import {
  NO_AUTHENTICATION_WARNING_FRAGMENT as FILTER_FRAGMENT,
  isSuppressedAuthWarning,
} from './test-preload.ts';

describe('auth-warning test filter', () => {
  it('matches a substring actually present in the production warning', () => {
    // Drift guard: if the production warning is reworded so it no longer
    // contains this fragment, the preload filter would silently stop matching
    // and the noise would return. Fail loudly instead.
    expect(NO_AUTHENTICATION_WARNING).toContain(FILTER_FRAGMENT);
  });

  it('suppresses the no-auth warning and nothing else', () => {
    // Drive the real predicate the wrapper uses, not a copy.
    expect(isSuppressedAuthWarning([NO_AUTHENTICATION_WARNING])).toBe(true);
    expect(isSuppressedAuthWarning(['an unrelated warning that must survive'])).toBe(false);
    expect(isSuppressedAuthWarning(['structured payload', { detail: true }])).toBe(false);
    expect(isSuppressedAuthWarning([42])).toBe(false); // non-string first arg
    expect(isSuppressedAuthWarning([])).toBe(false); // no arguments
  });
});
