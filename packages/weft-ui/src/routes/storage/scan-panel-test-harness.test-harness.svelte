<script lang="ts">
  /** Test-only harness providing the `QueryClientProvider` context `<ScanPanel>` needs. Never imported by production code. */
  import type { HttpClient } from '@lostgradient/weft/client';

  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';

  import ScanPanel from './scan-panel.svelte';

  interface ScanPanelTestHarnessProps {
    client: HttpClient;
  }

  let { client }: ScanPanelTestHarnessProps = $props();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
</script>

<QueryClientProvider client={queryClient}>
  <ScanPanel {client} />
</QueryClientProvider>
