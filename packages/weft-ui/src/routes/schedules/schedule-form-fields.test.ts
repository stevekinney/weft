/**
 * Component tests for `<ScheduleFormFields>` — a pure presentational
 * component (no client/query/principal context needed), so these render
 * standalone.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import ScheduleFormFields from './schedule-form-fields.svelte';
import { ScheduleFormState } from './schedule-form-state.svelte.ts';

describe('ScheduleFormFields — create mode', () => {
  test('renders a workflow-type Select when registry options are available', async () => {
    const form = new ScheduleFormState();

    const { getByRole, queryByText } = render(ScheduleFormFields, {
      props: { form, mode: 'create', workflowTypeOptions: ['report-gen', 'cache-warm'] },
    });

    expect(getByRole('combobox', { name: 'Workflow type' })).not.toBeNull();
    expect(
      queryByText('No registered workflow types found — enter the workflow type name.'),
    ).toBeNull();
  });

  test('degrades to a free-text field when registry options are unavailable', async () => {
    const form = new ScheduleFormState();

    const { getByText, queryByRole } = render(ScheduleFormFields, {
      props: { form, mode: 'create', workflowTypeOptions: undefined },
    });

    expect(
      getByText('No registered workflow types found — enter the workflow type name.'),
    ).not.toBeNull();
    expect(queryByRole('combobox', { name: 'Workflow type' })).toBeNull();
  });

  test('degrades to a free-text field when the registry resolves with zero registered workflow types', async () => {
    // A resolved-but-empty `activeRevisions` (WFT-6) is a distinct state from
    // still-loading/errored (both collapse to `undefined` upstream in
    // `schedule-form-drawer.svelte`) — an empty array is `!== undefined`, so
    // this must be handled explicitly rather than falling out of the same
    // check, or a genuinely empty registry renders an unusable zero-option
    // Select instead of the free-text fallback.
    const form = new ScheduleFormState();

    const { getByText, queryByRole } = render(ScheduleFormFields, {
      props: { form, mode: 'create', workflowTypeOptions: [] },
    });

    expect(
      getByText('No registered workflow types found — enter the workflow type name.'),
    ).not.toBeNull();
    expect(queryByRole('combobox', { name: 'Workflow type' })).toBeNull();
  });

  test('shows the schedule id, input JSON, and cadence fields', async () => {
    const form = new ScheduleFormState();

    const { getByRole } = render(ScheduleFormFields, {
      props: { form, mode: 'create', workflowTypeOptions: [] },
    });

    expect(getByRole('textbox', { name: 'Schedule ID' })).not.toBeNull();
    expect(getByRole('textbox', { name: 'Input (JSON)' })).not.toBeNull();
  });

  test('selecting an overlap policy updates the form and shows its consequence', async () => {
    const form = new ScheduleFormState();

    const { getByRole, getByText } = render(ScheduleFormFields, {
      props: { form, mode: 'create', workflowTypeOptions: [] },
    });

    expect(
      getByText(
        'Concurrent runs are permitted. Multiple instances may run simultaneously. Use only if the workflow is safe to parallelize.',
      ),
    ).not.toBeNull();

    await fireEvent.click(getByRole('radio', { name: 'Allow' }));

    expect(form.overlap).toBe('allow');
  });

  test('enabling backfill shows the catch-up-window warning', async () => {
    const form = new ScheduleFormState();

    const { getByRole, queryByText, getByText } = render(ScheduleFormFields, {
      props: { form, mode: 'create', workflowTypeOptions: [] },
    });

    expect(queryByText(/missed occurrences fire/)).toBeNull();
    await fireEvent.click(getByRole('switch', { name: 'Backfill missed occurrences' }));

    expect(form.backfill).toBe(true);
    expect(getByText(/missed occurrences fire/)).not.toBeNull();
  });

  test('shows a field-level error message for invalid JSON input', async () => {
    const form = new ScheduleFormState({ inputText: '{not json' });

    const { getByText } = render(ScheduleFormFields, {
      props: { form, mode: 'create', workflowTypeOptions: [] },
    });

    expect(getByText('Must be valid JSON.')).not.toBeNull();
  });
});

describe('ScheduleFormFields — edit mode', () => {
  test('disables workflow type, input, overlap policy, jitter, and backfill; shows the edit-scope note', async () => {
    const form = new ScheduleFormState({
      id: 'nightly-rollup',
      workflowType: 'report-gen',
      overlap: 'queue',
    });

    const { getByRole, getByText, queryByRole } = render(ScheduleFormFields, {
      props: { form, mode: 'edit', workflowTypeOptions: undefined },
    });

    expect((getByRole('textbox', { name: 'Workflow type' }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(queryByRole('textbox', { name: 'Input (JSON)' })).toBeNull();
    expect(queryByRole('textbox', { name: 'Schedule ID' })).toBeNull();
    expect((getByRole('radio', { name: 'Skip' }) as HTMLInputElement).disabled).toBe(true);
    expect((getByRole('textbox', { name: 'Jitter' }) as HTMLInputElement).disabled).toBe(true);
    expect(
      (getByRole('switch', { name: 'Backfill missed occurrences' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      getByText(
        'Overlap policy, jitter, backfill, and workflow input can only be set at creation today — editing updates the cadence only.',
      ),
    ).not.toBeNull();
  });
});
