<script lang="ts">
  /**
   * Fork dialog (plan T3.3, design `Weft Patterns.dc.html` "Fork from
   * checkpoint"): `POST …/fork` (`client.fork`, public access, no scope
   * gate — verified against `weft/src/server/operations/fork-workflow.ts`),
   * success links to the new run via `forkedFrom`.
   *
   * ## Revision picker (WFT-117)
   *
   * Default fork behavior (`ForkOptions.revision` omitted) resolves and
   * persists the SOURCE run's own `revision` — shown up front as "Retains
   * rev X" (or "Unpinned source" for a legacy run with no persisted
   * revision) so an operator sees what will happen before confirming,
   * without opening anything. A collapsed "Fork a different revision"
   * disclosure opts into an EXPLICIT revision (`ForkOptions.revision`,
   * diagnostic use) — a `Select` of installed revisions
   * (`weft.workflows.revisions.list`) when `workflows:read` is granted,
   * degrading to a free-text `Input` (with a note that the server still
   * validates it) when denied, mirroring `schedule-form-fields.svelte`'s
   * identical registry-picker degrade. `weft.workflows.fork` itself is
   * `access: { kind: 'public' }` — only the LISTING read needs the scope,
   * so an operator without `workflows:read` can still legally fork against
   * an explicit revision id they already know.
   *
   * A rejection specifically coded `WorkflowRevisionUnavailableError`
   * (`isForkRevisionConflict`, `fork-revision-picker.ts`) gets its own
   * Conflict framing, distinct from the generic error paragraph every other
   * fork failure still uses — and `forkConflictGuidance()` branches that
   * framing's recovery sentence on `selection.mode` (Codex review, PR #978):
   * a default (`'source'`) fork that failed this way means the SOURCE run's
   * OWN revision is unavailable, so pointing the operator back at "use the
   * source revision" would tell them to retry the exact thing that just
   * failed — that case routes to the explicit picker instead. An
   * `'explicit'` fork that failed keeps "use the source revision instead"
   * as real, available advice.
   */
  import Badge from '@lostgradient/cinder/badge';
  import Button from '@lostgradient/cinder/button';
  import Input from '@lostgradient/cinder/input';
  import Select from '@lostgradient/cinder/select';
  import Skeleton from '@lostgradient/cinder/skeleton';
  import Tooltip from '@lostgradient/cinder/tooltip';
  import { createMutation, createQuery } from '@tanstack/svelte-query';
  import { toStore } from 'svelte/store';
  import { ChevronDown, ChevronRight, GitFork } from 'lucide-svelte';

  import { formatRelativeTime, truncateId } from '../../../../lib/format/index.ts';
  import { queryKeys } from '../../../../lib/query.ts';
  import { getPrincipalStore, scopeGate } from '../../../../lib/scopes.svelte.ts';
  import { EAGER_REVISION_HEDGE } from '../../../../lib/workflow-revision.ts';
  import { router, workflowDetailPath } from '../../../../lib/router.svelte.ts';
  import type { ForkClient } from './checkpoints-data.ts';
  import {
    forkConflictGuidance,
    isForkRevisionConflict,
    parseInstalledRevisions,
    resolveForkOptions,
    type ForkRevisionSelection,
    type WorkflowRevisionListClient,
  } from './fork-revision-picker.ts';

  interface ForkDialogProps {
    readonly client: ForkClient & WorkflowRevisionListClient;
    readonly workflowId: string;
    /** Pre-fills the target step from whichever checkpoint the operator selected. */
    readonly initialStep: number;
    /** The workflow TYPE this run is — used to look up installed revisions for the picker. */
    readonly workflowType: string;
    /** The source run's own persisted `WorkflowState.revision` — `undefined` for a legacy (pre-revision-pinning) record. What a default fork (no explicit opt-in) retains. */
    readonly sourceRevision: string | undefined;
    /** Fired with the new run's id right after a successful fork, so the Checkpoints tab can offer the divergence view. */
    readonly onForked?: (forkedWorkflowId: string) => void;
  }

  let { client, workflowId, initialStep, workflowType, sourceRevision, onForked }: ForkDialogProps =
    $props();

  // Intentional one-shot capture, not a bug: `checkpoints-tab.svelte` always
  // destroys and remounts this dialog (it lives behind an `{#if panel ===
  // 'fork'}` block gated by `selectCheckpoint()`, which resets `panel` to
  // 'replay' on every selection change), so a fresh instance always sees the
  // current `initialStep` at construction. Tracking it reactively here would
  // stomp the operator's in-progress edit to the target-step field whenever
  // `initialStep` happened to change out from under a still-mounted instance.
  // svelte-ignore state_referenced_locally
  let targetStepText = $state(String(initialStep));

  const principal = getPrincipalStore();
  const readGate = $derived(scopeGate(principal, ['workflows:read']));

  let pickerOpen = $state(false);
  /** Bound to the `Select` (installed-revisions case) — `''` means "use source revision." Empty when `Select` isn't the active input. */
  let selectedRevisionValue = $state('');
  /** Bound to the free-text `Input` (degraded, `workflows:read`-denied case). Empty when the `Input` isn't the active input. */
  let explicitRevisionText = $state('');

  const revisionsQuery = createQuery(
    toStore(() => ({
      // Shares the System route's Revisions-panel cache key (WFT-115) so
      // this picker starts warm when the revisions list is already cached,
      // and so activating a revision from the System route invalidates
      // this entry too — not a duplicate resource under a different key.
      queryKey: queryKeys.catalog.revisions(workflowType),
      queryFn: () => client.operations['weft.workflows.revisions.list']({ name: workflowType }),
      enabled: pickerOpen && !readGate.disabled,
    })),
  );

  const installedRevisions = $derived(
    $revisionsQuery.data !== undefined ? parseInstalledRevisions($revisionsQuery.data) : undefined,
  );

  /**
   * Only one of the two picker inputs is ever mounted at a time
   * (`readGate.disabled` decides which), so reading whichever one is
   * non-empty is unambiguous — no risk of a stale value from the OTHER,
   * unmounted input winning.
   */
  const selection = $derived<ForkRevisionSelection>(
    selectedRevisionValue !== ''
      ? { mode: 'explicit', revision: selectedRevisionValue }
      : explicitRevisionText.trim() !== ''
        ? { mode: 'explicit', revision: explicitRevisionText.trim() }
        : { mode: 'source' },
  );

  const parsedStep = $derived.by(() => {
    const trimmed = targetStepText.trim();
    if (trimmed.length === 0) return null;
    const value = Number(trimmed);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  });

  const forkMutation = createMutation({
    mutationFn: async (fromStep: number) =>
      client.fork(workflowId, resolveForkOptions(selection, fromStep)),
    onSuccess: (handle) => onForked?.(handle.id),
  });

  function submit(): void {
    if (parsedStep === null) return;
    $forkMutation.mutate(parsedStep);
  }

  function viewForkedRun(): void {
    const id = $forkMutation.data?.id;
    if (id !== undefined) router.navigate(workflowDetailPath(id));
  }

  const revisionConflict = $derived(
    $forkMutation.isError ? isForkRevisionConflict($forkMutation.error) : false,
  );
</script>

<div class="weft-fork-dialog">
  <Input
    id={`fork-target-step-${workflowId}`}
    label="Target step"
    inputmode="numeric"
    bind:value={targetStepText}
  />

  <div class="weft-fork-dialog__retention" role="status">
    {#if selection.mode === 'explicit'}
      <Tooltip text={`Fork target revision (exact executable artifact): ${selection.revision}`}>
        <span>
          Will target <code>rev {truncateId(selection.revision)}</code> instead of the source run's own
          revision.
        </span>
      </Tooltip>
    {:else if sourceRevision !== undefined}
      <Tooltip
        text={`Revision (exact executable artifact): ${sourceRevision}. ${EAGER_REVISION_HEDGE}`}
      >
        <span
          >Retains <code>rev {truncateId(sourceRevision)}</code> — the source run's own revision.</span
        >
      </Tooltip>
    {:else}
      <span>
        Unpinned source — this run predates revision pinning, so the fork resolves normally against
        whichever revision is currently active for this type.
      </span>
    {/if}
  </div>

  <Button
    variant="ghost"
    size="sm"
    label="Fork a different revision"
    aria-expanded={pickerOpen}
    onclick={() => (pickerOpen = !pickerOpen)}
  >
    {#snippet leadingIcon()}
      {#if pickerOpen}
        <ChevronDown aria-hidden="true" size={13} />
      {:else}
        <ChevronRight aria-hidden="true" size={13} />
      {/if}
    {/snippet}
  </Button>

  {#if pickerOpen}
    <div class="weft-fork-dialog__picker">
      {#if readGate.disabled}
        <Input
          id={`fork-explicit-revision-${workflowId}`}
          label="Revision id"
          description="You don't have permission to list installed revisions — enter one you already know. The server still validates it."
          bind:value={explicitRevisionText}
        />
      {:else if $revisionsQuery.isPending}
        <Skeleton height="2.5rem" />
      {:else if installedRevisions === undefined}
        <p class="weft-fork-dialog__error">Could not load the list of installed revisions.</p>
      {:else if installedRevisions.length === 0}
        <p class="weft-fork-dialog__note">No installed revisions are recorded for this type.</p>
      {:else}
        <Select
          id={`fork-revision-select-${workflowId}`}
          label="Revision"
          bind:value={selectedRevisionValue}
          options={[
            { value: '', label: 'Use source revision' },
            ...installedRevisions.map((option) => ({
              value: option.revision,
              label: `rev ${truncateId(option.revision)} · installed ${formatRelativeTime(option.installedAt)}`,
            })),
          ]}
        />
      {/if}
    </div>
  {/if}

  <p class="weft-fork-dialog__note">
    A new workflow is created, linked via <code>forkedFrom</code>.
  </p>

  {#if $forkMutation.isError}
    {#if revisionConflict}
      <div class="weft-fork-dialog__conflict" role="alert">
        <Badge variant="warning">Revision unavailable</Badge>
        <p>
          {$forkMutation.error instanceof Error
            ? $forkMutation.error.message
            : 'The requested revision could not be resolved.'}
          {forkConflictGuidance(selection)}
        </p>
      </div>
    {:else}
      <p class="weft-fork-dialog__error">
        {$forkMutation.error instanceof Error
          ? $forkMutation.error.message
          : 'Failed to fork the workflow.'}
      </p>
    {/if}
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

  .weft-fork-dialog__retention {
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
  }

  .weft-fork-dialog__retention code {
    font-family: var(--cinder-font-mono);
  }

  .weft-fork-dialog__picker {
    padding: 10px;
    background: var(--cinder-surface);
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
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

  .weft-fork-dialog__conflict {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 9px 12px;
    background: var(--cinder-color-warning-bg);
    border: 1px solid var(--cinder-color-warning-border);
    border-radius: var(--cinder-radius-md);
  }

  .weft-fork-dialog__conflict p {
    margin: 0;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-color-warning-fg);
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
