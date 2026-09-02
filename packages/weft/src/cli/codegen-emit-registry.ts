/**
 * `.d.ts` assembly for `weft codegen`'s active-workflow projection.
 *
 * Consumes the active workflow projection of a registry snapshot
 * (`Record<name, CodegenWorkflowEntry>`, projected from its v2 manifest
 * array by `codegen-validate.ts`'s `resolveActiveWorkflowEntries`) and
 * produces a single `.d.ts` string that augments the public
 * `'@lostgradient/weft'` module with typed `WorkflowRegistry` entries. The
 * output is byte-stable across runs with the same input: keys are sorted
 * with explicit codepoint comparators, property names and string-literal
 * values are uniformly double-quoted via `emitStringLiteral`, and there are
 * no timestamps or environment-dependent paths.
 *
 * The augmented `WorkflowRegistry` interface is the single source of truth
 * for per-workflow input/output typing across the whole public surface:
 * `engine.start`, `WorkflowHandle.result()`, AND the client
 * (`WeftClient.start`/`schedule` and `ClientHandle.result()`). The client
 * overloads key off this interface, so emitting one declaration narrows
 * both engine and client call sites — there is no separate client-specific
 * emission, and skipping codegen leaves both usable with plain string
 * names. Every entry also carries `revision`/`workflowVersion` as
 * string-literal fields for compile-time introspection; neither is
 * required by `engine.start`/`WeftClient.start`/`.schedule()`, which read
 * only `input`/`output` structurally (`WorkflowInput`/`WorkflowOutput` in
 * `core/types/workflow-registries.ts`) — an ordinary start needs no
 * caller-supplied revision.
 *
 * Activity names are no longer emitted as a global `ActivityTypes` module
 * augmentation — that interface was removed when the chained workflow
 * builder made activity names a per-workflow concern (typed at the
 * builder's `.activities({...})` step). The snapshot still carries
 * activity schemas because the same registry feeds discovery and MCP
 * tooling, but the emitter intentionally drops them from the generated
 * `.d.ts`.
 *
 * When two or more workflow entries' `inputSchema`/`outputSchema` render to
 * the same non-trivial TypeScript text (see `codegen-emit-dedup.ts` — grouped
 * by the emitted text itself, not by a JSON-level normalization of the
 * source schema, so schemas differing only in an order-insensitive JSON
 * construct like `required` array order still dedupe correctly), that text
 * is hoisted into a single, unexported, file-top-level
 * `type __WeftSchema_<hash> = <TS type>;` alias declared BEFORE
 * `declare module '@lostgradient/weft' { ... }` — never inside it.
 * Placing an alias inside the augmentation block would make it a
 * pseudo-public exported type name of `@lostgradient/weft` (autocomplete
 * pollution for every consumer), and because TypeScript `type` aliases
 * don't structurally merge the way `interface` does, two independently
 * generated `.d.ts` files declaring the same content-derived alias name
 * inside the same augmented interface would collide with a real
 * "Duplicate identifier" compile error the moment both landed in one
 * TypeScript program. File-scoped placement avoids both problems.
 *
 * @module cli/codegen-emit-registry
 */

import { compareCodepoint } from '../core/compare-codepoint.ts';
import {
  buildSchemaAliasTable,
  type SchemaAliasEntry,
  type SchemaFragmentOccurrence,
} from './codegen-emit-dedup.ts';
import { emitPropertyKey, emitStringLiteral, jsonSchemaToTypeScript } from './codegen-emit.ts';

export { CodegenEmitError } from './codegen-emit-keywords.ts';

const WEFT_PACKAGE_NAME = '@lostgradient/weft';

/**
 * One active workflow's codegen-relevant metadata: its input/output
 * schemas plus the `revision`/`workflowVersion` identity fields every
 * generated entry now carries. Deliberately narrower than, and separate
 * from, `core/registry-workflow-manifest.ts`'s `RegistryWorkflowEntry` —
 * that type also describes the full registration-time shape fed into
 * `buildWorkflowRevisionManifest` itself (which doesn't yet have a
 * `revision` to attach — a manifest can't carry the revision of the
 * manifest used to build it), so widening it here would be circular.
 * `description`/`tags` are carried through for parity with the source
 * manifest and future codegen features, but this batch does not emit them
 * into the `.d.ts` (see the module's `openQuestions` in its planning
 * record — emitting free-text description as a JSDoc comment reopens the
 * same injection-safety surface WFT-5 closed for the contract module, and
 * is out of scope here).
 */
export type CodegenWorkflowEntry = {
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  description?: string;
  tags?: ReadonlyArray<string>;
  revision: string;
  workflowVersion: string;
};

function sortedWorkflowEntries(
  workflows: Record<string, CodegenWorkflowEntry>,
): Array<[string, CodegenWorkflowEntry]> {
  return Object.entries(workflows).toSorted(([a], [b]) => compareCodepoint(a, b));
}

/** One active workflow paired with its already-emitted input/output TypeScript text, computed exactly once. */
type WorkflowWithSchemaTypes = {
  name: string;
  entry: CodegenWorkflowEntry;
  inputType: string;
  outputType: string;
};

/**
 * Walk every active workflow's `inputSchema` then `outputSchema`, in that
 * fixed order, computing each schema's emitted TypeScript text exactly
 * once. `workflows` is already sorted by name (see
 * {@link sortedWorkflowEntries}), so the resulting occurrence sequence —
 * and therefore every alias assignment downstream — depends only on the
 * set of active workflows and their schemas, never on the caller's
 * original object insertion order.
 *
 * Returns both the flat occurrence sequence {@link buildSchemaAliasTable}
 * groups AND `workflowsWithTypes`, each workflow paired with the text
 * computed for it here, so {@link emitWorkflowEntry} can use that text
 * directly instead of re-running `jsonSchemaToTypeScript` on the same
 * schema a second time. Pairing the type text onto the workflow itself
 * (rather than a separate name-keyed or index-keyed lookup) means there is
 * no lookup that could fail to find an entry.
 */
function collectSchemaOccurrences(
  workflows: ReadonlyArray<readonly [string, CodegenWorkflowEntry]>,
): {
  occurrences: SchemaFragmentOccurrence[];
  workflowsWithTypes: WorkflowWithSchemaTypes[];
} {
  const occurrences: SchemaFragmentOccurrence[] = [];
  const workflowsWithTypes: WorkflowWithSchemaTypes[] = [];
  for (const [name, entry] of workflows) {
    const inputType = jsonSchemaToTypeScript(entry.inputSchema);
    const outputType = jsonSchemaToTypeScript(entry.outputSchema);
    occurrences.push({ tsType: inputType }, { tsType: outputType });
    workflowsWithTypes.push({ name, entry, inputType, outputType });
  }
  return { occurrences, workflowsWithTypes };
}

/** Resolve an already-emitted schema type to its TypeScript type reference: the hoisted alias name when one exists for this emitted type, otherwise the emitted type itself. */
function schemaTypeReference(
  tsType: string,
  aliasTable: ReadonlyMap<string, SchemaAliasEntry>,
): string {
  const aliasEntry = aliasTable.get(tsType);
  return aliasEntry !== undefined ? aliasEntry.alias : tsType;
}

function emitWorkflowEntry(
  workflow: WorkflowWithSchemaTypes,
  aliasTable: ReadonlyMap<string, SchemaAliasEntry>,
): string {
  const { name, entry, inputType, outputType } = workflow;
  const input = schemaTypeReference(inputType, aliasTable);
  const output = schemaTypeReference(outputType, aliasTable);
  const revision = emitStringLiteral(entry.revision);
  const workflowVersion = emitStringLiteral(entry.workflowVersion);
  return (
    `    ${emitPropertyKey(name)}: { input: ${input}; output: ${output}; ` +
    `revision: ${revision}; workflowVersion: ${workflowVersion} };`
  );
}

/** Emit each hoisted alias's `type <alias> = <tsType>;` declaration, sorted by alias name for determinism regardless of grouping order. */
function emitAliasDeclarations(aliasTable: ReadonlyMap<string, SchemaAliasEntry>): string[] {
  return [...aliasTable.values()]
    .toSorted((a, b) => compareCodepoint(a.alias, b.alias))
    .map((entry) => `type ${entry.alias} = ${entry.tsType};`);
}

/**
 * Emit the full `.d.ts` declaration string for a registry's active workflow
 * projection.
 *
 * The output is deterministic: keys are sorted by codepoint, property
 * names and string-literal values go through {@link emitPropertyKey}/
 * {@link emitStringLiteral}, unions/intersections are always parenthesized
 * so they compose correctly when nested, and hoisted schema aliases are
 * sorted by alias name.
 */
export function emitRegistryDeclaration(
  activeWorkflows: Record<string, CodegenWorkflowEntry>,
): string {
  const workflows = sortedWorkflowEntries(activeWorkflows);
  const { occurrences, workflowsWithTypes } = collectSchemaOccurrences(workflows);
  const aliasTable = buildSchemaAliasTable(occurrences);
  const aliasLines = emitAliasDeclarations(aliasTable);

  const workflowLines = workflowsWithTypes.map((workflow) =>
    emitWorkflowEntry(workflow, aliasTable),
  );

  const workflowBlock =
    workflowLines.length === 0
      ? '  interface WorkflowRegistry {}'
      : ['  interface WorkflowRegistry {', ...workflowLines, '  }'].join('\n');

  const lines = [
    '// Generated by `weft codegen`. Do not edit by hand.',
    '// Augments `WorkflowRegistry` to type engine and client call sites',
    '// (start/schedule input and handle.result() output) per workflow.',
    '/* eslint-disable */',
    '',
    ...aliasLines,
    ...(aliasLines.length > 0 ? [''] : []),
    `declare module '${WEFT_PACKAGE_NAME}' {`,
    workflowBlock,
    '}',
    '',
    'export {};',
    '',
  ];

  return lines.join('\n');
}
