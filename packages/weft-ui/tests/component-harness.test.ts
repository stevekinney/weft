/**
 * Proving test for the component-test harness (plan §11.2, T0.1). Mounts a
 * Cinder component through `@testing-library/svelte` to confirm the Bun
 * Svelte-compile plugin + happy-dom preload (`tests/setup.ts`) work
 * end-to-end before any track starts writing real component tests against
 * this harness.
 *
 * Uses `render()`'s own bound query methods rather than the `screen`
 * singleton: `@testing-library/dom`'s `screen` object decides once, at ITS
 * OWN module-evaluation time, whether a global `document.body` is
 * available — and under this Bun version, `bun:test` ships its own native
 * `document`/DOM globals ahead of any preload or test-file code running, so
 * that module can end up evaluated (and its throwing stub permanently baked
 * in) before `document.body` is actually ready. `render()`'s returned query
 * methods are bound directly to the container it just mounted, with no such
 * module-load-order hazard — prefer them over `screen` in this harness.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { Button } from '@lostgradient/cinder';

describe('component test harness', () => {
  test('mounts a Cinder Button and renders its label', async () => {
    const { getByRole } = render(Button, { props: { label: 'Click me' } });

    expect(getByRole('button', { name: 'Click me' })).not.toBeNull();
  });
});
