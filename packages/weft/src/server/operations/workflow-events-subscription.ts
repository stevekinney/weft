import { z } from 'zod';

import {
  createReplayAwareClosableIterable,
  decodeCursor,
  defineOperation,
  type AuthorizationScope,
  type Cursor,
  type ReplayLiveSubscribeOptions,
} from "../../embedded/backchannel/src/index.ts";
import { invalidParamsFault, isAuthenticated } from "../../embedded/backchannel/src/internals.ts";
import { type EventEnvelope, type WorkflowEventFeed } from '../workflow-event-feed.ts';
import {
  workflowEventEnvelopeSchema,
  workflowEventParameterizedAccess,
} from './event-stream-contracts.ts';

const INITIAL_SUBSCRIPTION_CURSOR: Cursor = '-1';
const MAX_WORKFLOW_SUBSCRIPTION_REPLAY_EVENTS = 1_000;

const workflowEventsSubscriptionInput = z.object({
  workflowId: z.string().min(1).describe('Id of the workflow to subscribe to.'),
  selector: z
    .enum(['events', 'tokens'])
    .optional()
    .default('events')
    .describe(
      'What to deliver: "events" for workflow events (default) or "tokens" for the workflow\'s token stream.',
    ),
  fromCursor: z
    .string()
    .refine((cursor) => decodeCursor(cursor) !== null, { message: 'Invalid cursor' })
    .optional()
    .describe(
      'Resume after this cursor, as returned with an earlier event. Omit it to start from the beginning.',
    ),
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
export const workflowEventsSubscriptionOperation = defineOperation({
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
  producibleFaults: ['InvalidParams'],
  eventSchema: workflowEventEnvelopeSchema,
  access: { kind: 'authenticated' },
  parameterizedAccess: workflowEventParameterizedAccess,
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
  invoke: async ({ input, host: engine }) => {
    // The WebSocket subscription session is the only caller and passes
    // `{ feed }` as the engine value for this catalog operation.
    const feed = (engine as { feed: WorkflowEventFeed }).feed;
    const controller = new AbortController();
    const startingCursor = input.fromCursor ?? INITIAL_SUBSCRIPTION_CURSOR;
    const subscribeOptions: {
      workflowId: string;
      selector: WorkflowEventsSubscriptionInput['selector'];
    } & ReplayLiveSubscribeOptions<EventEnvelope> = {
      workflowId: input.workflowId,
      selector: input.selector,
      ...(input.fromCursor === undefined ? {} : { fromCursor: input.fromCursor }),
      signal: controller.signal,
      replayLimit: MAX_WORKFLOW_SUBSCRIPTION_REPLAY_EVENTS,
      createReplayLimitError: (count: number, limit: number) =>
        invalidParamsFault(
          `Workflow event replay window is ${count} events; maximum is ${limit}. Supply a more recent fromCursor.`,
        ),
    };
    const iterable = createReplayAwareClosableIterable(
      (onReplayComplete) => feed.subscribe({ ...subscribeOptions, onReplayComplete }),
      { close: () => controller.abort() },
    );

    const subscriptionId = `sub_${crypto.randomUUID()}`;
    return {
      subscriptionId,
      envelope: { subscriptionId, cursor: startingCursor },
      iterable,
      close: () => iterable.close(),
    };
  },
});

function workflowSubscriptionScope(selector: 'events' | 'tokens'): AuthorizationScope {
  return selector === 'tokens' ? 'streams:read' : 'events:read';
}
