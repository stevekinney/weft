<script lang="ts">
  /** Test-only harness providing the `QueryClientProvider` context `<KvBrowser>`'s panels need. Never imported by production code. */
  import type { HttpClient } from '@lostgradient/weft/client';

  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';

  import KvBrowser from './kv-browser.svelte';

  interface KvBrowserTestHarnessProps {
    client: HttpClient;
    conditionalBatchSupported?: boolean | undefined;
  }

  let { client, conditionalBatchSupported = undefined }: KvBrowserTestHarnessProps = $props();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
</script>

<QueryClientProvider client={queryClient}>
  <KvBrowser {client} {conditionalBatchSupported} />
</QueryClientProvider>
