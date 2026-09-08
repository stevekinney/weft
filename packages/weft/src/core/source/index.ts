/**
 * Dynamic workflow sources (WFT-13/14): a typed `workflowSource()` factory,
 * the `WorkflowSourceDescriptor`/`WorkflowSourceHandle` types, source-kind
 * resolution, and validation — re-exported both for the package root
 * (`src/index.ts`) and for `core/engine/source-registration.ts` /
 * `core/engine/source-resolution.ts`, which cannot import `internals.ts`
 * (the only import-restricted module in this package) but need everything
 * else here.
 *
 * @module core/source
 */

export type {
  WorkflowSourceDescriptor,
  WorkflowSourceDescriptorInput,
  WorkflowSourceHandle,
  WorkflowSourceKind,
} from './types.ts';
export { workflowSource } from './workflow-source.ts';

export { WorkflowSourceValidationError } from './errors.ts';
export type { WorkflowSourceRejectionReason } from './errors.ts';

export { resolveSourceModule } from './resolvers.ts';
export type { ResolveSourceModuleResult } from './resolvers.ts';

export { validateResolvedWorkflowSource } from './validate.ts';
export type { WorkflowSourceValidationOutcome } from './validate.ts';
