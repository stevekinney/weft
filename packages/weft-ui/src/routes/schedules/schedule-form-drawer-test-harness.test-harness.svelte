<script lang="ts">
  /** Test-only composition of `<SchedulesTestHarness>` + `<ScheduleFormDrawer>` — see `schedule-list-test-harness.test-harness.svelte`'s doc for why this wrapper exists. */
  import type { HttpClient } from '@lostgradient/weft/client';

  import type { AuthorizationScope } from '../../lib/scopes.svelte.ts';
  import ScheduleFormDrawer from './schedule-form-drawer.svelte';
  import SchedulesTestHarness from './schedules-test-harness.test-harness.svelte';

  interface Props {
    client: HttpClient;
    mode: 'create' | 'edit';
    scheduleId?: string | undefined;
    onClose: () => void;
    scopes?: readonly AuthorizationScope[] | undefined;
  }

  let { client, mode, scheduleId, onClose, scopes }: Props = $props();
</script>

<SchedulesTestHarness {client} {scopes}>
  {#snippet children()}
    <ScheduleFormDrawer {mode} {scheduleId} {onClose} />
  {/snippet}
</SchedulesTestHarness>
