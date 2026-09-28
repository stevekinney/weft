/**
 * Test-only stand-in for a workflow implementation module (COR-249).
 *
 * Real production workflow code lives here in a real deployment: a revision
 * realm's bootstrap script imports it to register the workflow generator(s)
 * it serves. This package builds no such bundler pipeline — a revision's
 * `workerUrl` is an injected dependency the caller supplies — so this
 * fixture stands in for "the module a revision realm's bootstrap imports"
 * in tests, including the module-graph boundary test that asserts the
 * stable host never reaches this file.
 *
 * `WORKFLOW_IMPLEMENTATION_SENTINEL` is deliberately unique (not a common
 * word or short string) so a `Bun.build()`-bundled module graph either
 * clearly contains it (a realm-side entry that legitimately imports this
 * fixture) or clearly does not (the host-side pool/registry modules).
 */

export const WORKFLOW_IMPLEMENTATION_SENTINEL =
  'weft-cor249-revision-realm-workflow-implementation-fixture-8f2c1a';

export function runFixtureWorkflow(input: unknown): { echoed: unknown; sentinel: string } {
  return { echoed: input, sentinel: WORKFLOW_IMPLEMENTATION_SENTINEL };
}
