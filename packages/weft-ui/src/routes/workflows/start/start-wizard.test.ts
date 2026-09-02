import { QueryClient } from '@tanstack/svelte-query';
import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { Principal } from '../../../lib/scopes.svelte.ts';
import { realClient, ScriptedFetch } from '../list/workflow-test-support.test-support.ts';
import StartWizardHarness from './start-wizard.test-harness.svelte';

const GRANTED_PRINCIPAL: Principal = {
  scopes: ['workflows:write', 'system:read'],
  unauthenticatedAccess: null,
};

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

let fetchScript: ScriptedFetch;

beforeEach(() => {
  fetchScript = new ScriptedFetch();
});

afterEach(() => {
  fetchScript.restore();
});

describe('StartWizard', () => {
  test('shows the denied message without workflows:write', async () => {
    fetchScript.routeJsonRpcMethod('weft.system.registry', {
      registryVersion: 2,
      generatedAt: '2026-01-01T00:00:00.000Z',
      workflows: [],
      activeRevisions: {},
      activities: {},
    });

    const { findByRole } = render(StartWizardHarness, {
      props: {
        client: realClient(),
        principal: { scopes: [], unauthenticatedAccess: null },
        queryClient: newQueryClient(),
      },
    });

    expect(await findByRole('alert')).not.toBeNull();
  });

  test('falls back to a free-text type field when the registry has no entries', async () => {
    fetchScript.routeJsonRpcMethod('weft.system.registry', {
      registryVersion: 2,
      generatedAt: '2026-01-01T00:00:00.000Z',
      workflows: [],
      activeRevisions: {},
      activities: {},
    });

    const { findByText } = render(StartWizardHarness, {
      props: { client: realClient(), principal: GRANTED_PRINCIPAL, queryClient: newQueryClient() },
    });

    expect(await findByText(/enter the exact workflow type name/)).not.toBeNull();
  });

  test('completes the full flow: type → raw JSON configure → review → start', async () => {
    fetchScript.routeJsonRpcMethod('weft.system.registry', {
      registryVersion: 2,
      generatedAt: '2026-01-01T00:00:00.000Z',
      workflows: [
        {
          manifestVersion: 1,
          name: 'order-processing',
          workflowVersion: '1.0.0',
          revision: 'order-processing-rev',
          contractHash: 'order-processing-hash',
          contract: { name: 'order-processing', workflowVersion: '1.0.0' },
        },
      ],
      activeRevisions: { 'order-processing': 'order-processing-rev' },
      activities: {},
    });
    fetchScript.routeUrl('/v1/workflows', { id: 'wf_started_1234567890' });

    const { findByLabelText, findByRole, getByRole, findByText } = render(StartWizardHarness, {
      props: { client: realClient(), principal: GRANTED_PRINCIPAL, queryClient: newQueryClient() },
    });

    const typeInput = await findByLabelText('Workflow type');
    await fireEvent.input(typeInput, { target: { value: 'order-processing' } });

    const nextButton = await findByRole('button', { name: 'Next: configure' });
    expect((nextButton as HTMLButtonElement).disabled).toBe(false);
    await fireEvent.click(nextButton);

    const jsonField = await findByLabelText('Payload (JSON)');
    await fireEvent.input(jsonField, { target: { value: '{"orderId":"ord-1"}' } });

    const continueButton = getByRole('button', { name: 'Continue to review' });
    expect((continueButton as HTMLButtonElement).disabled).toBe(false);
    await fireEvent.click(continueButton);

    expect(await findByText('order-processing')).not.toBeNull();
    const startButton = await findByRole('button', { name: 'Start workflow' });
    await fireEvent.click(startButton);

    const link = await findByRole('link', { name: 'View →' });
    expect(link.getAttribute('href')).toBe('/workflows/wf_started_1234567890');
  });
});
