<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query';

  /**
   * `createQuery()` must run in a descendant of `QueryClientProvider` — the
   * provider sets Svelte context in its own component initialization, which
   * only becomes visible to components rendered as its children, not to
   * script that runs before its own markup mounts. This tiny leaf keeps
   * `tanstack-query-smoke.svelte` an accurate reflection of how every real
   * route component will use the pattern (provider at the shell, `createQuery`
   * in the route/data-consuming component below it).
   *
   * A PLAIN OPTIONS OBJECT, not `() => ({...})` — see README "Toolchain
   * decisions" for why the getter-function form silently breaks the query
   * (empirically verified while building this smoke test, not asserted from
   * the docs). `StoreOrVal<T> = T | Readable<T>`: `createQuery` accepts a
   * plain value OR a real Svelte `Readable`/`derived` store, never a
   * callback — passing a function makes the function ITSELF the "options"
   * value, so `queryKey`/`queryFn` read as `undefined` and the query sits at
   * `pending` forever with no error.
   */
  const query = createQuery({
    queryKey: ['smoke-test'],
    queryFn: async () => 'tanstack-query-ok',
  });
</script>

<p data-testid="status">{$query.status}</p>
<p data-testid="data">{$query.data ?? ''}</p>
