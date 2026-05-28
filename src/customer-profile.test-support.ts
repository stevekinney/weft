/**
 * Single source of truth bridge for the customer-profile example — see
 * {@link file://./hello-world.test-support.ts} for the rationale. The canonical
 * definitions live in `examples/hello-world/src/index.ts`; this file re-exports
 * them so in-repo tests share the exact code a consumer sees.
 */
export {
  customerProfileWorkflow,
  loadCustomerProfileActivity,
} from '../examples/hello-world/src/index.ts';
