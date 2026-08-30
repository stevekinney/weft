<script lang="ts">
  /**
   * Overview tab (plan T2.4/§9.2): `DescriptionList` + `PayloadInspector` for
   * input/result/error, failure-category badge + plain-language explanation,
   * a small inline tag editor (design shows tag add/remove in this panel —
   * the header only shows tags read-only, see `header.svelte`), and the
   * Lineage panel (T2.7, `lineage-panel.svelte`).
   */
  import Badge from '@lostgradient/cinder/badge';
  import Button from '@lostgradient/cinder/button';
  import Collapsible from '@lostgradient/cinder/collapsible';
  import DescriptionList from '@lostgradient/cinder/description-list';
  import Input from '@lostgradient/cinder/input';
  import PayloadInspector from '@lostgradient/cinder/payload-inspector';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';
  import type { HttpClient } from '@lostgradient/weft/client';
  import type { WorkflowState } from '@lostgradient/weft';
  import { CircleX, Plus, X } from 'lucide-svelte';

  import { queryKeys } from '../../../lib/query.ts';
  import { failureCategoryExplanation, failureCategoryLabel } from './failure-category.ts';
  import LineagePanel from './lineage-panel.svelte';

  interface OverviewTabProps {
    readonly client: Pick<HttpClient, 'addTags' | 'removeTags' | 'get' | 'list'> & {
      readonly operations: Pick<HttpClient['operations'], 'weft.workflows.scheduleprovenance.get'>;
    };
    readonly workflow: WorkflowState;
  }

  let { client, workflow }: OverviewTabProps = $props();

  const queryClient = useQueryClient();

  function invalidateDetail(): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.workflows.detail(workflow.id) });
  }

  const addTagMutation = createMutation({
    mutationFn: (tag: string) => client.addTags(workflow.id, tag),
    onSuccess: invalidateDetail,
  });
  const removeTagMutation = createMutation({
    mutationFn: (tag: string) => client.removeTags(workflow.id, tag),
    onSuccess: invalidateDetail,
  });

  let newTag = $state('');

  function submitNewTag(): void {
    const trimmed = newTag.trim();
    if (trimmed.length === 0) return;
    $addTagMutation.mutate(trimmed);
    newTag = '';
  }

  const errorStack = $derived(workflow.errorStack ?? '');

  const versionSummaryText = $derived(
    [
      `wf ${workflow.versionTuple.workflowVersion}`,
      workflow.versionTuple.agentVersion ? `agent ${workflow.versionTuple.agentVersion}` : null,
      workflow.versionTuple.toolVersions && workflow.versionTuple.toolVersions.length > 0
        ? `tools ${workflow.versionTuple.toolVersions.length}`
        : null,
    ]
      .filter((part): part is string => part !== null)
      .join(' · '),
  );

  const definitionItems = $derived([
    { id: 'type', term: 'Type', definition: workflow.type },
    { id: 'version', term: 'Version', definition: versionSummaryText },
    { id: 'created', term: 'Created', definition: new Date(workflow.createdAt).toISOString() },
    ...(workflow.executionDeadline !== undefined
      ? [
          {
            id: 'deadline',
            term: 'Deadline',
            definition: new Date(workflow.executionDeadline).toISOString(),
          },
        ]
      : []),
  ]);
</script>

<div class="weft-overview-tab">
  <div class="weft-overview-tab__panel">
    <div class="weft-overview-tab__panel-header">Definition</div>
    <DescriptionList items={definitionItems} variant="default" />
    <div class="weft-overview-tab__tags">
      <div class="weft-overview-tab__tags-label">Tags</div>
      <div class="weft-overview-tab__tags-row">
        {#each workflow.tags ?? [] as tag (tag)}
          <Badge variant="neutral">
            {tag}
            <button
              type="button"
              class="weft-overview-tab__tag-remove"
              aria-label={`Remove tag ${tag}`}
              disabled={$removeTagMutation.isPending}
              onclick={() => $removeTagMutation.mutate(tag)}
            >
              <X aria-hidden="true" size={10} />
            </button>
          </Badge>
        {/each}
        <Input
          id={`workflow-detail-new-tag-${workflow.id}`}
          label="Add tag"
          labelVisible={false}
          placeholder="Add tag"
          bind:value={newTag}
          onkeydown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submitNewTag();
            }
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          label="Add tag"
          disabled={newTag.trim().length === 0 || $addTagMutation.isPending}
          onclick={submitNewTag}
        >
          {#snippet leadingIcon()}
            <Plus aria-hidden="true" size={12} />
          {/snippet}
        </Button>
      </div>
    </div>
  </div>

  <div class="weft-overview-tab__right">
    <div class="weft-overview-tab__panel">
      <div class="weft-overview-tab__panel-header">Input</div>
      <PayloadInspector value={workflow.input} label="Input payload" />
    </div>

    {#if workflow.status === 'completed'}
      <div class="weft-overview-tab__panel">
        <div class="weft-overview-tab__panel-header">Result</div>
        <PayloadInspector value={workflow.result} label="Result payload" />
      </div>
    {:else if workflow.status === 'failed'}
      <div class="weft-overview-tab__failure">
        <div class="weft-overview-tab__failure-title">
          <CircleX aria-hidden="true" size={18} />
          <span>Failed</span>
          {#if workflow.failureCategory !== undefined}
            <Badge variant="danger">{failureCategoryLabel(workflow.failureCategory)}</Badge>
          {/if}
        </div>
        {#if workflow.failureCategory !== undefined}
          <p class="weft-overview-tab__failure-explanation">
            {failureCategoryExplanation(workflow.failureCategory)}
          </p>
        {/if}
        {#if workflow.error}
          <p class="weft-overview-tab__failure-explanation">{workflow.error}</p>
        {/if}
        {#if errorStack.length > 0}
          <Collapsible trigger="Show full stack trace">
            <pre class="weft-send-tab__result">{errorStack}</pre>
          </Collapsible>
        {/if}
      </div>
    {:else if workflow.status === 'cancelled' || workflow.status === 'timed-out'}
      <div class="weft-overview-tab__pending-result">
        This run ended as <strong
          >{workflow.status === 'cancelled' ? 'cancelled' : 'timed out'}</strong
        > — no result value.
      </div>
    {:else}
      <div class="weft-overview-tab__pending-result">
        <span class="weft-overview-tab__spinner" aria-hidden="true"></span>
        Result pending — workflow still {workflow.status}.
      </div>
    {/if}

    <LineagePanel {client} {workflow} />
  </div>
</div>

<style>
  .weft-overview-tab__tag-remove {
    display: inline-flex;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    padding: 0;
    margin-left: 2px;
  }

  .weft-overview-tab__spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--cinder-border-strong);
    border-top-color: var(--cinder-accent);
    border-radius: 50%;
    display: inline-block;
    animation: weft-overview-spin 0.7s linear infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .weft-overview-tab__spinner {
      animation-duration: 0.001ms;
    }
  }

  @keyframes weft-overview-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
