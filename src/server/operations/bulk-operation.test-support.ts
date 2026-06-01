/**
 * Shared test-only support for bulk-workflow REST operation behavior tests
 * (`bulk-cancel`, `bulk-delete`, `bulk-signal`, `bulk-mutate-workflow-tags`).
 *
 * Each suite previously repeated the same engine factory, bulk-admin
 * authentication context, and `handleRequest` option wiring. Those are shared
 * here, parameterized by the operation registry and REST bindings under test so
 * no suite is routed through another operation. The operation imports, request
 * paths/methods/bodies, and assertions stay local to each suite.
 *
 * This module is test-only (`.test-support.ts` is excluded from the production
 * build) and must never be imported by production server code.
 */

import { Engine } from '../../core/engine.ts';
import type { AnyWorkflowDefinition } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import type { HandlerOptions } from '../handler/route-dispatch.ts';
import { principalFromApiKey } from '../principal.ts';

/**
 * Build a `MemoryStorage`-backed engine with the given workflow definitions
 * registered. Suites pass the workflows their behavior tests exercise.
 */
export function createBulkTestEngine(...workflows: AnyWorkflowDefinition[]): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  for (const definition of workflows) {
    engine.register(definition);
  }
  return engine;
}

/**
 * `handleRequest` options for a bulk-admin operator: the supplied operation
 * registry and REST bindings, plus an api-key principal scoped to
 * `workflows:admin`. `operationRegistry` and `restBindings` must travel
 * together, which this helper guarantees.
 */
export function bulkAdminHandlerOptions({
  registry,
  bindings,
}: {
  registry: NonNullable<HandlerOptions['operationRegistry']>;
  bindings: NonNullable<HandlerOptions['restBindings']>;
}): HandlerOptions {
  return {
    operationRegistry: registry,
    restBindings: bindings,
    authContext: {
      method: 'api-key',
      principal: principalFromApiKey({
        subject: 'bulk-admin-operator',
        scopes: ['workflows:admin'],
      }),
    },
  };
}
