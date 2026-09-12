/**
 * A real, separately-importable workflow module for the dynamic-source
 * fixture (WFT-116). It lives in its own file, in its own directory, because
 * `workflowSource()`'s loader must be a literal `() => import('./x.ts')` for
 * the handle's types to infer from the module's real exports — a dynamic
 * `import(pathVariable)` is rejected at the type level.
 *
 * Nothing under `src/` imports this; only `fixtures/dynamic-sources.ts`
 * does, and only through the loader closure the dev harness registers. That
 * is the point: until an operator preloads it (or a run starts it), the
 * serving engine never evaluates this module at all — which is exactly the
 * `idle` load state the console's diagnostics surface reports.
 */
import { activity, workflow } from '@lostgradient/weft';

interface InvoiceReconciliationInput {
  invoiceId: string;
}

const matchLedgerEntry = activity({
  name: 'matchLedgerEntry',
  execute: async (input: { invoiceId: string }) => {
    return { invoiceId: input.invoiceId, matched: true };
  },
});

export const invoiceReconciliation = workflow({ name: 'invoice-reconciliation' })
  .activities({ matchLedgerEntry })
  .execute(async function* (ctx, input: InvoiceReconciliationInput) {
    const match = yield* ctx.run('matchLedgerEntry', { invoiceId: input.invoiceId });
    return { invoiceId: input.invoiceId, matched: match.matched };
  });
