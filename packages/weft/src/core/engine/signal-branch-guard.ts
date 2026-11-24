import type { ContextOperationRequest } from '../context.ts';

/**
 * Reject a `ctx.race` / `ctx.all` whose branches wait on the SAME signal name,
 * recursively through nested `race` / `parallel` branches. Sibling wait-signal
 * branches share the `${workflowId}:${signalName}` waiter key, so two anywhere in
 * the coordination tree would clobber each other at registration, leaving one
 * branch permanently unreachable (the run would hang). Reject the meaningless
 * shape deterministically rather than silently dropping a branch. Distinct names
 * (the event-or-close idiom) are unaffected.
 */
export function assertSupportedSignalBranches(
  operations: readonly ContextOperationRequest[],
): void {
  const seen = new Set<string>();
  const walk = (subOperations: readonly ContextOperationRequest[]): void => {
    for (const subOperation of subOperations) {
      if (subOperation.type === 'wait-signal') {
        if (seen.has(subOperation.signalName)) {
          throw new Error(
            `ctx.race / ctx.all cannot have two branches waiting on the same signal "${subOperation.signalName}": ` +
              'sibling wait-signal branches share one waiter and would clobber each other. ' +
              'Wait on the signal once, or use distinct signal names.',
          );
        }
        seen.add(subOperation.signalName);
      } else if (subOperation.type === 'race' || subOperation.type === 'parallel') {
        walk(subOperation.operations);
      }
    }
  };
  walk(operations);
}
