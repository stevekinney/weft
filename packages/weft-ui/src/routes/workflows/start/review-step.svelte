<script lang="ts">
  /**
   * Start wizard — Review step (plan §9.2 T2.3). Read-only summary of the
   * resolved type/payload/advanced options, plus the submit result: success
   * (with a link to the new run) or the 409 spent-idempotency-key
   * explanation (plan §9.2, design `Weft Patterns.dc.html`'s "result + 409"
   * panel). Other faults surface through the shared
   * `query-fault-banner.svelte` from the list track.
   */
  import { CircleCheck, GitPullRequestClosed } from 'lucide-svelte';
  import DescriptionList from '@lostgradient/cinder/description-list';
  import PayloadInspector from '@lostgradient/cinder/payload-inspector';

  import { truncateId } from '../../../lib/format/index.ts';
  import { router, workflowDetailPath } from '../../../lib/router.svelte.ts';
  import QueryFaultBanner from '../list/query-fault-banner.svelte';
  import type { AdvancedStartOptionsInput } from './start-wizard-state.ts';

  export type StartSubmitState =
    | { readonly status: 'idle' }
    | { readonly status: 'pending' }
    | { readonly status: 'success'; readonly workflowId: string }
    | {
        readonly status: 'error';
        readonly error: unknown;
        readonly isSpentIdempotencyKey: boolean;
      };

  interface ReviewStepProps {
    type: string;
    payload: unknown;
    advanced: AdvancedStartOptionsInput;
    submitState: StartSubmitState;
    onBack: () => void;
    onSubmit: () => void;
  }

  let { type, payload, advanced, submitState, onBack, onSubmit }: ReviewStepProps = $props();

  const advancedItems = $derived(
    [
      advanced.id ? { term: 'Workflow id', definition: advanced.id } : null,
      advanced.idempotencyKey
        ? { term: 'Idempotency key', definition: advanced.idempotencyKey }
        : null,
      advanced.tags.length > 0 ? { term: 'Tags', definition: advanced.tags.join(', ') } : null,
      advanced.executionTimeout
        ? { term: 'Execution timeout', definition: advanced.executionTimeout }
        : null,
    ].filter((item): item is { term: string; definition: string } => item !== null),
  );
</script>

<div class="weft-start-review">
  <DescriptionList items={[{ term: 'Workflow type', definition: type }, ...advancedItems]} />

  <div class="weft-start-review__payload">
    <span class="weft-start-review__payload-label">Payload</span>
    <PayloadInspector value={payload} />
  </div>

  {#if submitState.status === 'success'}
    <div class="weft-start-review__result weft-start-review__result--success">
      <CircleCheck aria-hidden="true" size={16} />
      <span>
        Started <code>{truncateId(submitState.workflowId)}</code>
      </span>
      <a
        class="weft-start-review__view-link"
        href={router.href(workflowDetailPath(submitState.workflowId))}
        onclick={(event) => {
          event.preventDefault();
          router.navigate(workflowDetailPath(submitState.workflowId));
        }}
      >
        View →
      </a>
    </div>
  {:else if submitState.status === 'error' && submitState.isSpentIdempotencyKey}
    <div class="weft-start-review__result weft-start-review__result--conflict">
      <GitPullRequestClosed aria-hidden="true" size={16} />
      <span>
        A workflow with this idempotency key has already run and was purged — start with a new key.
      </span>
    </div>
  {:else if submitState.status === 'error'}
    <QueryFaultBanner error={submitState.error} onRetry={onSubmit} />
  {/if}

  {#if submitState.status !== 'success'}
    <div class="weft-start-review__actions">
      <button type="button" class="weft-start-review__back" onclick={onBack}>Back</button>
      <button
        type="button"
        class="weft-start-review__submit"
        disabled={submitState.status === 'pending'}
        onclick={onSubmit}
      >
        {submitState.status === 'pending' ? 'Starting…' : 'Start workflow'}
      </button>
    </div>
  {/if}
</div>
