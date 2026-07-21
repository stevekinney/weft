/**
 * Wire-format fixture equivalence tests.
 *
 * Drives `createJsonRpcWebSocketSession` and asserts every emitted frame
 * matches the corresponding fixture in
 * `__fixtures__/subscription-wire/{current-contract,new-error-contract}` after
 * non-deterministic fields (subscriptionId, cursor, emittedAtMs,
 * workflowId) are normalized to the placeholders documented in
 * `__fixtures__/subscription-wire/README.md`.
 *
 * Refactor cannot ship without these passing — the lifecycle tests cover
 * behavior; these pin wire format.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { createInMemoryEventBackend } from './in-memory-event-feed-backend.test-support.ts';
import {
  createJsonRpcWebSocketSession,
  type JsonRpcWebSocketEmitter,
} from './json-rpc-websocket.ts';
import {
  createOperationRegistry,
  SubscriptionElementValidationError,
} from './operation-catalog.ts';
import { defineOperation } from './operation-registry.ts';
import { workflowEventsSubscriptionOperation } from './operations/workflow-events-subscription.ts';
import { principalFromApiKey } from './principal.ts';
import {
  createWorkflowEventFeed,
  encodeCursor,
  type WorkflowEventFeed,
} from './workflow-event-feed.ts';

const FIXTURE_DIR = new URL('./__fixtures__/subscription-wire/', import.meta.url).pathname;

function loadFixture(group: 'current-contract' | 'new-error-contract', file: string): unknown {
  const path = join(FIXTURE_DIR, group, file);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * Replace non-deterministic field values with the documented placeholder
 * tokens so byte equivalence is meaningful across runs.
 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
      if (key === 'subscriptionId' && typeof raw === 'string') {
        result[key] = '<subscription-id>';
        continue;
      }
      if (key === 'cursor' && typeof raw === 'string') {
        result[key] = '<cursor>';
        continue;
      }
      if (key === 'workflowId' && typeof raw === 'string') {
        result[key] = '<workflow-id>';
        continue;
      }
      if (key === 'emittedAtMs' && typeof raw === 'number') {
        result[key] = 0;
        continue;
      }
      result[key] = normalize(raw);
    }
    return result;
  }
  return value;
}

/**
 * Error-response normalization. Only `subscriptionId`, `cursor`,
 * `workflowId`, and `emittedAtMs` are non-deterministic and replaced
 * with placeholders by the tree walker. `error.message` and `error.data`
 * are PRESERVED in the fixture so a Zod issue-shape regression is
 * caught (per Codex round-3 / round-4 feedback). If a future Zod upgrade
 * legitimately changes the error shape, the fixture is updated in the
 * same commit so the wire contract is reviewed end-to-end.
 */
function normalizeErrorEnvelope(value: unknown): unknown {
  // Reuse the standard tree walker; nothing inside an error envelope is
  // non-deterministic in the same way subscription IDs are.
  return normalize(value);
}

function makeEmitter(): JsonRpcWebSocketEmitter & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send(message) {
      sent.push(message);
    },
  };
}

function makeEnvelope(sequence: number, workflowId = 'wf-fixture') {
  return {
    kind: 'workflow:started' as const,
    workflowId,
    selector: 'events' as const,
    sequence,
    cursor: encodeCursor(sequence),
    emittedAtMs: 0,
    payload: { type: 'started' },
  };
}

describe('subscription wire-format fixtures — current-contract', () => {
  it('subscribe + ack + deliver + unsubscribe + terminated-client-unsubscribed', async () => {
    const backend = createInMemoryEventBackend();
    const feed: WorkflowEventFeed = createWorkflowEventFeed(backend);
    const emitter = makeEmitter();
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([workflowEventsSubscriptionOperation]),
      engine: {} as unknown,
      principal: principalFromApiKey({ subject: 'test', scopes: ['events:read'] }),
      emitter,
      feed,
    });

    await session.handleMessage(
      JSON.stringify(loadFixture('current-contract', 'subscribe-request.json')),
    );

    // Subscribe FIRST, then append — the deliver path is live-only, not
    // replay (the backend's replay history starts at the cursor returned
    // by the subscription).
    await waitFor(() => emitter.sent.length >= 1);
    await backend.append(makeEnvelope(0, 'wf-1'));
    await waitFor(() => emitter.sent.some((s) => JSON.parse(s).method === 'weft.events.deliver'));

    const ackFrame = emitter.sent.find((s) => {
      const parsed = JSON.parse(s) as Record<string, unknown>;
      return parsed['id'] === 'sub-1' && 'result' in parsed;
    });
    if (ackFrame === undefined) throw new Error('expected subscribe ack');
    expect(normalize(JSON.parse(ackFrame))).toEqual(
      loadFixture('current-contract', 'subscribe-ack.json'),
    );

    const deliverFrame = emitter.sent.find(
      (s) => (JSON.parse(s) as Record<string, unknown>)['method'] === 'weft.events.deliver',
    );
    if (deliverFrame === undefined) throw new Error('expected deliver frame');
    expect(normalize(JSON.parse(deliverFrame))).toEqual(
      loadFixture('current-contract', 'event-deliver.json'),
    );

    // Pull subscriptionId out of the ack to use in unsubscribe.
    const ack = JSON.parse(ackFrame) as { result: { subscriptionId: string } };
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'unsub-1',
        method: 'weft.workflows.unsubscribe',
        params: { subscriptionId: ack.result.subscriptionId },
      }),
    );

    await waitFor(() =>
      emitter.sent.some((s) => {
        const parsed = JSON.parse(s) as Record<string, unknown>;
        return (
          parsed['method'] === 'weft.events.terminated' &&
          (parsed['params'] as { reason?: unknown }).reason === 'client-unsubscribed'
        );
      }),
    );
    const terminatedFrame = emitter.sent.find((s) => {
      const parsed = JSON.parse(s) as Record<string, unknown>;
      return (
        parsed['method'] === 'weft.events.terminated' &&
        (parsed['params'] as { reason?: unknown }).reason === 'client-unsubscribed'
      );
    });
    if (terminatedFrame === undefined) throw new Error('expected terminated frame');
    expect(normalize(JSON.parse(terminatedFrame))).toEqual(
      loadFixture('current-contract', 'terminated-client-unsubscribed.json'),
    );

    await session.close();
  });

  it('subscribe with invalid params emits the InvalidParams error envelope', async () => {
    // Drive the live session through a malformed subscribe (missing
    // `workflowId`). The session-level subscribe handler validates
    // params and emits a JSON-RPC error response. The fixture pins the
    // envelope shape (jsonrpc, id, error.code) — message and data are
    // normalized because they carry Zod-version-specific detail.
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend);
    const emitter = makeEmitter();
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([workflowEventsSubscriptionOperation]),
      engine: {} as unknown,
      principal: principalFromApiKey({ subject: 'test', scopes: ['events:read'] }),
      emitter,
      feed,
    });

    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'sub-invalid',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 42 },
      }),
    );

    await waitFor(() => emitter.sent.length > 0);
    const errorFrame = emitter.sent.find((s) => {
      const parsed = JSON.parse(s) as Record<string, unknown>;
      return parsed['id'] === 'sub-invalid' && 'error' in parsed;
    });
    if (errorFrame === undefined) throw new Error('expected error frame for invalid subscribe');

    expect(normalizeErrorEnvelope(JSON.parse(errorFrame))).toEqual(
      loadFixture('current-contract', 'subscribe-invalid-params-error.json'),
    );

    await session.close();
  });
});

describe('subscription wire-format fixtures — new-error-contract', () => {
  it('terminated-validation-failed: drives a real session through eventSchema rejection', async () => {
    // Override `weft.workflows.events` with a subscription operation whose
    // eventSchema rejects every yielded element. The WebSocket session
    // discovers operations by name from the registry, so registering a
    // different operation under the same name makes the live session use
    // it instead of the built-in one. This drives the actual pump catch
    // path and captures the real terminated frame.
    const failingOp = defineOperation({
      name: 'weft.workflows.events',
      mcpExposable: false,
      destructive: false,
      kind: 'subscription',
      summary: 'fixture: rejects every element',
      inputSchema: z.object({
        workflowId: z.string().min(1),
        selector: z.enum(['events', 'tokens']).optional().default('events'),
        fromCursor: z.string().optional(),
      }),
      outputSchema: z.object({ subscriptionId: z.string(), cursor: z.string() }),
      eventSchema: z.never(),
      access: { kind: 'public' },
      transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => ({
        envelope: { subscriptionId: `sub_${crypto.randomUUID()}`, cursor: '0' },
        iterable: (async function* () {
          // Any yield triggers element-validation failure since
          // eventSchema is z.never() — the pump must catch
          // SubscriptionElementValidationError and emit the
          // validation-failed terminator.
          yield { sequence: 0 };
        })(),
        close: async () => {},
      }),
    });

    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend);
    const emitter = makeEmitter();
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([failingOp]),
      engine: {} as unknown,
      principal: principalFromApiKey({ subject: 'test', scopes: ['events:read'] }),
      emitter,
      feed,
    });

    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'sub-validation',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-1', selector: 'events' },
      }),
    );

    await waitFor(() =>
      emitter.sent.some((s) => {
        const parsed = JSON.parse(s) as Record<string, unknown>;
        return (
          parsed['method'] === 'weft.events.terminated' &&
          (parsed['params'] as { reason?: unknown }).reason === 'validation-failed'
        );
      }),
    );

    const terminatedFrame = emitter.sent.find((s) => {
      const parsed = JSON.parse(s) as Record<string, unknown>;
      return (
        parsed['method'] === 'weft.events.terminated' &&
        (parsed['params'] as { reason?: unknown }).reason === 'validation-failed'
      );
    });
    if (terminatedFrame === undefined) throw new Error('expected validation-failed terminator');

    expect(normalize(JSON.parse(terminatedFrame))).toEqual(
      loadFixture('new-error-contract', 'terminated-validation-failed.json'),
    );

    await session.close();
  });

  it('terminated-engine-error: drives a real session through a non-validation iterable throw', async () => {
    // Override `weft.workflows.events` with an operation that throws a
    // plain error mid-stream. The pump's catch path must classify this
    // as `server-closed` (not validation-failed) with a sanitized
    // EngineFailure fault.
    const throwingOp = defineOperation({
      name: 'weft.workflows.events',
      mcpExposable: false,
      destructive: false,
      kind: 'subscription',
      summary: 'fixture: iterable throws',
      inputSchema: z.object({
        workflowId: z.string().min(1),
        selector: z.enum(['events', 'tokens']).optional().default('events'),
        fromCursor: z.string().optional(),
      }),
      outputSchema: z.object({ subscriptionId: z.string(), cursor: z.string() }),
      eventSchema: z.unknown(),
      access: { kind: 'public' },
      transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => ({
        envelope: { subscriptionId: `sub_${crypto.randomUUID()}`, cursor: '0' },
        iterable: (async function* () {
          throw new Error('subscription failed mid-stream');
        })(),
        close: async () => {},
      }),
    });

    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend);
    const emitter = makeEmitter();
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([throwingOp]),
      engine: {} as unknown,
      principal: principalFromApiKey({ subject: 'test', scopes: ['events:read'] }),
      emitter,
      feed,
    });

    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'sub-throw',
        method: 'weft.workflows.subscribe',
        params: { workflowId: 'wf-1', selector: 'events' },
      }),
    );

    await waitFor(() =>
      emitter.sent.some((s) => {
        const parsed = JSON.parse(s) as Record<string, unknown>;
        return (
          parsed['method'] === 'weft.events.terminated' &&
          (parsed['params'] as { reason?: unknown }).reason === 'server-closed'
        );
      }),
    );

    const terminatedFrame = emitter.sent.find((s) => {
      const parsed = JSON.parse(s) as Record<string, unknown>;
      return (
        parsed['method'] === 'weft.events.terminated' &&
        (parsed['params'] as { reason?: unknown }).reason === 'server-closed'
      );
    });
    if (terminatedFrame === undefined) throw new Error('expected server-closed terminator');

    expect(normalize(JSON.parse(terminatedFrame))).toEqual(
      loadFixture('new-error-contract', 'terminated-engine-error.json'),
    );

    await session.close();
  });

  // Defensive type-only reference: SubscriptionElementValidationError is
  // exported from the catalog and used by stream-pipeline; keep the import
  // anchored so an unused-import lint doesn't drift it out.
  it('exports SubscriptionElementValidationError', () => {
    expect(SubscriptionElementValidationError).toBeDefined();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for predicate');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
