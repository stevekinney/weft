<script lang="ts">
  /**
   * Fork dialog (plan T3.3, design `Weft Patterns.dc.html` "Fork from
   * checkpoint"): `POST …/fork` (`client.fork`, public access, no scope
   * gate — verified against `weft/src/server/operations/fork-workflow.ts`),
   * success links to the new run via `forkedFrom`.
   */
  import Button from '@lostgradient/cinder/button';
  import Input from '@lostgradient/cinder/input';
  import { createMutation } from '@tanstack/svelte-query';
  import { GitFork } from 'lucide-svelte';

  import { router } from '../../../../lib/router.svelte.ts';
  import type { ForkClient } from './checkpoints-data.ts';

  interface ForkDialogProps {
    readonly client: ForkClient;
    readonly workflowId: string;
    /** Pre-fills the target step from whichever checkpoint the operator selected. */
    readonly initialStep: number;
    /** Fired with the new run's id right after a successful fork, so the Checkpoints tab can offer the divergence view. */
    readonly onForked?: (forkedWorkflowId: string) => void;
  }

  let { client, workflowId, initialStep, onForked }: ForkDialogProps = $props();

  // Intentional one-shot capture, not a bug: `checkpoints-tab.svelte` always
  // destroys and remounts this dialog (it lives behind an `{#if panel ===
  // 'fork'}` block gated by `selectCheckpoint()`, which resets `panel` to
  // 'replay' on every selection change), so a fresh instance always sees the
  // current `initialStep` at construction. Tracking it reactively here would
  // stomp the operator's in-progress edit to the target-step field whenever
  // `initialStep` happened to change out from under a still-mounted instance.
  // svelte-ignore state_referenced_locally
  let targetStepText = $state(String(initialStep));

  const forkMutation = createMutation({
    mutationFn: async (fromStep: number) => client.fork(workflowId, { fromStep }),
    onSuccess: (handle) => onForked?.(handle.id),
  });

  const parsedStep = $derived.by(() => {
    const trimmed = targetStepText.trim();
    if (trimmed.length === 0) return null;
    const value = Number(trimmed);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  });

  function submit(): void {
    if (parsedStep === null) return;
    $forkMutation.mutate(parsedStep);
  }

  function viewForkedRun(): void {
    const id = $forkMutation.data?.id;
    if (id !== undefined) router.navigate(`/workflows/${id}`);
  }
</script>

<div class="weft-fork-dialog">
  <Input
    id={`fork-target-step-${workflowId}`}
    label="Target step"
    inputmode="numeric"
    bind:value={targetStepText}
  />
  <p class="weft-fork-dialog__note">
    A new workflow is created, linked via <code>forkedFrom</code>.
  </p>

  {#if $forkMutation.isError}
    <p class="weft-fork-dialog__error">
      {$forkMutation.error instanceof Error
        ? $forkMutation.error.message
        : 'Failed to fork the workflow.'}
    </p>
  {/if}

  {#if $forkMutation.isSuccess && $forkMutation.data}
    <div class="weft-fork-dialog__success">
      <span>Forked as <code>{$forkMutation.data.id}</code></span>
      <Button variant="ghost" size="sm" label="View →" onclick={viewForkedRun} />
    </div>
  {:else}
    <Button
      variant="primary"
      size="sm"
      fullWidth
      label={$forkMutation.isPending ? 'Forking…' : 'Create fork'}
      loading={$forkMutation.isPending}
      disabled={parsedStep === null || $forkMutation.isPending}
      onclick={submit}
    >
      {#snippet leadingIcon()}
        <GitFork aria-hidden="true" size={13} />
      {/snippet}
    </Button>
  {/if}
</div>

<style>
  .weft-fork-dialog {
    background: var(--cinder-surface-raised);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-lg);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .weft-fork-dialog__note {
    margin: 0;
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-disabled);
  }

  .weft-fork-dialog__note code {
    font-family: var(--cinder-font-mono);
  }

  .weft-fork-dialog__error {
    margin: 0;
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-color-danger-fg);
  }

  .weft-fork-dialog__success {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 12px;
    background: var(--cinder-color-success-bg);
    border: 1px solid var(--cinder-color-success-border);
    border-radius: var(--cinder-radius-md);
    font-size: var(--cinder-text-sm);
  }

  .weft-fork-dialog__success code {
    font-family: var(--cinder-font-mono);
  }
</style>
