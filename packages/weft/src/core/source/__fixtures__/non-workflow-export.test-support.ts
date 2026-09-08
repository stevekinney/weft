/**
 * Fixture module for `core/source/**` type-level and runtime tests: exports
 * a plain, non-`WorkflowDefinition` value under a given name, and re-exports
 * another module as a namespace (an "ambiguous export" barrel). Used to
 * assert `workflowSource()`'s type-level rejection and `validate.ts`'s
 * runtime rejection of a wrong-shaped export. `.test-support.ts` so
 * `bun run build`'s post-build dangling-import guard never sees it.
 */

export const notAWorkflow = { hello: 'world' };

export * as namespaceBarrel from './checkout-workflow.test-support.ts';
