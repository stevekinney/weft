<script lang="ts">
  /**
   * Revisions panel (WFT-115) — mounted below the schema panels on the
   * Registry → workflow definition detail view (`registry-detail.svelte`).
   * Lists every durably installed revision of one workflow name
   * (`weft.workflows.revisions.list`) against the currently active pointer
   * (`weft.workflows.active.get`), and lets an operator with `workflows:admin`
   * activate a non-active revision.
   *
   * ## Activation IS the compatibility preview (see
   * `packages/weft/documentation/guides/workflow-versioning.md`, verified)
   *
   * There is no separate read-only "preview" operation — the only
   * server-supplied compatibility verdict is the outcome of a real
   * `weft.workflows.revisions.activate` call. A refusal is a pure no-op
   * (nothing durable changes; `WorkflowCatalogConflictError`/the four
   * refusal reasons never mutate the active pointer), so this panel treats
   * Activate as a real, honestly-labeled mutation whose outcome doubles as
   * the compatibility preview the acceptance criteria asks for — never a
   * separate non-committing "check" control, and never a local
   * reimplementation of `checkWorkflowCompatibility` (that function is
   * server-only; see `../../lib/faults.ts`'s module doc for why only
   * `@lostgradient/weft/client` is browser-safe to import as a VALUE).
   *
   * `weft.workflows.active.get` faults `NotFound` for a workflow that has
   * never been activated — a legitimate state (an eagerly-registered
   * fixture workflow always has one by the time this panel can be reached
   * from the Registry tab, but a name reachable only via
   * `weft.workflows.revisions.install` might not), rendered here as "no
   * active revision" rather than the fault banner.
   *
   * ## Why the Activate button is offered for the CURRENTLY active revision too
   *
   * Under the strict default compatibility policy
   * (`requireExactRevision: true`), re-activating the already-active
   * revision is a legitimate generation re-stamp (workflow-versioning
   * guide) — this panel deliberately does not special-case it out, but
   * labels the row's own action "Refresh" instead of "Activate" so an
   * operator never reads a same-revision success as "a new revision just
   * went live." The compatibility-policy override
   * (`policy.requireExactRevision: false`) is a deliberate omission from
   * this batch, not an oversight — see the PR body.
   */
  import Badge from '@lostgradient/cinder/badge';
  import Button from '@lostgradient/cinder/button';
  import ConfirmDialog from '@lostgradient/cinder/confirm-dialog';
  import CopyButton from '@lostgradient/cinder/copy-button';
  import { AlertTriangle, Ban, CheckCircle2, RefreshCw } from 'lucide-svelte';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { toStore } from 'svelte/store';
  import { HttpClientError } from '@lostgradient/weft/client';

  import { getClient } from '../../lib/client.ts';
  import { formatRelativeTime, truncateId } from '../../lib/format/index.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { getPrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import {
    compatibilityReasonLabel,
    describeActivationOutcome,
    type ActivationAttempt,
    type WorkflowActivationOutcome,
  } from './compatibility-verdict.ts';
  import QueryFaultBanner from './query-fault-banner.svelte';
  import {
    isWorkflowCatalogActivePointerLike,
    workflowRevisionRows,
    type WorkflowCatalogActivePointerLike,
    type WorkflowRevisionRow,
  } from './workflow-revisions-view.ts';

  interface Props {
    workflowName: string;
  }

  let { workflowName }: Props = $props();

  const client = getClient();
  const principal = getPrincipalStore();
  const queryClient = useQueryClient();

  const canRead = $derived(principal.hasScope('workflows:read'));
  const adminGate = $derived(scopeGate(principal, ['workflows:admin']));

  const revisionsQuery = createQuery(
    toStore(() => ({
      queryKey: queryKeys.catalog.revisions(workflowName),
      queryFn: (): Promise<unknown> =>
        client.operations['weft.workflows.revisions.list']({ name: workflowName }),
      enabled: canRead,
    })),
  );

  const activeQuery = createQuery(
    toStore(() => ({
      queryKey: queryKeys.catalog.active(workflowName),
      queryFn: async (): Promise<WorkflowCatalogActivePointerLike | null> => {
        try {
          const raw = await client.operations['weft.workflows.active.get']({ name: workflowName });
          return isWorkflowCatalogActivePointerLike(raw) ? raw : null;
        } catch (error) {
          // A workflow that has never been activated is a legitimate state
          // (module doc), not a fault to surface — every other NotFound (or
          // any other fault) is a real error this query should report.
          if (error instanceof HttpClientError && error.faultCode === 'NotFound') return null;
          throw error;
        }
      },
      enabled: canRead,
    })),
  );

  /** `undefined` when the wire payload isn't a top-level array at all — the explicit malformed-response state, distinct from "resolved to zero rows". */
  const revisionsArray = $derived.by((): readonly unknown[] | undefined => {
    const data = $revisionsQuery.data;
    return Array.isArray(data) ? data : undefined;
  });

  const rows = $derived(workflowRevisionRows(revisionsArray ?? [], $activeQuery.data ?? null));

  const isLoading = $derived(canRead && ($revisionsQuery.isPending || $activeQuery.isPending));
  const isRefreshing = $derived(
    ($revisionsQuery.isFetching && $revisionsQuery.data !== undefined) ||
      ($activeQuery.isFetching && $activeQuery.data !== undefined),
  );
  const isMalformed = $derived(
    !$revisionsQuery.isPending && !$revisionsQuery.isError && revisionsArray === undefined,
  );

  function invalidateAfterActivation(): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.catalog.revisions(workflowName) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.catalog.active(workflowName) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.registry() });
  }

  function isAppliedActivationResult(value: unknown): value is {
    applied: true;
    pointer: { revision: string; generation: number; activatedAt: number };
  } {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    if (record['applied'] !== true) return false;
    const pointer = record['pointer'];
    if (typeof pointer !== 'object' || pointer === null) return false;
    const pointerRecord = pointer as Record<string, unknown>;
    return (
      typeof pointerRecord['revision'] === 'string' &&
      typeof pointerRecord['generation'] === 'number' &&
      typeof pointerRecord['activatedAt'] === 'number'
    );
  }

  const activateMutation = createMutation<WorkflowActivationOutcome, unknown, string>({
    mutationFn: async (candidateRevision: string) => {
      const activePointer = $activeQuery.data ?? null;
      let attempt: ActivationAttempt;
      try {
        const raw = await client.operations['weft.workflows.revisions.activate']({
          name: workflowName,
          revision: candidateRevision,
          ...(activePointer === null ? {} : { expectedGeneration: activePointer.generation }),
        });
        attempt = isAppliedActivationResult(raw)
          ? { applied: true, pointer: raw.pointer }
          : { applied: false, error: new Error('Malformed activation response') };
      } catch (error) {
        attempt = { applied: false, error };
      }
      return describeActivationOutcome(attempt);
    },
    onSuccess: invalidateAfterActivation,
  });

  let confirmRevision = $state<string | null>(null);
  let confirmOpen = $state(false);
  let triggerRef = $state<HTMLElement | null>(null);

  function openConfirm(revision: string, trigger: HTMLElement): void {
    confirmRevision = revision;
    triggerRef = trigger;
    confirmOpen = true;
  }

  /** One `<dt>`/`<dd>` pair for a revision row's `DescriptionList`-style meta grid — a single templated `{#each}` in the markup instead of four hand-repeated blocks. */
  interface RowMetaItem {
    readonly term: string;
    readonly value: string;
    readonly title: string | undefined;
    readonly mono: boolean;
  }

  function rowMeta(row: WorkflowRevisionRow): readonly RowMetaItem[] {
    return [
      { term: 'Workflow version', value: row.workflowVersion, title: undefined, mono: false },
      {
        term: 'Contract hash',
        value: truncateId(row.contractHash),
        title: row.contractHash,
        mono: true,
      },
      {
        term: 'Manifest version',
        value: String(row.manifestVersion),
        title: undefined,
        mono: false,
      },
      {
        term: 'Installed at',
        value: formatRelativeTime(row.installedAt),
        title: undefined,
        mono: false,
      },
    ];
  }

  /** Outcome-banner copy, built as plain script-level string functions rather than inline multi-part template expressions — one interpolation per rendered line. */
  function appliedOutcomeMessage(
    outcome: Extract<WorkflowActivationOutcome, { kind: 'applied' }>,
  ): string {
    return `Activated revision "${outcome.pointer.revision}" (generation ${outcome.pointer.generation}).`;
  }

  function staleOutcomeMessage(
    outcome: Extract<WorkflowActivationOutcome, { kind: 'stale' }>,
  ): string {
    return `The active revision changed (current generation ${outcome.currentGeneration}). Refresh and try again.`;
  }

  function reasonListItem(reason: string): string {
    return `${compatibilityReasonLabel(reason)} (${reason})`;
  }

  function refetchAll(): void {
    void $revisionsQuery.refetch();
    void $activeQuery.refetch();
  }
</script>

<section class="weft-revisions-panel" aria-label="Installed revisions">
  <div class="weft-revisions-panel__header">
    <h3 class="weft-revisions-panel__title">Revisions</h3>
    {#if isRefreshing}
      <span class="weft-revisions-panel__refreshing" role="status">Refreshing…</span>
    {/if}
  </div>

  {#if !canRead}
    <p class="weft-revisions-panel__note">Requires workflows:read to view installed revisions.</p>
  {:else if isLoading}
    <div role="status" aria-busy="true" aria-label="Loading revisions">
      <p class="weft-revisions-panel__note">Loading…</p>
    </div>
  {:else if $revisionsQuery.isError}
    <QueryFaultBanner error={$revisionsQuery.error} onRetry={() => $revisionsQuery.refetch()} />
  {:else if $activeQuery.isError}
    <QueryFaultBanner error={$activeQuery.error} onRetry={() => $activeQuery.refetch()} />
  {:else if isMalformed}
    <div class="weft-revisions-panel__malformed" role="alert">
      <AlertTriangle aria-hidden="true" size={16} />
      <span
        >The server returned a revisions list this console doesn't recognize — showing nothing
        rather than a guess.</span
      >
    </div>
  {:else if rows.length === 0}
    <p class="weft-revisions-panel__note">No revisions installed for this workflow yet.</p>
  {:else}
    {#if $activeQuery.data === null}
      <p class="weft-revisions-panel__note">No active revision — never activated.</p>
    {/if}
    <ul class="weft-revisions-panel__list">
      {#each rows as row (row.revision)}
        <li class="weft-revisions-panel__row">
          <div class="weft-revisions-panel__row-identity">
            <span class="weft-revisions-panel__revision" title={row.revision}>
              {truncateId(row.revision)}
            </span>
            <CopyButton value={row.revision} iconOnly label={`Copy revision ${row.revision}`} />
            {#if row.isActive}
              <Badge variant="success">Active</Badge>
            {:else}
              <Badge variant="neutral">Installed</Badge>
            {/if}
          </div>
          <dl class="weft-revisions-panel__row-meta">
            {#each rowMeta(row) as item (item.term)}
              <div>
                <dt>{item.term}</dt>
                <dd class={item.mono ? 'weft-revisions-panel__mono' : ''} title={item.title}>
                  {item.value}
                </dd>
              </div>
            {/each}
          </dl>
          <Button
            size="sm"
            variant="secondary"
            label={row.isActive ? 'Refresh' : 'Activate'}
            disabled={adminGate.disabled || $activateMutation.isPending}
            title={adminGate.title}
            onclick={(event) => openConfirm(row.revision, event.currentTarget as HTMLElement)}
          />
        </li>
      {/each}
    </ul>
  {/if}

  {#if $activateMutation.isSuccess}
    {@const outcome = $activateMutation.data}
    {#if outcome.kind === 'applied'}
      <div
        class="weft-revisions-panel__outcome weft-revisions-panel__outcome--applied"
        role="status"
      >
        <CheckCircle2 aria-hidden="true" size={16} />
        <div>
          <Badge variant="success">Compatible</Badge>
          <p>{appliedOutcomeMessage(outcome)}</p>
        </div>
      </div>
    {:else if outcome.kind === 'incompatible'}
      <div
        class="weft-revisions-panel__outcome weft-revisions-panel__outcome--incompatible"
        role="alert"
      >
        <Ban aria-hidden="true" size={16} />
        <div>
          <Badge variant="danger">Incompatible</Badge>
          <ul>
            {#each outcome.reasons as reason (reason)}
              <li>{reasonListItem(reason)}</li>
            {/each}
          </ul>
        </div>
      </div>
    {:else}
      <div class="weft-revisions-panel__outcome weft-revisions-panel__outcome--stale" role="alert">
        <RefreshCw aria-hidden="true" size={16} />
        <div>
          <Badge variant="warning">Conflict</Badge>
          <p>{staleOutcomeMessage(outcome)}</p>
          <Button size="sm" variant="secondary" label="Refresh" onclick={refetchAll} />
        </div>
      </div>
    {/if}
  {/if}
</section>

<ConfirmDialog
  bind:open={confirmOpen}
  {triggerRef}
  title="Activate revision?"
  description={confirmRevision === null
    ? ''
    : `Activate "${confirmRevision}" as the active revision for ${workflowName}? Weft evaluates compatibility against the currently active revision before applying — an incompatible candidate is refused with no durable change.`}
  confirmLabel="Activate"
  onConfirm={() => {
    if (confirmRevision !== null) $activateMutation.mutate(confirmRevision);
  }}
/>

<style>
  .weft-revisions-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .weft-revisions-panel__header {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .weft-revisions-panel__title {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }

  .weft-revisions-panel__refreshing {
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-subtle);
  }

  .weft-revisions-panel__note {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-subtle);
  }

  .weft-revisions-panel__malformed {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: var(--cinder-radius-md);
    background: var(--cinder-color-warning-bg);
    border: 1px solid var(--cinder-color-warning-border);
    color: var(--cinder-color-warning-fg);
    font-size: var(--cinder-text-sm);
  }

  .weft-revisions-panel__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .weft-revisions-panel__row {
    background: var(--cinder-surface-raised);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-lg);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .weft-revisions-panel__row-identity {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .weft-revisions-panel__revision {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }

  .weft-revisions-panel__row-meta {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 8px 16px;
    margin: 0;
  }

  .weft-revisions-panel__row-meta dt {
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-subtle);
  }

  .weft-revisions-panel__row-meta dd {
    margin: 0;
    font-size: var(--cinder-text-xs);
  }

  .weft-revisions-panel__mono {
    font-family: var(--cinder-font-mono);
  }

  .weft-revisions-panel__outcome {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
    border-radius: var(--cinder-radius-lg);
    border: 1px solid var(--cinder-border);
  }

  .weft-revisions-panel__outcome p {
    margin: 6px 0 0;
    font-size: var(--cinder-text-sm);
  }

  .weft-revisions-panel__outcome ul {
    margin: 6px 0 0;
    padding-inline-start: 1.1rem;
    font-size: var(--cinder-text-sm);
  }

  .weft-revisions-panel__outcome--applied {
    background: var(--cinder-color-success-bg);
    border-color: var(--cinder-color-success-border);
  }

  .weft-revisions-panel__outcome--incompatible {
    background: var(--cinder-color-danger-bg);
    border-color: var(--cinder-color-danger-border);
  }

  .weft-revisions-panel__outcome--stale {
    background: var(--cinder-color-warning-bg);
    border-color: var(--cinder-color-warning-border);
  }
</style>
