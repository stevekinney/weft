/**
 * The `./generator` entry: the client generator, which lives in `scripts/` beside its helpers and
 * its tests. The workspace contract wants every export to point at a `src` file, so this entry
 * re-exports it. Unlike the `.`, `./internals` and `./client` entries it may import `node:` modules,
 * so the browser type-check leaves it out.
 *
 * @module generator
 */

export {
  createOperationClientSources,
  type OperationClientConnection,
  type OperationClientExamples,
  type OperationClientOptions,
  type OperationClientSubscriptionRoutes,
  type OperationDomainName,
} from '../scripts/generate-operation-client.ts';
