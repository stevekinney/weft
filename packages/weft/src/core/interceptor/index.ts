import type { Interceptor } from './interceptor-interfaces.ts';

export * from './activity-composition.ts';
export * from './interception-contexts.ts';
export * from './interceptor-interfaces.ts';
export * from './split.ts';
export * from './workflow-composition.ts';

/**
 * Create an interceptor with inference preserved at the declaration site.
 * The optional `name` field is carried for observability and diagnostics.
 *
 * @example
 * ```ts
 * import { interceptor } from '@lostgradient/weft';
 *
 * const tracer = interceptor({
 *   name: 'tracer',
 *   *activity(ctx, next) {
 *     return yield* next(ctx);
 *   },
 * });
 * ```
 */
export function interceptor<TInterceptor extends Interceptor & { readonly name?: string }>(
  spec: TInterceptor,
): TInterceptor {
  return spec;
}
