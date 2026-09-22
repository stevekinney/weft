import type { ActivityExecutionInterception, ActivityInterceptor } from '../core/interceptor.ts';
import type { OpenTelemetrySpan } from './no-op-telemetry.ts';
import { NO_OP_SPAN_METHODS } from './no-op-telemetry.ts';
import { extractTraceParent } from './propagation.ts';
import { runAsyncWithSpan, serializePayload } from './span-helpers.ts';
import type { ObservabilityState } from './types.ts';

export function buildActivityInterceptor(state: ObservabilityState): ActivityInterceptor {
  return {
    async execute(
      interception: ActivityExecutionInterception,
      next: (interception: ActivityExecutionInterception) => Promise<unknown>,
    ): Promise<unknown> {
      const parentContext = extractTraceParent(interception.headers);

      let parentCtx = state.api.context.ROOT_CONTEXT;
      if (parentContext) {
        const remoteParentSpan: OpenTelemetrySpan = {
          ...NO_OP_SPAN_METHODS,
          spanContext() {
            return {
              traceId: parentContext.traceId,
              spanId: parentContext.spanId,
              traceFlags: parentContext.traceFlags,
            };
          },
        };
        parentCtx = state.trace.setSpan(state.api.context.ROOT_CONTEXT, remoteParentSpan);
      }

      const span = state.tracer.startSpan(
        `activity:execute:${interception.activityName}`,
        {
          attributes: {
            'weft.activity.name': interception.activityName,
            'weft.activity.attempt': interception.attempt,
            ...(parentContext ? { 'weft.parent.trace_id': parentContext.traceId } : {}),
          },
        },
        parentCtx,
      );

      if (state.recordPayloads && interception.input !== undefined) {
        span.setAttribute(
          'weft.payload.input',
          serializePayload(interception.input, state.maxPayloadSize),
        );
      }

      return runAsyncWithSpan(state, span, () => next(interception));
    },
  };
}
