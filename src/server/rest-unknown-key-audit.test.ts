/**
 * Phase 15a — REST unknown-key disposition baseline audit.
 *
 * Locks the current (pre-migration) top-level unknown-key behavior of
 * every REST route that accepts a JSON body. Each test sends a
 * known-good request with one extra top-level field and asserts the
 * same status code the route returns today. The captured disposition
 * — 'reject' vs 'strip' vs 'passthrough' — becomes the baseline each
 * migrated operation's `unknownKeyPolicy.http` must preserve once the
 * route flips to `restDispatchMode: 'via-execute-operation'`.
 *
 * Scope (Phase 15a):
 *   - Top-level only. Nested-object dispositions are captured per
 *     operation during its individual migration test.
 *   - Only routes that read a JSON body (GET/HEAD excluded).
 *   - Each route is probed with the minimal valid body that reaches
 *     the engine plus one extra `__auditExtraKey__` field; the test
 *     asserts that the response status matches the known-good baseline
 *     (i.e. the extra key does not change behavior), proving today's
 *     disposition is effectively 'strip' / 'passthrough' and NOT
 *     'reject'.
 *
 * If a future change flips a route to reject unknown keys, this test
 * will fail loudly — at that point the route's `unknownKeyPolicy.http`
 * must be set to `'reject'` to match.
 */

import { describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { handleRequest } from './handler.ts';

const AUDIT_EXTRA_KEY = '__auditExtraKey__';

function createEngineForAudit(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
  return engine;
}

/** Seeds a workflow and returns its id — useful for routes that need existing state. */
async function seedWorkflow(engine: Engine): Promise<string> {
  const handle = await engine.start('echo', { seeded: true }, {});
  return handle.id;
}

type AuditCase = {
  readonly name: string;
  readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Either a static path or a factory returning the path for the seeded engine. */
  readonly path: string | ((engine: Engine) => Promise<string>);
  readonly baselineBody: Record<string, unknown>;
  readonly expectedBaselineStatuses: ReadonlyArray<number>;
};

const AUDIT_CASES: ReadonlyArray<AuditCase> = [
  {
    name: 'POST /v1/workflows (startWorkflow)',
    method: 'POST',
    path: '/v1/workflows',
    baselineBody: { type: 'echo', input: { greeting: 'hello' } },
    expectedBaselineStatuses: [201],
  },
  {
    name: 'POST /v1/workflows/purge (purgeWorkflows)',
    method: 'POST',
    path: '/v1/workflows/purge',
    baselineBody: {},
    expectedBaselineStatuses: [200],
  },
  {
    name: 'POST /v1/workflows/bulk/cancel (bulkCancelWorkflows)',
    method: 'POST',
    path: '/v1/workflows/bulk/cancel',
    baselineBody: { filter: { status: 'running' } },
    expectedBaselineStatuses: [200],
  },
  {
    name: 'POST /v1/workflows/bulk/signal (bulkSignalWorkflows)',
    method: 'POST',
    path: '/v1/workflows/bulk/signal',
    baselineBody: { filter: { status: 'running' }, name: 'noop' },
    expectedBaselineStatuses: [200],
  },
  {
    name: 'DELETE /v1/workflows/bulk (bulkDeleteWorkflows)',
    method: 'DELETE',
    path: '/v1/workflows/bulk',
    baselineBody: { filter: { status: 'completed' } },
    expectedBaselineStatuses: [200],
  },
  {
    name: 'PATCH /v1/workflows/bulk/tags (bulkMutateWorkflowTags)',
    method: 'PATCH',
    path: '/v1/workflows/bulk/tags',
    baselineBody: { filter: { status: 'running' }, tags: ['audit'], operation: 'add' },
    expectedBaselineStatuses: [200],
  },
  {
    name: 'POST /v1/workflows/:id/signal/:name (signalWorkflow)',
    method: 'POST',
    path: async (engine) => `/v1/workflows/${await seedWorkflow(engine)}/signal/audit-signal`,
    baselineBody: { payload: { any: 'thing' } },
    // Signal on a freshly-started workflow may not yet be receiving —
    // but the handler returns 200 on success or 500 if the state is not
    // yet signal-receiving. The audit compares status with-key vs.
    // baseline, so either outcome is fine as long as it's stable.
    expectedBaselineStatuses: [200, 500],
  },
  {
    name: 'POST /v1/workflows/:id/tags (addWorkflowTags)',
    method: 'POST',
    path: async (engine) => `/v1/workflows/${await seedWorkflow(engine)}/tags`,
    baselineBody: { tags: ['added'] },
    expectedBaselineStatuses: [200],
  },
  {
    name: 'DELETE /v1/workflows/:id/tags (removeWorkflowTags)',
    method: 'DELETE',
    path: async (engine) => `/v1/workflows/${await seedWorkflow(engine)}/tags`,
    baselineBody: { tags: ['no-such-tag'] },
    expectedBaselineStatuses: [200],
  },
  {
    name: 'PATCH /v1/workflows/:id/attributes (setAttributes)',
    method: 'PATCH',
    path: async (engine) => `/v1/workflows/${await seedWorkflow(engine)}/attributes`,
    baselineBody: { attributes: { priority: 'high' } },
    expectedBaselineStatuses: [200],
  },
];

/**
 * Helper: build a Request with a JSON body. Returns a fresh object
 * every call so the body stream is unread.
 */
function requestWith(method: string, path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('REST unknown-key disposition baseline audit', () => {
  for (const testCase of AUDIT_CASES) {
    it(`${testCase.name} — extra top-level key does not change status`, async () => {
      const baselineEngine = createEngineForAudit();
      const baselinePath =
        typeof testCase.path === 'string' ? testCase.path : await testCase.path(baselineEngine);
      const baselineResponse = await handleRequest(
        requestWith(testCase.method, baselinePath, testCase.baselineBody),
        baselineEngine,
      );
      expect(testCase.expectedBaselineStatuses).toContain(baselineResponse.status);

      // Independent engine for the extra-key probe to avoid cross-
      // contamination from the baseline call.
      const auditEngine = createEngineForAudit();
      const auditPath =
        typeof testCase.path === 'string' ? testCase.path : await testCase.path(auditEngine);

      const bodyWithExtra: Record<string, unknown> = {
        ...testCase.baselineBody,
        [AUDIT_EXTRA_KEY]: 'audit-probe-value',
      };
      const auditResponse = await handleRequest(
        requestWith(testCase.method, auditPath, bodyWithExtra),
        auditEngine,
      );

      // The baseline disposition is 'strip' or 'passthrough': the extra
      // key must not change the response status. If a migration flips a
      // route to 'reject', THIS is the test that catches it — update the
      // expected status to 400 at the same commit that sets
      // `unknownKeyPolicy.http: 'reject'`.
      expect(auditResponse.status).toBe(baselineResponse.status);
    });
  }
});
