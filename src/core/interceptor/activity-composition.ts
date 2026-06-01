import type { ActivityExecutionInterception } from './interception-contexts.ts';
import type { ActivityInterceptor, ComposedActivityInterceptor } from './interceptor-interfaces.ts';

// Composition: activity interceptors
// ---------------------------------------------------------------------------

/**
 * Compose multiple activity interceptors into a single interceptor chain.
 *
 * @example
 * ```ts
 * import { composeActivityInterceptors, type ActivityInterceptor } from '@lostgradient/weft';
 *
 * const retryLogger: ActivityInterceptor = {
 *   async execute(ctx, next) {
 *     const result = await next(ctx);
 *     console.log(ctx.activityName, 'attempt', ctx.attempt, 'succeeded');
 *     return result;
 *   },
 * };
 * const composed = composeActivityInterceptors([retryLogger]);
 * void composed;
 * ```
 */
export function composeActivityInterceptors(
  interceptors: ActivityInterceptor[],
): ComposedActivityInterceptor {
  return {
    async execute(
      interception: ActivityExecutionInterception,
      execute: (interception: ActivityExecutionInterception) => Promise<unknown>,
    ): Promise<unknown> {
      type Next = (ctx: ActivityExecutionInterception) => Promise<unknown>;

      let chain: Next = execute;

      for (let i = interceptors.length - 1; i >= 0; i--) {
        const interceptor = interceptors[i]!;

        if (interceptor.execute) {
          const innerNext = chain;
          const bound = interceptor.execute.bind(interceptor);
          chain = (ctx: ActivityExecutionInterception): Promise<unknown> => {
            return bound(ctx, innerNext);
          };
        }
      }

      return chain(interception);
    },
  };
}
