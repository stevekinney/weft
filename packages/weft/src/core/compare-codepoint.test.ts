/**
 * Direct unit tests for `compareCodepoint`'s tie branch. Every call site
 * that sorts with it (`registry-snapshot.ts`'s `sortedWorkflows`/
 * `sortedActivities`, `registry-workflow-manifest.ts`'s scoped-activity
 * sort) always compares distinct, unique names, so the equal-strings branch
 * can never fire through any of them — this exercises it directly, the
 * same way `compareWorkflowManifests`'s own tie branch
 * (`registry-snapshot.test.ts`) is covered independent of engine
 * registration uniqueness.
 */
import { describe, expect, it } from 'bun:test';

import { compareCodepoint } from './compare-codepoint.ts';

describe('compareCodepoint', () => {
  it('orders by codepoint, not localeCompare', () => {
    expect(compareCodepoint('a', 'b')).toBe(-1);
    expect(compareCodepoint('b', 'a')).toBe(1);
  });

  it('returns 0 for equal strings', () => {
    expect(compareCodepoint('same', 'same')).toBe(0);
    expect(compareCodepoint('', '')).toBe(0);
  });
});
