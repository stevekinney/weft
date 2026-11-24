/**
 * `withRedactedPushConfigurations`: keep push-notification credentials out of the
 * responses that read configurations back.
 *
 * @module a2a/redact-push-configurations
 */

import type { TaskPushNotificationConfig } from '@a2a-js/sdk';
import type { A2ARequestHandler, ServerCallContext } from '@a2a-js/sdk/server';

/** What a redacted response carries in place of `authentication.credentials`. */
export const REDACTED_PUSH_CREDENTIALS = '[REDACTED]';

function redact(config: TaskPushNotificationConfig): TaskPushNotificationConfig {
  return config.authentication === undefined
    ? config
    : {
        ...config,
        authentication: { ...config.authentication, credentials: REDACTED_PUSH_CREDENTIALS },
      };
}

/**
 * Wrap a request handler so `GetTaskPushNotificationConfig` and
 * `ListTaskPushNotificationConfigs` responses carry `authentication.credentials` as
 * `[REDACTED]`. The push-notification store keeps returning them unredacted, because
 * the sender needs them. Every other member is the handler's own, bound to the handler.
 *
 * @example
 * ```ts
 * import type { A2ARequestHandler } from '@a2a-js/sdk/server';
 * import { withRedactedPushConfigurations } from '@lostgradient/weft/a2a';
 *
 * declare const requestHandler: A2ARequestHandler;
 * const served = withRedactedPushConfigurations(requestHandler);
 * void served;
 * ```
 */
export function withRedactedPushConfigurations(
  requestHandler: A2ARequestHandler,
): A2ARequestHandler {
  return new Proxy(requestHandler, {
    get(target, property) {
      if (property === 'getTaskPushNotificationConfig') {
        return async (
          params: Parameters<A2ARequestHandler['getTaskPushNotificationConfig']>[0],
          context: ServerCallContext,
        ) => redact(await target.getTaskPushNotificationConfig(params, context));
      }
      if (property === 'listTaskPushNotificationConfigs') {
        return async (
          params: Parameters<A2ARequestHandler['listTaskPushNotificationConfigs']>[0],
          context: ServerCallContext,
        ) => {
          const response = await target.listTaskPushNotificationConfigs(params, context);
          return { ...response, configs: response.configs.map(redact) };
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
