/**
 * Component tests for `<RegistryTab>` (plan §9.7 T7.2). Covers loading,
 * fault, 3-step onboarding empty state, the definitions list, and drilling
 * into a definition's detail panel (Appendix B: "Registry (schema tree)").
 */
import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { createQueryClient } from '../../lib/query.ts';
import RegistryTab from './registry-tab.svelte';
import SystemRouteTestHarness from './system-route-test-harness.test-harness.svelte';
import { realClient, ScriptedFetch } from './system-test-support.test-support.ts';

let scripted: ScriptedFetch | undefined;

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

async function renderRegistryTab(
  manifestFixtures: {
    workers?: readonly Record<string, unknown>[];
    diagnostics?: unknown;
    rejections?: readonly Record<string, unknown>[];
  } = {},
) {
  scripted?.routeJsonRpcMethod('weft.workers.list', {
    items: manifestFixtures.workers ?? [],
    deployments: [],
    routingPolicy: 'least-loaded',
  });
  scripted?.routeJsonRpcMethod('weft.workers.rejections', {
    items: manifestFixtures.rejections ?? [],
    limit: 25,
  });
  if (manifestFixtures.diagnostics !== undefined) {
    scripted?.routeJsonRpcMethod('weft.workers.diagnostics', manifestFixtures.diagnostics);
  }
  return render(SystemRouteTestHarness, {
    props: { client: realClient(), queryClient: createQueryClient(), component: RegistryTab },
  });
}

describe('RegistryTab', () => {
  test('shows a loading state while the query is pending', async () => {
    scripted = new ScriptedFetch();
    // No response queued — the request stays pending for this assertion.
    const { getByLabelText } = await renderRegistryTab();
    expect(getByLabelText('Loading registry')).not.toBeNull();
  });

  test('shows the fault banner on a failed fetch, with a working Retry', async () => {
    scripted = new ScriptedFetch();
    scripted.enqueueJson(
      {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'Forbidden', data: { httpStatus: 403 } },
      },
      { status: 200 },
    );
    scripted.enqueueJsonRpcResult({ registryVersion: 1, workflows: {}, activities: {} });
    const { findByText, getByRole } = await renderRegistryTab();
    expect(await findByText('Not authorized')).not.toBeNull();

    await fireEvent.click(getByRole('button', { name: 'Retry' }));
    expect(await findByText('Install the SDK', { exact: false })).not.toBeNull();
  });

  test('renders the 3-step onboarding empty state when nothing is registered', async () => {
    scripted = new ScriptedFetch();
    scripted.enqueueJsonRpcResult({ registryVersion: 1, workflows: {}, activities: {} });
    const { findByText } = await renderRegistryTab();
    expect(await findByText('Install the SDK', { exact: false })).not.toBeNull();
  });

  test('adds accepted worker-manifest and admission diagnostics to the registry surface', async () => {
    scripted = new ScriptedFetch();
    scripted.enqueueJsonRpcResult({ registryVersion: 1, workflows: {}, activities: {} });
    const { findByText } = await renderRegistryTab({
      workers: [{ id: 'worker-a' }],
      diagnostics: {
        worker: {
          instance: {
            workerId: 'worker-a',
            queue: 'default',
            health: 'active',
            connectedAt: 1,
            startedAt: 1,
            lastHeartbeatAt: 1,
            heartbeatAgeMs: 1,
          },
          deploymentVersion: {
            deploymentName: 'payments',
            buildId: 'build-7',
            artifactDigest: 'sha256:artifact',
            runtimeName: 'bun',
            runtimeVersion: '1.4.0',
            sdkVersion: '0.20.0',
            manifestVersion: 1,
            protocolVersion: 3,
            manifestDigest: 'sha256:manifest',
            workflows: {},
          },
        },
      },
      rejections: [{ code: 'registration_rejected', rejectedAt: 9, workerId: 'worker-b' }],
    });

    expect(await findByText('Worker registry admission diagnostics')).not.toBeNull();
    expect(await findByText(/accepted and routing-eligible/)).not.toBeNull();
    expect(await findByText('Admission policy rejected')).not.toBeNull();
  });

  test('lists workflow definitions and activities, then drills into a definition detail', async () => {
    scripted = new ScriptedFetch();
    scripted.enqueueJsonRpcResult({
      registryVersion: 1,
      workflows: {
        'order-processing': {
          description: 'Processes an order end to end.',
          tags: ['payments'],
          inputSchema: {
            type: 'object',
            required: ['orderId'],
            properties: {
              orderId: { type: 'string' },
              note: { type: 'string' },
            },
          },
        },
        heartbeat: {},
      },
      activities: {
        chargeCard: {
          queue: 'default',
          inputSchema: {
            type: 'object',
            required: ['amount'],
            properties: { amount: { type: 'number' } },
          },
        },
      },
    });

    const { findByText, findAllByText, getByRole } = await renderRegistryTab();

    expect(await findByText('order-processing')).not.toBeNull();
    expect(await findByText('chargeCard')).not.toBeNull();
    const fieldCountBadge = await findByText('2 fields');
    expect(fieldCountBadge.getAttribute('data-cinder-variant')).toBe('success');
    expect(fieldCountBadge.getAttribute('data-cinder-size')).toBe('md');

    const noSchemaBadge = await findByText('none');
    expect(noSchemaBadge.getAttribute('data-cinder-variant')).toBe('neutral');
    expect(noSchemaBadge.getAttribute('data-cinder-size')).toBe('md');

    const queueBadge = await findByText('queue: default');
    expect(queueBadge.getAttribute('data-cinder-variant')).toBe('neutral');
    expect(queueBadge.getAttribute('data-cinder-size')).toBe('md');

    const activityFieldCountBadge = await findByText('1 field');
    expect(activityFieldCountBadge.getAttribute('data-cinder-variant')).toBe('success');
    expect(activityFieldCountBadge.getAttribute('data-cinder-size')).toBe('md');

    await fireEvent.click(getByRole('button', { name: /order-processing/ }));

    expect(await findByText('Processes an order end to end.')).not.toBeNull();
    const paymentElements = await findAllByText('payments');
    const tagBadge = paymentElements.find(
      (element) => element.getAttribute('data-cinder-variant') !== null,
    );
    expect(tagBadge?.getAttribute('data-cinder-variant')).toBe('neutral');
    expect(tagBadge?.getAttribute('data-cinder-size')).toBe('md');
    const orderIdMatches = await findAllByText('orderId');
    expect(orderIdMatches.length).toBeGreaterThan(0);

    const typeBadges = await findAllByText('string');
    expect(typeBadges).toHaveLength(2);
    for (const typeBadge of typeBadges) {
      expect(typeBadge.getAttribute('data-cinder-monospace')).toBe('');
      expect(typeBadge.getAttribute('data-cinder-size')).toBe('md');
    }

    const requiredBadge = await findByText('required');
    expect(requiredBadge.getAttribute('data-cinder-variant')).toBe('warning');
    expect(requiredBadge.getAttribute('data-cinder-size')).toBe('md');

    const optionalBadge = await findByText('optional');
    expect(optionalBadge.getAttribute('data-cinder-variant')).toBe('neutral');
    expect(optionalBadge.getAttribute('data-cinder-size')).toBe('md');

    await fireEvent.click(getByRole('button', { name: 'Workflow definitions' }));
    expect(await findByText('order-processing')).not.toBeNull();

    await fireEvent.click(getByRole('button', { name: /heartbeat/ }));
    expect(
      await findByText('No input schema declared — this definition accepts an untyped payload.'),
    ).not.toBeNull();
  });

  test('shows the honest "no activities" note when the engine has none registered', async () => {
    scripted = new ScriptedFetch();
    scripted.enqueueJsonRpcResult({
      registryVersion: 1,
      workflows: { heartbeat: {} },
      activities: {},
    });
    const { findByText } = await renderRegistryTab();
    expect(await findByText('No activities registered for this engine.')).not.toBeNull();
  });

  test('renders a nested object field as an expandable schema tree branch', async () => {
    scripted = new ScriptedFetch();
    scripted.enqueueJsonRpcResult({
      registryVersion: 1,
      workflows: {
        'order-processing': {
          inputSchema: {
            type: 'object',
            required: ['address'],
            properties: {
              address: {
                type: 'object',
                required: ['city'],
                properties: { city: { type: 'string' }, zip: { type: 'string' } },
              },
            },
          },
        },
      },
      activities: {},
    });

    const { findAllByText, findByRole } = await renderRegistryTab();

    await fireEvent.click(await findByRole('button', { name: /order-processing/ }));

    const addressMatches = await findAllByText('address');
    expect(addressMatches.length).toBeGreaterThan(0);
    // The nested object's own children render only once its `Tree.Item`
    // branch is expanded (Cinder's `shouldRenderChildren`).
    const expandAddress = await findByRole('button', { name: 'Expand address' });
    await fireEvent.click(expandAddress);
    const cityMatches = await findAllByText('city');
    expect(cityMatches.length).toBeGreaterThan(0);
    const zipMatches = await findAllByText('zip');
    expect(zipMatches.length).toBeGreaterThan(0);
  });
});
