import { z } from 'zod';

import type { AuthorizationScope } from '../authorization-scope.ts';
import { defineOperation } from '../operation-registry.ts';
import { isAuthenticated } from '../principal.ts';
import {
  decodeCursor,
  type Cursor,
  type EventEnvelope,
  type WorkflowEventFeed,
} from '../workflow-event-feed.ts';

const INITIAL_SUBSCRIPTION_CURSOR: Cursor = '-1';

const workflowEventsSubscriptionInput = z.object({
  workflowId: z.string().min(1),
  selector: z.enum(['events', 'tokens']).optional().default('events'),
  fromCursor: z
    .string()
    .refine((cursor) => decodeCursor(cursor) !== null, { message: 'Invalid cursor' })
    .optional(),
});

const workflowEventsSubscriptionEnvelope = z.object({
  subscriptionId: z.string(),
  cursor: z.string(),
});

export type WorkflowEventsSubscriptionInput = z.infer<typeof workflowEventsSubscriptionInput>;
export type WorkflowEventsSubscriptionEnvelope = z.infer<typeof workflowEventsSubscriptionEnvelope>;

/**
 * Cataloged subscription operation for replay-plus-live workflow events.
 * The WebSocket session owns the lifecycle primitive; this operation owns
 * validation, authorization, and feed wiring.
 *
 * **Security model.** Subscriptions are capability grants for the lifetime
 * of the WebSocket session: the catalog access policy is checked once at
 * subscribe time, and once granted the subscription continues delivering
 * events until the client unsubscribes, the socket closes, or the feed
 * terminates. There is no per-event re-authorization in v1, so a token's
 * scope must be revoked AT THE SOCKET LEVEL (close + reconnect) to stop
 * event delivery — token revocation alone does not terminate active
 * subscriptions. This is documented as a known v1 constraint; per-event
 * filtering is a planned future refinement.
 *
 * Access is selector-specific: event envelopes require `events:read`, while
 * token-stream envelopes require `streams:read`. Anonymous callers and
 * authenticated callers without the matching scope are denied. Operators
 * running `serve({ engine })` without auth must add an authentication layer
 * before exposing this endpoint to untrusted networks.
 */
export const workflowEventsSubscriptionOperation = defineOperation<
  WorkflowEventsSubscriptionInput,
  WorkflowEventsSubscriptionEnvelope
>({
  name: 'weft.workflows.events',
  mcpExposable: false,
  kind: 'subscription',
  summary: 'Subscribe to workflow events with replay-from-cursor',
  description:
    '`selector: "events"` requires `events:read`; `selector: "tokens"` requires `streams:read`. The grant is checked when the WebSocket subscription starts and remains active until unsubscribe, socket close, or feed termination.',
  destructive: false,
  tags: ['Events'],
  inputSchema: workflowEventsSubscriptionInput,
  outputSchema: workflowEventsSubscriptionEnvelope,
  eventSchema: z.object({
    kind: z.string(),
    workflowId: z.string(),
    selector: z.enum(['events', 'tokens']),
    sequence: z.number(),
    cursor: z.string(),
    emittedAtMs: z.number(),
    payload: z.unknown(),
  }),
  access: { kind: 'authenticated' },
  authorize: async ({ input, principal }) => {
    const requiredScope = workflowSubscriptionScope(input.selector);
    if (!isAuthenticated(principal)) {
      return { allowed: false, classification: 'unauthorized', reason: 'authentication required' };
    }
    if (principal.hasScope(requiredScope)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      classification: 'forbidden',
      reason: `requires scope: ${requiredScope}`,
    };
  },
  // Mark discoverable so /openapi.json, /openrpc.json, and /asyncapi.json
  // all include the subscription channel. Without this flag the discovery
  // filter would hide the operation, which would break clients that
  // introspect the API surface.
  discoverable: true,
  transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }) => {
    // The WebSocket subscription session is the only caller and passes
    // `{ feed }` as the engine value for this catalog operation.
    const feed = (engine as { feed: WorkflowEventFeed }).feed;
    const controller = new AbortController();
    const startingCursor = input.fromCursor ?? INITIAL_SUBSCRIPTION_CURSOR;
    const iterable: AsyncIterable<EventEnvelope> = feed.subscribe({
      workflowId: input.workflowId,
      selector: input.selector,
      ...(input.fromCursor === undefined ? {} : { fromCursor: input.fromCursor }),
      signal: controller.signal,
    });

    return {
      envelope: { subscriptionId: `sub_${crypto.randomUUID()}`, cursor: startingCursor },
      iterable,
      close: async () => {
        controller.abort();
      },
    };
  },
});

function workflowSubscriptionScope(selector: 'events' | 'tokens'): AuthorizationScope {
  return selector === 'tokens' ? 'streams:read' : 'events:read';
}
