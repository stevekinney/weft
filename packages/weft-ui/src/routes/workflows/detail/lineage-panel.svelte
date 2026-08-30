<script lang="ts">
  /**
   * Lineage panel (plan T2.7, design `Weft New Surfaces.dc.html` §B):
   * schedule provenance row, continuation chips, forked-from row, child
   * tree. IDs `first8…last4` + hover title + copy; names — never IDs — as
   * link labels.
   *
   * ## What's real, as of weft 0.15.0 (weft#732, PR #760)
   *
   * - **Forked from**: real since the original build. `WorkflowState.forkedFrom`
   *   (`{ workflowId, step }`) is a public field on `GET /api/v1/workflows/:id`.
   *   This panel additionally fetches the forked-from workflow's own workflow
   *   to show its TYPE as the link label (never the raw id) — falls back to
   *   the truncated id if that lookup 404s (e.g. the source run was since
   *   purged).
   * - **Children**: real. `WorkflowState.parentWorkflowId` + `ListFilter.
   *   parentWorkflowId` (weft#732 item 1) let this panel query `client.
   *   list({ parentWorkflowId })` directly — verified live against the
   *   `fulfillment-parent` fixture: real ids, real links, for BOTH awaited
   *   and detached children (see `children-tab.svelte`'s module doc for the
   *   full verification story; this panel shows a short preview of the same
   *   data).
   * - **Schedule provenance**: real. `weft.workflows.scheduleprovenance.get`
   *   returns the durable `{ scheduleId, occurrence? }` a schedule-launched
   *   run recorded — verified live against the dev harness's
   *   `inventory-sync-every-5-minutes` fixture schedule actually firing.
   *   Links to the schedule's detail page (`/schedules?id=...`).
   * - **Continuation chain**: real, with one honest limit. `WorkflowState.
   *   restartedFrom` (`{ workflowId, workflowExecutionToken, replacedAt }`)
   *   is the immediate predecessor `onTerminalConflict: 'start-new'`
   *   displaced. It carries NO status field (verified against
   *   `@lostgradient/weft`'s `RestartLineage` type), so the "Previous run"
   *   chip renders without a status badge — the design mock's illustrative
   *   "Completed" badge on that chip isn't backable by real data, so this
   *   panel doesn't fabricate one. The chip is also deliberately NOT a link:
   *   `restartedFrom.workflowId` is the SAME id as the current run (that's
   *   the whole point of `start-new` — it reuses the id), and the displaced
   *   run itself is purged as part of the atomic replace, so there is no
   *   distinct destination to navigate to. "No successor" is always shown
   *   and always true by construction: `GET /api/v1/workflows/:id` always
   *   returns the LATEST generation for that id, so whatever run this panel
   *   is currently showing can never itself have a successor — if one
   *   existed, this panel would already be showing it instead.
   */
  import CopyButton from '@lostgradient/cinder/copy-button';
  import Skeleton from '@lostgradient/cinder/skeleton';
  import { createQuery } from '@tanstack/svelte-query';
  import type { HttpClient } from '@lostgradient/weft/client';
  import type { WorkflowState } from '@lostgradient/weft';
  import { ArrowRight, CalendarClock, CornerDownRight, GitBranch, GitFork } from 'lucide-svelte';
  import { toStore } from 'svelte/store';

  import { formatRelativeTime, truncateId } from '../../../lib/format/index.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router, workflowDetailPath } from '../../../lib/router.svelte.ts';
  import { workflowStatusBadge } from '../list/workflow-status-badge.ts';
  import WorkflowStatusIcon from '../list/workflow-status-icon.svelte';
  import { getScheduleProvenance, scheduleProvenanceQueryKey } from './workflow-observability.ts';

  interface LineagePanelProps {
    readonly client: Pick<HttpClient, 'get' | 'list'> & {
      readonly operations: Pick<HttpClient['operations'], 'weft.workflows.scheduleprovenance.get'>;
    };
    readonly workflow: WorkflowState;
  }

  let { client, workflow }: LineagePanelProps = $props();

  const forkedFrom = $derived(workflow.forkedFrom);
  const restartedFrom = $derived(workflow.restartedFrom);

  const forkSourceQuery = createQuery(
    toStore(() => ({
      queryKey: queryKeys.workflows.detail(forkedFrom?.workflowId ?? ''),
      queryFn: () => client.get(forkedFrom?.workflowId ?? ''),
      enabled: forkedFrom !== undefined,
    })),
  );

  const scheduleProvenanceQuery = createQuery(
    toStore(() => ({
      queryKey: scheduleProvenanceQueryKey(workflow.id),
      queryFn: () => getScheduleProvenance(client, workflow.id),
    })),
  );

  const CHILDREN_PREVIEW_LIMIT = 5;

  const childrenQuery = createQuery(
    toStore(() => ({
      queryKey: queryKeys.workflows.list({
        parentWorkflowId: workflow.id,
        limit: CHILDREN_PREVIEW_LIMIT,
      }),
      queryFn: () => client.list({ parentWorkflowId: workflow.id, limit: CHILDREN_PREVIEW_LIMIT }),
    })),
  );

  const children = $derived($childrenQuery.data?.items ?? []);
  const childrenTotal = $derived($childrenQuery.data?.total ?? 0);
  const moreChildren = $derived(Math.max(0, childrenTotal - children.length));

  const thisRunBadge = $derived(workflowStatusBadge(workflow.status));

  function goToWorkflow(id: string): void {
    router.navigate(workflowDetailPath(id));
  }

  function goToSchedule(scheduleId: string): void {
    router.navigate(`/schedules?id=${encodeURIComponent(scheduleId)}`);
  }
</script>

<div class="weft-lineage-panel">
  <div class="weft-lineage-panel__header">
    <GitBranch aria-hidden="true" size={15} />
    Lineage
  </div>
  <div class="weft-lineage-panel__body">
    {#if $scheduleProvenanceQuery.isPending}
      <Skeleton height="2rem" />
    {:else if $scheduleProvenanceQuery.data}
      {@const provenance = $scheduleProvenanceQuery.data}
      <div class="weft-lineage-panel__row">
        <CalendarClock aria-hidden="true" size={14} />
        <span class="weft-lineage-panel__row-label">Launched by schedule</span>
        <a
          href={router.href(`/schedules?id=${encodeURIComponent(provenance.scheduleId)}`)}
          onclick={(event) => {
            event.preventDefault();
            goToSchedule(provenance.scheduleId);
          }}
        >
          {provenance.scheduleId}
        </a>
        {#if provenance.occurrence !== undefined}
          <span class="weft-lineage-panel__meta">
            · occurrence {new Date(provenance.occurrence).toISOString()}
          </span>
        {/if}
      </div>
    {/if}

    {#if restartedFrom}
      <div>
        <div class="weft-lineage-panel__section-label">Continuation chain · same workflow id</div>
        <div class="weft-lineage-continuation">
          <span class="weft-lineage-continuation__chip weft-lineage-continuation__chip--previous">
            <span class="weft-lineage-continuation__label">Previous run</span>
            <span
              class="weft-lineage-panel__id"
              title={restartedFrom.workflowExecutionToken ?? restartedFrom.workflowId}
            >
              {truncateId(restartedFrom.workflowExecutionToken ?? restartedFrom.workflowId)}
            </span>
            <span class="weft-lineage-continuation__meta">
              replaced {formatRelativeTime(restartedFrom.replacedAt)}
            </span>
          </span>
          <ArrowRight aria-hidden="true" size={14} />
          <span class="weft-lineage-continuation__chip weft-lineage-continuation__chip--current">
            <WorkflowStatusIcon icon={thisRunBadge.icon} />
            <span class="weft-lineage-continuation__label">This run</span>
          </span>
          <ArrowRight aria-hidden="true" size={14} />
          <span class="weft-lineage-continuation__chip weft-lineage-continuation__chip--none">
            No successor
          </span>
        </div>
      </div>
    {/if}

    {#if forkedFrom}
      <div class="weft-lineage-panel__row">
        <GitFork aria-hidden="true" size={14} />
        <span class="weft-lineage-panel__row-label">Forked from</span>
        {#if $forkSourceQuery.isPending}
          <Skeleton height="1rem" width="8rem" />
        {:else}
          <a
            href={router.href(workflowDetailPath(forkedFrom.workflowId))}
            onclick={(event) => {
              event.preventDefault();
              goToWorkflow(forkedFrom.workflowId);
            }}
          >
            {$forkSourceQuery.data?.type ?? `${truncateId(forkedFrom.workflowId)} run`}
          </a>
          <span class="weft-lineage-panel__id" title={forkedFrom.workflowId}>
            {truncateId(forkedFrom.workflowId)}
          </span>
          <CopyButton value={forkedFrom.workflowId} iconOnly label="Copy workflow id" />
        {/if}
        <span class="weft-lineage-panel__meta">at step {forkedFrom.step}</span>
      </div>
    {/if}

    <div>
      <div class="weft-lineage-panel__section-label">
        Child workflows{#if childrenTotal > 0}
          &nbsp;· {childrenTotal}{/if}
      </div>
      {#if $childrenQuery.isPending}
        <Skeleton height="1.5rem" />
      {:else if children.length === 0}
        <p class="weft-lineage-panel__note">No child workflows.</p>
      {:else}
        <div class="weft-lineage-panel__children">
          {#each children as child (child.id)}
            {@const badge = workflowStatusBadge(child.status)}
            <a
              class="weft-lineage-panel__child-row weft-lineage-panel__child-row--link"
              href={router.href(workflowDetailPath(child.id))}
              onclick={(event) => {
                event.preventDefault();
                goToWorkflow(child.id);
              }}
            >
              <CornerDownRight aria-hidden="true" size={12} />
              <span>{child.type}</span>
              <span class="weft-lineage-panel__id" title={child.id}>{truncateId(child.id)}</span>
              <span class="weft-lineage-panel__meta">
                <WorkflowStatusIcon icon={badge.icon} />
                {badge.label}
              </span>
            </a>
          {/each}
        </div>
        {#if moreChildren > 0}
          <p class="weft-lineage-panel__note">
            +{moreChildren} more — see the Children tab.
          </p>
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .weft-lineage-panel__id {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-subtle);
  }

  .weft-lineage-panel__meta {
    margin-left: auto;
    color: var(--cinder-text-disabled);
    font-size: var(--cinder-text-2xs);
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .weft-lineage-panel__child-row--link {
    color: inherit;
    text-decoration: none;
    cursor: pointer;
  }

  .weft-lineage-panel__child-row--link:hover {
    background: var(--cinder-surface-hover);
  }

  /* Continuation chain (design "gen 41 → gen 42 → No successor") — scoped
     here rather than growing the shared `workflow-detail.css` (already at
     this repo's ≤500-line implementation-file guidance — `events-tab.svelte`
     sets this precedent). */
  .weft-lineage-continuation {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .weft-lineage-continuation__chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 9px;
    border-radius: var(--cinder-radius-md);
    font-size: var(--cinder-text-xs);
    white-space: nowrap;
  }

  .weft-lineage-continuation__chip--previous {
    border: 1px solid var(--cinder-border);
    background: var(--cinder-surface);
  }

  .weft-lineage-continuation__chip--current {
    border: 1.5px solid var(--cinder-accent);
    background: color-mix(in oklch, var(--cinder-accent), transparent 92%);
    font-weight: 600;
  }

  .weft-lineage-continuation__chip--none {
    border: 1px dashed var(--cinder-border);
    color: var(--cinder-text-disabled);
    font-size: var(--cinder-text-2xs);
  }

  .weft-lineage-continuation__label {
    white-space: nowrap;
  }

  .weft-lineage-continuation__meta {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-subtle);
  }
</style>
