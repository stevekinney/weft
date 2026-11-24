/**
 * Run a suite as a runtime without `node:async_hooks` would (a Web Worker, a Service Worker): the
 * engine reaches the module only through `process.getBuiltinModule`, so answering `undefined` for
 * it there takes it away. Call {@link hideAsyncHooks} before the engine modules load (import the
 * suites with a dynamic `import()` after it), and the returned function puts the module back.
 */
import { resetDurableActivityScopeStorageForTesting } from '../core/context/durable-activity.ts';

type ProcessWithBuiltinModule = { getBuiltinModule?: ((id: string) => unknown) | undefined };

export function hideAsyncHooks(): () => void {
  const host = process as unknown as ProcessWithBuiltinModule;
  const original = host.getBuiltinModule;
  host.getBuiltinModule = (id: string) =>
    id === 'node:async_hooks' || id === 'async_hooks' ? undefined : original?.call(process, id);
  resetDurableActivityScopeStorageForTesting();
  return () => {
    host.getBuiltinModule = original;
    resetDurableActivityScopeStorageForTesting();
  };
}
