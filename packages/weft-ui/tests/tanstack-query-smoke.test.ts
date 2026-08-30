/**
 * Proving test (plan §2, T0.1 — package.json step 1: "verify Svelte 5
 * compatibility after install with a smoke component ... record which in
 * README"). `@tanstack/svelte-query` v5's Svelte-5 support is via its
 * store contract, not the v6 runes-native rewrite — see README "Toolchain
 * decisions". This mounts `tanstack-query-smoke.svelte`, which drives a
 * real `createQuery()` call through `QueryClientProvider`, and asserts the
 * documented `createQuery(() => ({...})); $query.data` pattern actually
 * resolves data under Svelte 5 runes mode, rather than only type-checking.
 */
import { render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import TanstackQuerySmoke from './tanstack-query-smoke.svelte';

describe('TanStack Query v5 store-API smoke test', () => {
  test('createQuery resolves data and the $query store updates the DOM', async () => {
    const { getByTestId } = render(TanstackQuerySmoke);

    await waitFor(() => {
      expect(getByTestId('data').textContent).toBe('tanstack-query-ok');
    });
    expect(getByTestId('status').textContent).toBe('success');
  });
});
