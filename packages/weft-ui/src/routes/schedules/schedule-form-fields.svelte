<script lang="ts">
  /**
   * Field body for the create/edit schedule drawer (Track B; design
   * `Weft New Surfaces.dc.html` §A2 — layout binding, see
   * `overlap-policy.ts`'s doc for the one deliberate copy departure).
   * Mutates the passed-in `form` (`ScheduleFormState`) instance directly —
   * a plain rune-backed class, not a bindable prop, so field edits here are
   * visible to the parent drawer without prop-drilling every field.
   *
   * `mode: 'edit'` disables the workflow type, input payload, overlap
   * policy, jitter, and backfill fields — `weft.schedules.update` only
   * accepts a new cadence (`schedule-queries.ts`'s `updateScheduleSpec` doc);
   * this is honesty, not decoration, so it stays in the same layout the
   * create form uses rather than hiding the now-uneditable fields.
   */
  import Input from '@lostgradient/cinder/input';
  import { RadioGroup } from '@lostgradient/cinder/radio-group';
  import ScheduleBuilder from '@lostgradient/cinder/schedule-builder';
  import type { ScheduleValue } from '@lostgradient/cinder/schedule-builder';
  import Select from '@lostgradient/cinder/select';
  import Toggle from '@lostgradient/cinder/toggle';
  import { TriangleAlert } from 'lucide-svelte';
  import { untrack } from 'svelte';

  import type { ScheduleOverlapPolicy } from '@lostgradient/weft';

  import { computeNextFires } from '../../lib/format/cron-preview.ts';
  import JsonEditor from '@lostgradient/cinder/json-editor';
  import { OVERLAP_POLICIES } from './overlap-policy.ts';
  import type { ScheduleFormState } from './schedule-form-state.svelte.ts';

  interface Props {
    form: ScheduleFormState;
    mode: 'create' | 'edit';
    /** Registry-driven workflow type options, or `undefined` to fall back to a free-text field (plan §9.3: workflow picker degrades when `system:read` is unavailable — the create action itself doesn't require it). */
    workflowTypeOptions: readonly string[] | undefined;
  }

  let { form, mode, workflowTypeOptions }: Props = $props();

  function onCadenceChange(next: ScheduleValue): void {
    form.cadence = next;
  }

  const OVERLAP_VALUES: ReadonlySet<string> = new Set(
    OVERLAP_POLICIES.map((policy) => policy.value),
  );

  function isOverlapPolicy(value: string): value is ScheduleOverlapPolicy {
    return OVERLAP_VALUES.has(value);
  }

  /**
   * `RadioGroup.value` is a plain `$bindable() string`, not generic over
   * `ScheduleOverlapPolicy` — a proxy local avoids widening `form.overlap`'s
   * type to `string` via a direct `bind:value={form.overlap}`. Initialized
   * once from `form.overlap`; the only other writer of `form.overlap` is
   * `ScheduleFormState`'s own constructor, which always runs before this
   * component mounts, so a one-way write-back (draft → form) is sufficient —
   * no ping-pong sync needed back the other way.
   */
  let overlapDraft = $state(untrack(() => form.overlap));

  $effect(() => {
    if (isOverlapPolicy(overlapDraft)) form.overlap = overlapDraft;
  });
</script>

<div class="weft-schedule-form">
  <section class="weft-schedule-form__section">
    <h3 class="weft-schedule-form__section-title">Basics</h3>
    {#if mode === 'create'}
      <Input
        id="weft-schedule-form-id"
        label="Schedule ID"
        description="Optional — auto-generated when left blank."
        placeholder="auto-generate"
        bind:value={form.id}
        error={form.errors.id ?? ''}
      />
    {/if}
    {#if mode === 'create' && workflowTypeOptions !== undefined}
      <Select
        id="weft-schedule-form-workflow-type"
        label="Workflow type"
        bind:value={form.workflowType}
        options={workflowTypeOptions.map((type) => ({ value: type, label: type }))}
        error={form.errors.workflowType ?? ''}
      />
    {:else if mode === 'create'}
      <Input
        id="weft-schedule-form-workflow-type"
        label="Workflow type"
        description="Registry lookup unavailable — enter the workflow type name."
        bind:value={form.workflowType}
        error={form.errors.workflowType ?? ''}
      />
    {:else}
      <Input
        id="weft-schedule-form-workflow-type"
        label="Workflow type"
        value={form.workflowType}
        disabled
      />
    {/if}
    {#if mode === 'create'}
      <JsonEditor
        id="weft-schedule-form-input"
        label="Input (JSON)"
        description="The payload passed to each launched run."
        rows={3}
        value={form.inputText}
        onValueChange={(next) => (form.inputText = next)}
        highlight
        validFeedbackVisible={false}
        error={form.errors.input ?? ''}
      />
    {/if}
  </section>

  <section class="weft-schedule-form__section">
    <h3 class="weft-schedule-form__section-title">Cadence</h3>
    <ScheduleBuilder
      value={form.cadence}
      onValueChange={onCadenceChange}
      {computeNextFires}
      timezoneLabel="UTC"
      label="Cadence"
    />
  </section>

  <section class="weft-schedule-form__section">
    <RadioGroup
      name="weft-schedule-overlap"
      label="If a run is still going when the next fire is due"
      variant="card"
      disabled={mode === 'edit'}
      bind:value={overlapDraft}
    >
      {#each OVERLAP_POLICIES as policy (policy.value)}
        <RadioGroup.Option
          id={`weft-schedule-overlap-${policy.value}`}
          value={policy.value}
          label={policy.label}
          description={policy.consequence}
        />
      {/each}
    </RadioGroup>

    <div class="weft-schedule-form__row">
      <Input
        id="weft-schedule-form-jitter"
        label="Jitter"
        description="Random delay added to each fire."
        placeholder="30s"
        disabled={mode === 'edit'}
        bind:value={form.jitterText}
        error={form.errors.jitter ?? ''}
      />
      <label class="weft-schedule-form__toggle-field">
        <Toggle
          id="weft-schedule-form-start-paused"
          label="Start paused"
          disabled={mode === 'edit'}
          bind:checked={form.startPaused}
        />
        <span class="weft-schedule-form__toggle-description">
          Created paused — no fires until you resume it.
        </span>
      </label>
    </div>

    <label class="weft-schedule-form__backfill">
      <Toggle
        id="weft-schedule-form-backfill"
        label="Backfill missed occurrences"
        disabled={mode === 'edit'}
        bind:checked={form.backfill}
      />
    </label>
    {#if form.backfill}
      <div class="weft-schedule-form__backfill-warning">
        <TriangleAlert aria-hidden="true" size={14} />
        <span>
          If the schedule falls behind (for example, the engine was down), missed occurrences fire
          immediately in a bounded catch-up window instead of being skipped.
        </span>
      </div>
    {/if}
    {#if mode === 'edit'}
      <p class="weft-schedule-form__edit-note">
        Overlap policy, jitter, backfill, and workflow input can only be set at creation today —
        editing updates the cadence only.
      </p>
    {/if}
  </section>
</div>

<style>
  .weft-schedule-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .weft-schedule-form__section {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .weft-schedule-form__section-title {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }

  .weft-schedule-form__row {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }

  .weft-schedule-form__row > :global(*) {
    flex: 1;
  }

  .weft-schedule-form__toggle-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .weft-schedule-form__toggle-description,
  .weft-schedule-form__edit-note {
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-disabled);
  }

  .weft-schedule-form__backfill-warning {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    padding: 10px 12px;
    background: var(--cinder-color-warning-bg);
    border: 1px solid var(--cinder-color-warning-border);
    border-radius: var(--cinder-radius-md);
    color: var(--cinder-color-warning-fg);
    font-size: var(--cinder-text-xs);
  }

  .weft-schedule-form__edit-note {
    margin: 0;
  }
</style>
