<script lang="ts">
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';

  import TanstackQuerySmokeInner from './tanstack-query-smoke-inner.svelte';

  /**
   * Proving component for the TanStack Query v5 store-API decision recorded
   * in the README ("Toolchain decisions"): `createQuery({...})` returns a
   * Svelte store, read with `$query` inside a component — not the v6
   * runes-native API. This mounts the real package (not a type-only check)
   * so `tests/tanstack-query-smoke.test.ts` can assert the documented
   * pattern actually resolves data under Svelte 5. See
   * `tanstack-query-smoke-inner.svelte` for why it's a plain object, not a
   * getter function.
   */
  const queryClient = new QueryClient();
</script>

<QueryClientProvider client={queryClient}>
  <TanstackQuerySmokeInner />
</QueryClientProvider>
