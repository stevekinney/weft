<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type { HTMLSelectAttributes } from 'svelte/elements';

  export type SelectProps = Omit<HTMLSelectAttributes, 'size' | 'id'> & {
    id: string;
    error?: string;
    fullWidth?: boolean;
    label: string;
    hideLabel?: boolean;
    description?: string;
    children?: Snippet;
  };
</script>

<script lang="ts">
  import { cn } from '../utilities/class-names.ts';

  let {
    class: className,
    error,
    fullWidth = true,
    label,
    hideLabel = false,
    description,
    id,
    required,
    disabled,
    children,
    value = $bindable(),
    ...rest
  }: SelectProps = $props();

  const descriptionId = $derived(description ? `${id}-description` : undefined);
  const errorId = $derived(error ? `${id}-error` : undefined);
  const describedBy = $derived([descriptionId, errorId].filter(Boolean).join(' ') || undefined);
</script>

<div class={cn('form-field', fullWidth && 'full-width', className)}>
  <label
    for={id}
    class={cn('field-label', hideLabel && 'sr-only')}
    data-disabled={disabled}
  >
    {label}
    {#if required}
      <span class="field-required" aria-hidden="true"></span>
      <span class="sr-only">(required)</span>
    {/if}
  </label>
  <div class="select-wrapper">
    <select
      {id}
      class="form-control"
      aria-invalid={error ? 'true' : undefined}
      aria-describedby={describedBy}
      {required}
      {disabled}
      bind:value
      {...rest}
    >
      {@render children?.()}
    </select>
    <div class="select-caret" aria-hidden="true">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
        <path
          fill-rule="evenodd"
          d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
          clip-rule="evenodd"
        />
      </svg>
    </div>
  </div>
  {#if description}
    <p id={descriptionId} class="field-description">{description}</p>
  {/if}
  {#if error}
    <p id={errorId} class="field-error">{error}</p>
  {/if}
</div>

<style>
  .form-field {
    display: flex;
    flex-direction: column;
    gap: var(--field-gap, var(--space-1-5, 0.375rem));
  }

  .full-width {
    width: 100%;
  }

  .field-label {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1, 0.25rem);
    font-size: var(--text-xs, 0.75rem);
    font-weight: var(--font-medium, 500);
    line-height: 1;
    color: var(--text, #111827);
  }

  .field-label[data-disabled='true'] {
    cursor: not-allowed;
  }

  .field-required {
    flex-shrink: 0;
    width: 0.375rem;
    height: 0.375rem;
    background: var(--error, #dc2626);
    border-radius: 50%;
  }

  .select-wrapper {
    position: relative;
  }

  .form-control {
    padding-right: var(--space-8, 2rem);
  }

  .select-caret {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    padding-right: var(--space-2, 0.5rem);
    pointer-events: none;
  }

  .select-caret svg {
    width: 0.875rem;
    height: 0.875rem;
    color: var(--text-subtle, #9ca3af);
  }

  .field-description {
    font-size: var(--text-sm, 0.875rem);
    color: var(--text-muted, #6b7280);
  }

  .field-error {
    font-size: var(--text-sm, 0.875rem);
    color: var(--field-error-color, var(--error, #dc2626));
  }
</style>
