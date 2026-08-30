<script lang="ts">
  /**
   * Get panel (plan §9.6; design `Weft UI.dc.html` STORAGE "stGet"):
   * exact-key lookup. Modeled as a `createMutation` rather than
   * `createQuery` — `@tanstack/svelte-query`'s Svelte adapter wraps a plain
   * (non-store) options object in `readable(options)` exactly once
   * (`createBaseQuery.js`: `isSvelteStore(options) ? options :
   * readable(options)`), so a `queryKey`/`queryFn` closing over changing
   * component state would silently stop updating after the first render —
   * `createMutation`'s `.mutate(variables)` sidesteps that entirely by
   * passing the current key explicitly on every call. This is a lookup
   * triggered once per click either way, not a resource other components
   * subscribe to, so the cache/key machinery `createQuery` exists for buys
   * nothing here.
   */
  import Button from '@lostgradient/cinder/button';
  import EmptyState from '@lostgradient/cinder/empty-state';
  import Input from '@lostgradient/cinder/input';
  import Skeleton from '@lostgradient/cinder/skeleton';
  import type { HttpClient } from '@lostgradient/weft/client';
  import { ArrowRight, Search } from 'lucide-svelte';

  import { createMutation } from '@tanstack/svelte-query';

  import { faultTreatment } from '../../lib/faults.ts';
  import { storageGet } from './storage-client.ts';
  import StorageValueDisplay from './storage-value-display.svelte';

  interface GetPanelProps {
    client: HttpClient;
  }

  let { client }: GetPanelProps = $props();

  let key = $state('');
  let queriedKey = $state<string | null>(null);

  const getMutation = createMutation(
    {
      mutationFn: (targetKey: string) => storageGet(client, targetKey),
    },
    undefined,
  );

  function runGet(): void {
    if (key.length === 0) return;
    queriedKey = key;
    $getMutation.mutate(key);
  }
</script>

<div class="weft-storage-form">
  <div class="weft-storage-field-group">
    <Input
      id="storage-get-key"
      label="Exact key"
      bind:value={key}
      class="weft-storage-monospace-input"
      onkeydown={(event) => {
        if (event.key === 'Enter') runGet();
      }}
    />
  </div>
  <Button
    label="Get"
    variant="primary"
    size="sm"
    fullWidth
    disabled={key.length === 0}
    loading={$getMutation.isPending}
    onclick={runGet}
  >
    {#snippet leadingIcon()}<ArrowRight aria-hidden="true" size={14} />{/snippet}
  </Button>
</div>

<div class="weft-storage-results">
  {#if $getMutation.isPending}
    <Skeleton height="4rem" />
  {:else if $getMutation.isError}
    <p class="weft-storage-error">{faultTreatment($getMutation.error).message}</p>
  {:else if $getMutation.isSuccess && queriedKey !== null}
    {#if $getMutation.data === null}
      <EmptyState title="Key not found" description={`No value stored at "${queriedKey}".`}>
        {#snippet icon()}<Search aria-hidden="true" size={22} />{/snippet}
      </EmptyState>
    {:else}
      <StorageValueDisplay value={$getMutation.data} label={queriedKey} />
    {/if}
  {:else}
    <EmptyState
      title="Enter a key"
      description="Type a key and press Get to look up its stored value."
    >
      {#snippet icon()}<Search aria-hidden="true" size={22} />{/snippet}
    </EmptyState>
  {/if}
</div>
