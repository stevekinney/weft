import { Engine } from '../core/engine.ts';
import { workflow } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import {
  createFetchHandler,
  setupServiceWorker,
  type ServiceWorkerHandlerOptions,
  type ServiceWorkerOptions,
  type SetupServiceWorkerOptions,
} from './index.ts';

const greet = workflow({ name: 'greet' }).execute(async function* (_ctx, input: { a: number }) {
  return { b: input.a };
});

// Regression guard for #708 (sibling of `ServeOptions.engine`):
// `ServiceWorkerOptions.engine` and `SetupServiceWorkerOptions.engine` must
// accept BOTH `new Engine({ storage })` (the default, empty registry) and
// `Engine.create({ workflows })` (a concretely narrowed, non-empty registry)
// without a call-site cast.
async function verifyServiceWorkerOptionsAcceptBothEngineConstructionPatterns(): Promise<void> {
  const defaultEngine = new Engine({ storage: new MemoryStorage() });
  const concreteEngine = await Engine.create({
    storage: new MemoryStorage(),
    workflows: { greet },
  });

  const defaultOptions: ServiceWorkerOptions = { engine: defaultEngine };
  const concreteOptions: ServiceWorkerOptions = { engine: concreteEngine };
  void defaultOptions;
  void concreteOptions;

  const defaultFetchHandler = createFetchHandler({ engine: defaultEngine });
  const concreteFetchHandler = createFetchHandler({ engine: concreteEngine });
  void defaultFetchHandler;
  void concreteFetchHandler;

  const defaultSetupOptions: SetupServiceWorkerOptions = { engine: defaultEngine };
  const concreteSetupOptions: SetupServiceWorkerOptions = { engine: concreteEngine };
  void defaultSetupOptions;
  void concreteSetupOptions;

  void setupServiceWorker({ engine: defaultEngine });
  void setupServiceWorker({ engine: concreteEngine });

  const handlerOptions = {
    authContext: { method: 'public' as const },
  } satisfies ServiceWorkerHandlerOptions;
  const optionsWithHandlerOptions: ServiceWorkerOptions = {
    engine: defaultEngine,
    handlerOptions,
  };
  const setupWithHandlerOptions: SetupServiceWorkerOptions = {
    engine: concreteEngine,
    handlerOptions,
  };
  void optionsWithHandlerOptions;
  void setupWithHandlerOptions;
}
void verifyServiceWorkerOptionsAcceptBothEngineConstructionPatterns;
