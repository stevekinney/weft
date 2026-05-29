<script lang="ts">
  import type { ScheduleSummary } from '../api-client.ts';
  import { formatTimestamp } from '../utilities/format-date.ts';

  interface Props {
    schedules: ScheduleSummary[];
  }

  let { schedules }: Props = $props();
</script>

<div class="schedule-list" data-schedule-count={schedules.length}>
  {#each schedules as item (item.id)}
    <div class="schedule-row">
      <div class="schedule-row-header">
        <div class="schedule-row-title-group">
          <span class="schedule-id">{item.id}</span>
          <span class="schedule-type text-muted">{item.workflowType}</span>
        </div>
        <span class="schedule-status" data-status={item.status}>{item.status}</span>
      </div>

      <div class="schedule-meta text-muted">
        {#if item.intervalMs !== undefined}
          <span>Every {item.intervalMs}ms</span>
        {:else}
          <span>Cron {item.cronExpression}</span>
        {/if}
        <span>Last fired {formatTimestamp(item.lastFireAt)}</span>
        <span>Next fire {formatTimestamp(item.nextFireAt)}</span>
      </div>

      {#if item.currentWorkflowId || item.queuedRuns > 0}
        <div class="schedule-meta text-muted">
          {#if item.currentWorkflowId}
            <span>Current run {item.currentWorkflowId}</span>
          {/if}
          <span>Queued runs {item.queuedRuns}</span>
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .schedule-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }

  .schedule-row-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
  }

  .schedule-row-title-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
  }

  .schedule-id {
    font-weight: 600;
  }

  .schedule-type {
    font-size: var(--text-xs, 0.75rem);
  }

  .schedule-status {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    padding: 0.2rem 0.55rem;
    font-size: var(--text-xs, 0.75rem);
    font-weight: 600;
    text-transform: capitalize;
    background: color-mix(in oklch, var(--surface-inset, #f3f4f6), transparent 12%);
    color: var(--text, #111827);
  }

  .schedule-status[data-status='active'] {
    background: color-mix(in oklch, var(--success, #16a34a), transparent 84%);
    color: var(--success, #16a34a);
  }

  .schedule-status[data-status='paused'] {
    background: color-mix(in oklch, var(--warning, #d97706), transparent 84%);
    color: var(--warning, #d97706);
  }

  .schedule-status[data-status='cancelled'] {
    background: color-mix(in oklch, var(--text-muted, #6b7280), transparent 82%);
    color: var(--text-muted, #6b7280);
  }

  .schedule-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3, 0.75rem);
    font-size: var(--text-xs, 0.75rem);
  }
</style>
