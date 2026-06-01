/**
 * Shared name-grammar validator for workflow and activity names.
 *
 * The wire format used by the remote worker protocol qualifies activity names
 * as `${workflowType}.${activityName}` (introduced in Phase 4). To keep that
 * encoding unambiguous, the dot separator must never appear inside a workflow
 * or activity name, and names must start with a letter or underscore. The
 * permitted character class is `[A-Za-z_][A-Za-z0-9_-]*`.
 *
 * This helper is called from public construction and registration sites:
 *
 *   1. `workflow({ name })` — rejects invalid workflow names.
 *   2. `engine.register(workflowDefinition)` — rejects invalid structural
 *      workflow names before they reach the workflow registry.
 *   3. `WorkflowBuilder.activities({ ... })` keys — rejects invalid activity
 *      names supplied as the outer object key.
 *   4. `activity({ name })` — rejects invalid names on the canonical
 *      activity-definition constructor.
 *   5. `ActivityRegistry.register(name, fn)` — rejects invalid names before
 *      they reach local or global activity registries.
 *
 * Keep this list in sync with Phase 4's worker SDK key validation: any name
 * that passes here must also pass on the worker side, and vice versa.
 */

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Discriminator for the error message so callers see which construction site
 * rejected the name. Add new kinds here when new entry points need validation.
 */
export type NameKind = 'workflow' | 'activity';

/**
 * Validate a workflow or activity name against the wire-safe grammar.
 *
 * Throws an `Error` if the name is empty, contains a `.`, or fails the
 * `[A-Za-z_][A-Za-z0-9_-]*` regex. The thrown message includes the offending
 * name and the `kind` so the failure points at the source location, not deep
 * inside replay or worker dispatch.
 *
 * @example
 * ```ts
 * import { validateWorkflowOrActivityName } from '@lostgradient/weft';
 *
 * validateWorkflowOrActivityName('formatGreeting', 'activity'); // ok
 * try {
 *   validateWorkflowOrActivityName('bad.name', 'activity');
 * } catch (error) {
 *   void error; // Error: activity name "bad.name" is invalid ...
 * }
 * ```
 */
const RULE_DESCRIPTION =
  'must match /^[A-Za-z_][A-Za-z0-9_-]*$/ — start with a letter or underscore, ' +
  "use only letters, digits, underscores, or hyphens, and contain no '.' characters. " +
  'The remote worker protocol encodes activity names as `${workflowType}.${activityName}` ' +
  "on the wire, so a '.' inside either name would break the qualifier split. " +
  "If you previously used dotted names like 'payments.charge', rename to 'payments-charge' " +
  "or 'paymentsCharge' before adopting the workflow-builder API.";

export function validateWorkflowOrActivityName(name: string, kind: NameKind): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`${kind} name must be a non-empty string — ${RULE_DESCRIPTION}`);
  }
  if (name.includes('.')) {
    throw new Error(
      `${kind} name "${name}" contains '.', which is reserved for qualified activity names. ${RULE_DESCRIPTION}`,
    );
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`${kind} name "${name}" is invalid — ${RULE_DESCRIPTION}`);
  }
}
