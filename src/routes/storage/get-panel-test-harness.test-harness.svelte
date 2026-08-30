<script lang="ts">
  /** Test-only harness providing the `QueryClientProvider` context `<GetPanel>` needs. Never imported by production code. */
  import type { HttpClient } from '@lostgradient/weft/client';

  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';

  import GetPanel from './get-panel.svelte';

  interface GetPanelTestHarnessProps {
    client: HttpClient;
  }

  let { client }: GetPanelTestHarnessProps = $props();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
</script>

<QueryClientProvider client={queryClient}>
  <GetPanel {client} />
</QueryClientProvider>
