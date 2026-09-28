/**
 * Engine-level entry point for realm diagnostics (COR-243), mirroring
 * `catalog-removal.ts`'s `getWorkflowRevisionDiagnostics` shape: a plain
 * function taking the live `Engine`, reading its opt-in
 * `EngineInternals.revisionRealmRegistry` (undefined unless
 * `workflowExecutionMode: 'realm'`), never a method on `Engine` itself.
 *
 * @module core/engine/revision-realm-diagnostics
 */

import type { RevisionRealmPoolDiagnostics } from '../realm/revision-realm-diagnostics.ts';
import type { Engine } from './index.ts';
import { getInternals } from './internals.ts';

/**
 * Bounded diagnostics for every `(name, revision)` realm pool this engine
 * currently owns. Returns an empty array for an engine that never opted
 * into `workflowExecutionMode: 'realm'` — `revisionRealmRegistry` is
 * `undefined` by default, matching every other realm diagnostic's
 * "absent means empty/zero" convention (see
 * `countWorkflowRevisionReferences`'s own `activeExecutionRealms` field).
 *
 * @example
 * ```ts
 * import { Engine, getRevisionRealmDiagnostics } from '@lostgradient/weft';
 *
 * function summarize(engine: Engine): number {
 *   return getRevisionRealmDiagnostics(engine).length;
 * }
 * void summarize;
 * ```
 */
export function getRevisionRealmDiagnostics(
  engine: Engine,
): readonly RevisionRealmPoolDiagnostics[] {
  return getInternals(engine).revisionRealmRegistry?.listDiagnostics() ?? [];
}
