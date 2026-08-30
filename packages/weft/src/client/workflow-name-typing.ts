/**
 * Registry-driven type-level helpers that gate the client's typed
 * `start`/`schedule` overloads on the augmented {@link WorkflowRegistry}.
 *
 * @module client/workflow-name-typing
 */

import type { WorkflowRegistry } from '../core/types.ts';

/**
 * Workflow names known to the augmented {@link WorkflowRegistry}. Empty
 * (`never`) until a project augments the registry — typically by running
 * `weft codegen` and including the generated `.d.ts` in its compilation. The
 * client's typed `start`/`schedule` overloads key off this set, so without
 * codegen they degrade to the permissive string-name overloads.
 *
 * `weft codegen` only ever emits explicit string-literal entries, so in
 * practice this resolves to a finite union of registered names. If a project
 * hand-augments `WorkflowRegistry` with an index signature
 * (`[name: string]: ...`), `KnownWorkflowName` widens to `string` and the
 * typed overload accepts any name with that entry's input type — the same
 * behavior the engine exhibits, and a deliberate consequence of opting into a
 * permissive augmentation.
 */
export type KnownWorkflowName = Extract<keyof WorkflowRegistry, string>;

/**
 * Resolves to `TName` only when the {@link WorkflowRegistry} carries no known
 * names (codegen has not run, or no workflow types were emitted). This gates
 * the permissive string-name `start`/`schedule` overload so that, once the
 * registry is populated, callers must pass a registered name (or fall through
 * to the typed overload). Mirrors the engine's
 * `UnknownWorkflowNameWhenDefaultRegistryIsEmpty` gate, scoped to the global
 * registry the client consumes.
 */
export type UnknownNameWhenRegistryEmpty<TName extends string> = [KnownWorkflowName] extends [never]
  ? TName
  : never;
