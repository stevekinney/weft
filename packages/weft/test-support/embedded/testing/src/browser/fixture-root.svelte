<!--
  Root of every fixture a browser-fixture host mounts. It runs the host's `provideContext` while it
  initializes, so whatever context that publishes (the Cinder hosts publish the full-registry code
  highlighter) reaches the fixture, and renders `component` with `componentProps`, adding no element
  of its own.
-->
<script lang="ts">
  import type { Component } from 'svelte';

  type Props = {
    component: Component<any>;
    componentProps: Record<string, any>;
    provideContext?: () => void;
  };

  const props: Props = $props();

  // Context is published once, while the root initializes, so the initial value is the one meant.
  // svelte-ignore state_referenced_locally
  props.provideContext?.();

  const Child = $derived(props.component);
</script>

<Child {...props.componentProps} />
