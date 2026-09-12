import { compareCodepoint } from '../compare-codepoint.ts';
import type { Engine } from './index.ts';
import { getInternals } from './internals.ts';

export type WorkflowSourceListing = Readonly<{
  name: string;
  revision: string;
  kind: import('../source/index.ts').WorkflowSourceKind;
  state: import('./source-runtime-state.ts').SourceLoadState;
}>;

/** List registered dynamic sources using process-local state only. */
export function listWorkflowSources(engine: Engine): WorkflowSourceListing[] {
  const internals = getInternals(engine);
  const sources: WorkflowSourceListing[] = [];
  for (const [name, revisions] of internals.sources.byName) {
    for (const [revision, handle] of revisions) {
      sources.push({
        name,
        revision,
        kind: handle.descriptor.kind,
        state: internals.sources.diagnostics.get(name)?.get(revision)?.state ?? 'idle',
      });
    }
  }
  return sources.toSorted((left, right) => {
    const nameOrder = compareCodepoint(left.name, right.name);
    return nameOrder === 0 ? compareCodepoint(left.revision, right.revision) : nameOrder;
  });
}
