import { afterEach, describe, expect, it, mock } from 'bun:test';

import { ApiClient, type ReviewDecision } from './api-client.ts';

function requestInputToUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}

function requestBodyToJson(init: RequestInit | undefined): Record<string, unknown> {
  const body = init?.body;
  if (typeof body !== 'string') {
    throw new Error('Expected request body to be a JSON string');
  }

  return JSON.parse(body) as Record<string, unknown>;
}

describe('ApiClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('reads workflow list filters and serializes scalar query parameters', async () => {
    let requestedUrl = '';

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = requestInputToUrl(input);
      return Response.json({ items: [], total: 0, offset: 2, limit: 10 });
    }) as typeof fetch;

    const client = new ApiClient();
    await client.listWorkflows({
      status: 'running',
      type: 'echo',
      tags: ['nightly', 'v2'],
      limit: 10,
      offset: 2,
    });

    expect(requestedUrl).toContain('/v1/workflows?');
    expect(requestedUrl).toContain('status=running');
    expect(requestedUrl).toContain('type=echo');
    expect(requestedUrl).toContain('tag=nightly');
    expect(requestedUrl).toContain('tag=v2');
    expect(requestedUrl).toContain('limit=10');
    expect(requestedUrl).toContain('offset=2');
  });

  it('requests the plain workflow list path when no filters are provided', async () => {
    let requestedUrl = '';

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = requestInputToUrl(input);
      return Response.json({ items: [], total: 0, offset: 0, limit: 20 });
    }) as typeof fetch;

    const client = new ApiClient();
    await client.listWorkflows();

    expect(requestedUrl).toBe('/v1/workflows');
  });

  it('calls /v1/retention and returns the parsed overview', async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe('/v1/retention');

      return new Response(
        JSON.stringify({
          sweepIntervalMs: 300_000,
          sweepBatchSize: 1000,
          nextSweepAt: 123_456,
          defaultRetention: { completed: 300_000 },
          workflowTypes: [
            {
              type: 'echo',
              source: 'engine',
              retention: { completed: 300_000 },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new ApiClient();
    const overview = await client.getRetentionOverview();

    expect(overview.nextSweepAt).toBe(123_456);
    expect(overview.workflowTypes).toEqual([
      expect.objectContaining({
        type: 'echo',
        source: 'engine',
      }),
    ]);
  });

  it('serializes dashboard workflow tag filters as repeated tag query parameters', async () => {
    let requestedUrl = '';

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = requestInputToUrl(input);
      return new Response(
        JSON.stringify({
          items: [],
          total: 0,
          offset: 0,
          limit: 20,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }) as typeof fetch;

    const client = new ApiClient();
    await client.listWorkflows({ tags: ['nightly', 'v2'] });

    expect(requestedUrl).toContain('/v1/workflows?');
    expect(requestedUrl).toContain('tag=nightly');
    expect(requestedUrl).toContain('tag=v2');
  });

  it('covers the remaining client endpoints and request shaping', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const decision: ReviewDecision = {
      decision: 'approved',
      reviewer: 'Ada',
      feedback: 'Looks good',
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestInputToUrl(input);
      requests.push(init === undefined ? { url } : { url, init });

      if (url === '/v1/workflows/workflow%20id' && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }

      if (url === '/v1/workflows/workflow%20id') {
        return Response.json({
          id: 'workflow id',
          type: 'echo',
          status: 'running',
          input: { ok: true },
          version: '1.0.0',
          createdAt: 1,
          updatedAt: 2,
        });
      }

      if (url === '/v1/workflows/workflow%20id/signal/approve%2Fdeny') {
        return new Response(null, { status: 204 });
      }

      if (url === '/v1/workflows/workflow%20id/events') {
        return Response.json({
          events: [{ type: 'workflow.started', timestamp: 1, data: { step: 1 } }],
        });
      }

      if (url === '/v1/workflows/workflow%20id/attributes') {
        return Response.json({ region: 'west' });
      }

      if (url === '/v1/reviews') {
        return Response.json({
          items: [
            {
              reviewId: 'review-1',
              workflowId: 'workflow id',
              artifact: { type: 'diff' },
              reviewType: 'approval',
              reviewers: ['Ada'],
              createdAt: 1,
            },
          ],
        });
      }

      if (url === '/v1/reviews/review%2F1/decision') {
        return new Response(null, { status: 204 });
      }

      if (url === '/v1/health') {
        return Response.json({ status: 'ok' });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const client = new ApiClient();
    expect(await client.getWorkflow('workflow id')).toEqual(
      expect.objectContaining({ id: 'workflow id', status: 'running' }),
    );
    await client.cancelWorkflow('workflow id');
    await client.signalWorkflow('workflow id', 'approve/deny', { ok: true });
    expect(await client.getWorkflowEvents('workflow id')).toEqual([
      { type: 'workflow.started', timestamp: 1, data: { step: 1 } },
    ]);
    expect(await client.getWorkflowAttributes('workflow id')).toEqual({ region: 'west' });
    expect(await client.listPendingReviews()).toEqual([
      expect.objectContaining({ reviewId: 'review-1' }),
    ]);
    await client.submitReviewDecision('review/1', 'workflow id', decision);
    expect(await client.checkHealth()).toEqual({ status: 'ok' });

    expect(requests.map((entry) => entry.url)).toEqual([
      '/v1/workflows/workflow%20id',
      '/v1/workflows/workflow%20id',
      '/v1/workflows/workflow%20id/signal/approve%2Fdeny',
      '/v1/workflows/workflow%20id/events',
      '/v1/workflows/workflow%20id/attributes',
      '/v1/reviews',
      '/v1/reviews/review%2F1/decision',
      '/v1/health',
    ]);

    expect(requests[1]?.init?.method).toBe('DELETE');
    expect(requests[2]?.init?.method).toBe('POST');
    expect(requests[2]?.init?.headers).toBeDefined();
    expect(requests[2]?.init?.body).toBe(JSON.stringify({ payload: { ok: true } }));
    expect(requests[6]?.init?.method).toBe('POST');
    expect(requests[6]?.init?.body).toBe(
      JSON.stringify({ ...decision, workflowId: 'workflow id' }),
    );
  });

  it('fetches workflow timeline and replay data for dashboard time-travel views', async () => {
    const requests: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = requestInputToUrl(input);
      requests.push(url);

      if (url === '/v1/workflows/workflow%20id/timeline') {
        return Response.json([
          {
            step: 1,
            operationType: 'activity',
            operationLabel: 'loadOrder',
            inputSummary: '{"orderId":"order-1"}',
            outputSummary: '{"total":42}',
            duration: 8,
            timestamp: 1_000,
            status: 'completed',
          },
        ]);
      }

      if (url === '/v1/workflows/workflow%20id/replay/2') {
        return Response.json({
          checkpoint: {
            step: 2,
            locals: { approved: true },
            searchAttributes: { status: 'approved' },
            version: '1.0.0',
            createdAt: 2_000,
          },
          accumulatedResults: [[1, { total: 42 }]],
          events: [{ type: 'workflow:checkpoint', timestamp: 2_000, data: { step: 2 } }],
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const client = new ApiClient();
    const timeline = await client.getWorkflowTimeline('workflow id');
    const replay = await client.replayWorkflowTo('workflow id', 2);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.operationLabel).toBe('loadOrder');
    expect(replay?.checkpoint.step).toBe(2);
    expect(replay?.checkpoint.locals).toEqual({ approved: true });
    expect(requests).toEqual([
      '/v1/workflows/workflow%20id/timeline',
      '/v1/workflows/workflow%20id/replay/2',
    ]);
  });

  it('returns null when workflow replay checkpoint data is not retained', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = requestInputToUrl(input);

      if (url === '/v1/workflows/workflow%20id/replay/3') {
        return Response.json(
          { error: 'Replay not found at step 3 for workflow workflow id' },
          {
            status: 404,
            statusText: 'Not Found',
          },
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const client = new ApiClient();
    await expect(client.replayWorkflowTo('workflow id', 3)).resolves.toBeNull();
  });

  it('fetches task diagnostics with encoded filters for workflow detail evidence', async () => {
    let requestedUrl = '';

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = requestInputToUrl(input);
      return Response.json({
        items: [
          {
            kind: 'stale-inflight',
            operationId: 'operation-1',
            workflowId: 'workflow id',
            activityName: 'charge',
            queue: 'payments',
            state: 'inflight',
            workerId: 'worker-1',
            retryCount: 2,
            requeueCount: 1,
            heartbeatAgeMs: 5_000,
            evidence: ['worker worker-1 heartbeat is stale'],
          },
        ],
        summary: {
          stuckQueued: 0,
          staleInflight: 1,
          retryStorms: 0,
          allWorkersAtCapacity: 0,
        },
        limit: 25,
      });
    }) as typeof fetch;

    const client = new ApiClient();
    const diagnostics = await client.getTaskDiagnostics({
      workflowId: 'workflow id',
      queue: 'payments',
      limit: 25,
    });

    expect(requestedUrl).toBe(
      '/v1/tasks/diagnostics?workflowId=workflow+id&queue=payments&limit=25',
    );
    expect(diagnostics.items[0]?.operationId).toBe('operation-1');
    expect(diagnostics.items[0]?.queue).toBe('payments');
  });

  it('prefers API error payloads and falls back to status text when parsing fails', async () => {
    let callCount = 0;

    globalThis.fetch = (async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: 'workflow exploded' }), {
          status: 500,
          statusText: 'Internal Server Error',
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('not-json', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'Content-Type': 'text/plain' },
      });
    }) as unknown as typeof fetch;

    const client = new ApiClient();

    await expect(client.getWorkflow('bad')).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      message: 'workflow exploded',
    });
    await expect(client.getWorkflow('still-bad')).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      message: 'Bad Gateway',
    });
  });

  it('serializes schedule filters and returns parsed schedule summaries', async () => {
    let requestedUrl = '';

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = requestInputToUrl(input);
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'nightly-maintenance',
              workflowType: 'echo',
              cronExpression: '0 * * * *',
              status: 'active',
              overlap: 'queue',
              backfill: true,
              createdAt: 1,
              updatedAt: 2,
              lastFireAt: 3,
              nextFireAt: 4,
              queuedRuns: 0,
            },
          ],
          total: 1,
          offset: 0,
          limit: 10,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }) as typeof fetch;

    const client = new ApiClient();
    const schedules = await client.listSchedules({
      status: ['active', 'paused'],
      workflowType: 'echo',
      limit: 10,
      offset: 20,
    });

    expect(requestedUrl).toContain('/v1/schedules?');
    expect(requestedUrl).toContain('status=active');
    expect(requestedUrl).toContain('status=paused');
    expect(requestedUrl).toContain('workflowType=echo');
    expect(requestedUrl).toContain('limit=10');
    expect(requestedUrl).toContain('offset=20');
    expect(schedules.items).toEqual([
      expect.objectContaining({
        id: 'nightly-maintenance',
        lastFireAt: 3,
        nextFireAt: 4,
      }),
    ]);
  });

  it('previews and commits bulk workflow actions with confirmation metadata', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestInputToUrl(input);
      requests.push(init === undefined ? { url } : { url, init });

      if (url === '/v1/workflows/bulk/cancel') {
        const body = requestBodyToJson(init);
        if (body['dryRun'] === true) {
          return Response.json({
            dryRun: true,
            action: 'cancel',
            matched: 2,
            requestId: body['requestId'],
            scope: {
              matched: 2,
              filter: body['filter'],
              statuses: ['running'],
              workflowTypes: ['checkout'],
              sampleWorkflowIds: ['wf-1', 'wf-2'],
              sampleLimit: 20,
            },
            sampleWorkflowIds: ['wf-1', 'wf-2'],
            confirmationToken: 'bulk:cancel-token',
            confirmationTokenVersion: 1,
          });
        }

        return Response.json({
          cancelled: 2,
          failed: 0,
          errors: [],
          auditEvent: {
            type: 'bulk-operation:audit',
            action: 'cancel',
            requestId: body['requestId'],
            timestamp: 1,
            principal: { method: 'api-key' },
            filterSummary: body['filter'],
            scope: {
              matched: 2,
              filter: body['filter'],
              statuses: ['running'],
              workflowTypes: ['checkout'],
              sampleWorkflowIds: ['wf-1', 'wf-2'],
              sampleLimit: 20,
            },
            affectedCount: 2,
            sampleWorkflowIds: ['wf-1', 'wf-2'],
            confirmationToken: body['confirmationToken'],
          },
        });
      }

      if (url === '/v1/workflows/bulk/signal') {
        const body = requestBodyToJson(init);
        if (body['dryRun'] === true) {
          return Response.json({
            dryRun: true,
            action: 'signal',
            matched: 2,
            requestId: body['requestId'],
            scope: {
              matched: 2,
              filter: body['filter'],
              statuses: ['running'],
              workflowTypes: ['checkout'],
              sampleWorkflowIds: ['wf-1', 'wf-2'],
              sampleLimit: 20,
            },
            sampleWorkflowIds: ['wf-1', 'wf-2'],
            confirmationToken: 'bulk:signal-token',
            confirmationTokenVersion: 1,
          });
        }

        return Response.json({
          signalled: 2,
          failed: 0,
          auditEvent: {
            type: 'bulk-operation:audit',
            action: 'signal',
            requestId: body['requestId'],
            timestamp: 1,
            principal: { method: 'api-key' },
            filterSummary: body['filter'],
            scope: {
              matched: 2,
              filter: body['filter'],
              statuses: ['running'],
              workflowTypes: ['checkout'],
              sampleWorkflowIds: ['wf-1', 'wf-2'],
              sampleLimit: 20,
            },
            affectedCount: 2,
            sampleWorkflowIds: ['wf-1', 'wf-2'],
            confirmationToken: body['confirmationToken'],
          },
        });
      }

      if (url === '/v1/workflows/bulk/tags') {
        const body = requestBodyToJson(init);
        if (body['dryRun'] === true) {
          return Response.json({
            dryRun: true,
            action: 'tag:add',
            matched: 2,
            requestId: body['requestId'],
            scope: {
              matched: 2,
              filter: body['filter'],
              statuses: ['completed'],
              workflowTypes: ['checkout'],
              sampleWorkflowIds: ['wf-1', 'wf-2'],
              sampleLimit: 20,
            },
            sampleWorkflowIds: ['wf-1', 'wf-2'],
            confirmationToken: 'bulk:tag-token',
            confirmationTokenVersion: 1,
          });
        }

        return Response.json({
          modified: 2,
          auditEvent: {
            type: 'bulk-operation:audit',
            action: 'tag:add',
            requestId: 'tag-request',
            timestamp: 1,
            principal: { method: 'api-key' },
            filterSummary: {},
            scope: {
              matched: 2,
              filter: {},
              statuses: ['completed'],
              workflowTypes: ['checkout'],
              sampleWorkflowIds: ['wf-1', 'wf-2'],
              sampleLimit: 20,
            },
            affectedCount: 2,
            sampleWorkflowIds: ['wf-1', 'wf-2'],
            confirmationToken: 'bulk:tag-token',
          },
        });
      }

      if (url === '/v1/workflows/bulk' && init?.method === 'DELETE') {
        const body = requestBodyToJson(init);
        if (body['dryRun'] === true) {
          return Response.json({
            dryRun: true,
            action: 'delete',
            matched: 2,
            requestId: body['requestId'],
            scope: {
              matched: 2,
              filter: body['filter'],
              statuses: ['completed'],
              workflowTypes: ['checkout'],
              sampleWorkflowIds: ['wf-1', 'wf-2'],
              sampleLimit: 20,
            },
            sampleWorkflowIds: ['wf-1', 'wf-2'],
            confirmationToken: 'bulk:delete-token',
            confirmationTokenVersion: 1,
          });
        }

        return Response.json({
          deleted: 2,
          auditEvent: {
            type: 'bulk-operation:audit',
            action: 'delete',
            requestId: body['requestId'],
            timestamp: 1,
            principal: { method: 'api-key' },
            filterSummary: body['filter'],
            scope: {
              matched: 2,
              filter: body['filter'],
              statuses: ['completed'],
              workflowTypes: ['checkout'],
              sampleWorkflowIds: ['wf-1', 'wf-2'],
              sampleLimit: 20,
            },
            affectedCount: 2,
            sampleWorkflowIds: ['wf-1', 'wf-2'],
            confirmationToken: body['confirmationToken'],
          },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const client = new ApiClient();
    const preview = await client.previewBulkCancelWorkflows(
      { status: 'running', type: 'checkout', tags: ['selected'] },
      'cancel-request',
    );
    const result = await client.commitBulkCancelWorkflows(
      { status: 'running', type: 'checkout', tags: ['selected'] },
      preview.confirmationToken,
      preview.requestId,
    );
    const signalPreview = await client.previewBulkSignalWorkflows(
      { status: 'running', type: 'checkout' },
      'approve',
      { reviewer: 'Ada' },
      'signal-request',
    );
    const signalResult = await client.commitBulkSignalWorkflows(
      { status: 'running', type: 'checkout' },
      'approve',
      { reviewer: 'Ada' },
      signalPreview.confirmationToken,
      signalPreview.requestId,
    );
    const deletePreview = await client.previewBulkDeleteWorkflows(
      { status: 'completed', type: 'checkout' },
      'delete-request',
    );
    const deleteResult = await client.commitBulkDeleteWorkflows(
      { status: 'completed', type: 'checkout' },
      deletePreview.confirmationToken,
      deletePreview.requestId,
    );
    const tagPreview = await client.previewBulkTagWorkflows(
      { status: 'completed' },
      ['archived'],
      'add',
      'tag-request',
    );
    const tagResult = await client.commitBulkTagWorkflows(
      { status: 'completed' },
      ['archived'],
      'add',
      tagPreview.confirmationToken,
      tagPreview.requestId,
    );
    const noPayloadSignalPreview = await client.previewBulkSignalWorkflows(
      { status: 'running' },
      'ping',
    );
    const noPayloadSignalResult = await client.commitBulkSignalWorkflows(
      { status: 'running' },
      'ping',
      undefined,
      noPayloadSignalPreview.confirmationToken,
    );

    expect(preview.matched).toBe(2);
    expect(result.cancelled).toBe(2);
    expect(result.auditEvent?.requestId).toBe('cancel-request');
    expect(signalPreview.action).toBe('signal');
    expect(signalResult.signalled).toBe(2);
    expect(deletePreview.action).toBe('delete');
    expect(deleteResult.deleted).toBe(2);
    expect(tagPreview.action).toBe('tag:add');
    expect(tagResult.modified).toBe(2);
    expect(noPayloadSignalPreview.action).toBe('signal');
    expect(noPayloadSignalResult.signalled).toBe(2);

    expect(requests.map((entry) => entry.url)).toEqual([
      '/v1/workflows/bulk/cancel',
      '/v1/workflows/bulk/cancel',
      '/v1/workflows/bulk/signal',
      '/v1/workflows/bulk/signal',
      '/v1/workflows/bulk',
      '/v1/workflows/bulk',
      '/v1/workflows/bulk/tags',
      '/v1/workflows/bulk/tags',
      '/v1/workflows/bulk/signal',
      '/v1/workflows/bulk/signal',
    ]);
    expect(requests.map((entry) => entry.init?.method)).toEqual([
      'POST',
      'POST',
      'POST',
      'POST',
      'DELETE',
      'DELETE',
      'PATCH',
      'PATCH',
      'POST',
      'POST',
    ]);
    expect(requestBodyToJson(requests[0]?.init)).toEqual({
      filter: { status: 'running', type: 'checkout', tags: ['selected'] },
      dryRun: true,
      requestId: 'cancel-request',
    });
    expect(requestBodyToJson(requests[1]?.init)).toEqual({
      filter: { status: 'running', type: 'checkout', tags: ['selected'] },
      confirmationToken: 'bulk:cancel-token',
      requestId: 'cancel-request',
    });
    expect(requestBodyToJson(requests[2]?.init)).toEqual({
      filter: { status: 'running', type: 'checkout' },
      name: 'approve',
      payload: { reviewer: 'Ada' },
      dryRun: true,
      requestId: 'signal-request',
    });
    expect(requestBodyToJson(requests[3]?.init)).toEqual({
      filter: { status: 'running', type: 'checkout' },
      name: 'approve',
      payload: { reviewer: 'Ada' },
      confirmationToken: 'bulk:signal-token',
      requestId: 'signal-request',
    });
    expect(requestBodyToJson(requests[4]?.init)).toEqual({
      filter: { status: 'completed', type: 'checkout' },
      dryRun: true,
      requestId: 'delete-request',
    });
    expect(requestBodyToJson(requests[5]?.init)).toEqual({
      filter: { status: 'completed', type: 'checkout' },
      confirmationToken: 'bulk:delete-token',
      requestId: 'delete-request',
    });
    expect(requestBodyToJson(requests[6]?.init)).toEqual({
      filter: { status: 'completed' },
      tags: ['archived'],
      operation: 'add',
      dryRun: true,
      requestId: 'tag-request',
    });
    expect(requestBodyToJson(requests[7]?.init)).toEqual({
      filter: { status: 'completed' },
      tags: ['archived'],
      operation: 'add',
      confirmationToken: 'bulk:tag-token',
      requestId: 'tag-request',
    });
    expect(requestBodyToJson(requests[8]?.init)).toEqual({
      filter: { status: 'running' },
      name: 'ping',
      dryRun: true,
    });
    expect(requestBodyToJson(requests[9]?.init)).toEqual({
      filter: { status: 'running' },
      name: 'ping',
      confirmationToken: 'bulk:signal-token',
    });
  });

  it('fetches connected workers from GET /v1/workers with the routing policy', async () => {
    const requestedUrls: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = requestInputToUrl(input);
      requestedUrls.push(url);

      if (url === '/v1/workers') {
        return Response.json({
          items: [
            {
              id: 'worker-1',
              queue: 'default',
              activities: ['process'],
              concurrency: 4,
              inFlight: 1,
              availableCapacity: 3,
              connectedAt: 1_000,
              lastHeartbeatAt: 2_000,
              heartbeatAgeMs: 500,
              deploymentName: 'payments',
              buildId: 'build-1',
              runtimeVersion: 'bun-1.2.13',
              gitSha: 'abc',
              startedAt: 900,
              capabilities: { region: 'us-west' },
              health: 'active',
            },
          ],
          deployments: [
            {
              deploymentName: 'payments',
              buildId: 'build-1',
              runtimeVersion: 'bun-1.2.13',
              gitSha: 'abc',
              health: 'active',
              workers: 1,
              activeWorkers: 1,
              drainingWorkers: 0,
              drainedWorkers: 0,
              inFlight: 1,
              oldestStartedAt: 900,
            },
          ],
          routingPolicy: 'least-loaded',
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const client = new ApiClient();
    const response = await client.listWorkers();

    expect(requestedUrls).toEqual(['/v1/workers']);
    expect(response.routingPolicy).toBe('least-loaded');
    expect(response.deployments[0]?.deploymentName).toBe('payments');
    expect(response.items).toEqual([
      expect.objectContaining({
        id: 'worker-1',
        availableCapacity: 3,
        heartbeatAgeMs: 500,
        deploymentName: 'payments',
        health: 'active',
      }),
    ]);
  });

  it('calls worker and deployment drain mutation endpoints', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestInputToUrl(input);
      requests.push(init === undefined ? { url } : { url, init });
      return Response.json({
        target: url.includes('worker-deployments') ? 'deployment' : 'worker',
        affectedWorkers: 1,
        inFlight: 0,
        health: 'drained',
      });
    }) as typeof fetch;

    const client = new ApiClient();
    await client.drainWorker('worker/1', 'maintenance');
    await client.clearWorkerDrain('worker/1');
    await client.drainDeployment('payments/canary', 'rollback');
    await client.clearDeploymentDrain('payments/canary');

    expect(requests.map((entry) => entry.url)).toEqual([
      '/v1/workers/worker%2F1/drain',
      '/v1/workers/worker%2F1/drain',
      '/v1/worker-deployments/payments%2Fcanary/drain',
      '/v1/worker-deployments/payments%2Fcanary/drain',
    ]);
    expect(requests[0]?.init?.method).toBe('POST');
    expect(requests[0]?.init?.body).toBe(JSON.stringify({ reason: 'maintenance' }));
    expect(requests[1]?.init?.method).toBe('DELETE');
    expect(requests[2]?.init?.method).toBe('POST');
    expect(requests[2]?.init?.body).toBe(JSON.stringify({ reason: 'rollback' }));
    expect(requests[3]?.init?.method).toBe('DELETE');
  });

  it('fetches per-queue health from GET /v1/task-queues', async () => {
    const requestedUrls: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = requestInputToUrl(input);
      requestedUrls.push(url);

      if (url === '/v1/task-queues') {
        return Response.json({
          items: [
            {
              queue: 'queue-a',
              backlog: 2,
              oldestEnqueuedAt: 100,
              oldestQueuedAgeMs: 900,
              waitingPollers: 0,
              schedulingPolicy: 'priority',
              inFlight: 1,
              connectedWorkers: 1,
            },
          ],
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const client = new ApiClient();
    const response = await client.listTaskQueues();

    expect(requestedUrls).toEqual(['/v1/task-queues']);
    expect(response.items).toEqual([
      expect.objectContaining({ queue: 'queue-a', backlog: 2, oldestQueuedAgeMs: 900 }),
    ]);
  });

  it('serializes the extended workflow list filters into query parameters', async () => {
    let requestedUrl = '';

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = requestInputToUrl(input);
      return Response.json({ items: [], total: 0, offset: 0, limit: 20 });
    }) as typeof fetch;

    const client = new ApiClient();
    await client.listWorkflows({
      status: ['failed', 'timed-out'],
      idPrefix: 'order-',
      failureCategory: ['resource', 'application'],
      createdAt: { gte: 1000, lt: 5000 },
      updatedAt: { gt: 2000 },
      executionDeadline: { lte: 10_000 },
    });

    expect(requestedUrl).toContain('/v1/workflows?');
    expect(requestedUrl).toContain('status=failed');
    expect(requestedUrl).toContain('status=timed-out');
    expect(requestedUrl).toContain('id_prefix=order-');
    expect(requestedUrl).toContain('failure_category=resource');
    expect(requestedUrl).toContain('failure_category=application');
    expect(requestedUrl).toContain('created_at_gte=1000');
    expect(requestedUrl).toContain('created_at_lt=5000');
    expect(requestedUrl).toContain('updated_at_gt=2000');
    expect(requestedUrl).toContain('execution_deadline_lte=10000');
  });

  it('aggregateWorkflows targets /v1/workflows/aggregate with group_by', async () => {
    let requestedUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = requestInputToUrl(input);
      return Response.json({ total: 0, groups: [], truncated: false });
    }) as typeof fetch;

    const client = new ApiClient();
    await client.aggregateWorkflows({ status: ['running'] }, 'status', 50);

    expect(requestedUrl).toContain('/v1/workflows/aggregate?');
    expect(requestedUrl).toContain('group_by=status');
    expect(requestedUrl).toContain('limit=50');
  });

  it('aggregateWorkflows serializes attribute group-by as attribute:<name>', async () => {
    let requestedUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = requestInputToUrl(input);
      return Response.json({ total: 0, groups: [], truncated: false });
    }) as typeof fetch;

    const client = new ApiClient();
    await client.aggregateWorkflows(undefined, { attribute: 'customerTier' });

    expect(requestedUrl).toContain('/v1/workflows/aggregate?');
    expect(requestedUrl).toContain('group_by=attribute%3AcustomerTier');
  });
});
