import type { Engine } from './index.ts';
import type { OperationRouterCallbacks } from './operations-router.ts';

/**
 * Registry slot for the operation-router callback factory. The router lives in
 * a sibling module that depends on per-domain bundles; the bundles in turn
 * need to call the router for the `*ForEngine` helpers. This registry breaks
 * what would otherwise be a static import cycle: at module load time the
 * router module calls {@link registerOperationRouterCallbacksFactory}, and
 * bundle helpers reach the router lazily through {@link callRouterCallbacks}.
 */
let factory:
  | (<TW extends object, TA extends object>(engine: Engine<TW, TA>) => OperationRouterCallbacks)
  | undefined;

export function registerOperationRouterCallbacksFactory(
  fn: <TW extends object, TA extends object>(engine: Engine<TW, TA>) => OperationRouterCallbacks,
): void {
  factory = fn;
}

export function callRouterCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): OperationRouterCallbacks {
  if (factory === undefined) {
    throw new Error(
      'Operation-router callback factory was not registered before being requested. ' +
        'Ensure the engine has been initialized (which loads the router module).',
    );
  }
  return factory(engine);
}
