import type { CatalogOperationSnapshot } from "../src/embedded/backchannel/src/index.ts";

/**
 * Names the generated file an operation's types go in. Catalog tags own the contract groups; task
 * detail and bulk execution have separate schemas, so Weft splits four groups out of their tag.
 */
export function weftOperationDomainName(operation: CatalogOperationSnapshot): string {
  const tag = operation.tags[0] ?? 'Other';
  if (tag === 'Workflows' && operation.name.startsWith('weft.workflows.bulk.'))
    return 'Bulk Workflows';
  if (tag === 'Observability' && operation.name === 'weft.tasks.get') return 'Task Detail';
  if (tag === 'Observability' && operation.name.startsWith('weft.tasks.'))
    return 'Task Diagnostics';
  if (tag === 'Observability' && operation.name.startsWith('weft.workers.'))
    return 'Worker Diagnostics';
  return tag;
}
