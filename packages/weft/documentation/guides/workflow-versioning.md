# Workflow Versioning

Workflow versions are a recovery guard. When a workflow starts, Weft records the
registered workflow version in the workflow state and checkpoint. During
recovery, Weft compares the stored version with the currently registered
version. It also checks the recorded version tuple for workflow, agent, and tool
version drift.

Recovery continues for a run only when the workflow versions match and the
stored version tuple has not drifted. A workflow version mismatch or
version-tuple drift blocks that run before user code advances. By default,
`recoverAll()` fails the mismatched run with a `system` failure and continues
recovering its siblings; `versionMismatchPolicy: 'throw'` instead stops at the
first mismatch in storage-scan order. Weft does not run a checkpoint migration
hook during recovery; changing a workflow version is an explicit recovery
boundary, not an automatic data-upgrade path.

## Version Pinning

The default workflow version is `'0.0.0'` when you do not specify one during
registration.

```typescript partial
engine.register(workflow({ name: 'order' }).execute(orderWorkflow));
```

Set an explicit version when you want a recovery boundary around a workflow
definition:

```typescript partial
engine.register(workflow({ name: 'order', version: '2.0.0' }).execute(orderWorkflowV2));
```

The version string is stored with the checkpoint. A later process that registers
`order` with a different version cannot silently resume that checkpoint.

## Compatibility Check

`checkVersionCompatibility()` compares only the stored workflow version and the
registered workflow version. It has two outcomes:

- **`'compatible'`**: versions match and recovery can continue.
- **`'incompatible'`**: versions differ and recovery must stop.

```typescript partial
import { checkVersionCompatibility } from '@lostgradient/weft';

checkVersionCompatibility('1.0.0', '1.0.0'); // 'compatible'
checkVersionCompatibility('1.0.0', '2.0.0'); // 'incompatible'
```

Runtime recovery applies one additional guard after that comparison: if the
stored `versionTuple` drifts from the registered workflow, agent, or tool
versions, it raises the same `VersionMismatchError` at the run's recovery
boundary. `recoverAll()` handles that error according to its
`versionMismatchPolicy`. The `weft version:check` diagnostic reports
workflow-version compatibility; account for version-tuple drift separately when
changing agent or tool version metadata.

## Handling Mismatches

When recovery sees an incompatible workflow version or version-tuple drift, it
creates a `VersionMismatchError`. The error carries the workflow id, workflow
type, stored version, registered version, and optional shape/version-drift
details. The default `recoverAll()` policy records that error on the affected
run and continues with its siblings. Opt into fail-fast recovery when the host
needs the error to reject the recovery call:

```typescript partial
import { VersionMismatchError } from '@lostgradient/weft';

try {
  await engine.recoverAll({ versionMismatchPolicy: 'throw' });
} catch (error) {
  if (error instanceof VersionMismatchError) {
    console.log(error.workflowId);
    console.log(error.workflowType);
    console.log(error.storedVersion);
    console.log(error.registeredVersion);
  }
}
```

The fail-fast policy is not an atomic preflight: siblings processed before the
first mismatch may already be running, while later entries remain unresumed.
See [Version drift](./recovery-and-deploys.md#version-drift-versionmismatchpolicy)
for the full policy contract.

Use `weft version:check` before deployment to see active workflow types whose
stored versions do not match the code you are about to run. Resolve those runs
explicitly before deploying the new workflow version.

## In-flight Patches

Use `ctx.getVersion(changeId, minSupported, maxSupported)` when a code change
affects logic that already-running workflows may not have reached yet. Keep the
registered workflow version stable, add a named patch, and branch on the pinned
number:

```typescript
import { workflow, type WorkflowContext } from '@lostgradient/weft';

type Order = { id: string };

const orderWorkflow = workflow({ name: 'order' }).execute(async function* (
  ctx: WorkflowContext,
  order: Order,
) {
  const shippingVersion = yield* ctx.getVersion('shipping-v2', 1, 2);

  if (shippingVersion === 1) {
    return yield* ctx.run('shipWithLegacyCarrier', order);
  }

  return yield* ctx.run('shipWithCarrierPool', order);
});

void orderWorkflow;
```

The first execution stores `maxSupported` in checkpoint locals under
`version:{changeId}`. Recovery returns the stored value, so workflows that pinned
version `1` keep taking the old branch while new starts pin version `2` and take
the new branch.

The deploy sequence is:

1. Add `ctx.getVersion('change-id', oldVersion, newVersion)` and keep both
   branches.
2. Deploy with the registered workflow version unchanged.
3. Wait until every in-flight run that could have pinned the old version has
   completed.
4. Remove the old branch and raise `minSupported` to the retained version.

If a recovered workflow is pinned below `minSupported`, Weft fails that run with
an actionable error naming the change id, pinned version, and minimum supported
version. That turns accidental early branch removal into an explicit recovery
failure instead of silently running the wrong code.

`ctx.getVersion` is not a checkpoint migration hook. It is for deterministic
branching inside one registered workflow version. When you intentionally change
the registered workflow version, the drain-first guidance above still applies:
resolve active runs or keep compatible code registered until recovery no longer
needs the old version.

## Revision Identity

`revision` is a different axis from `workflowVersion`. `workflowVersion` is the
author-declared replay-compatibility boundary this guide is about — the
version `ctx.getVersion` branches on, and what `weft version:check` compares
against stored state. `revision` answers a narrower, orthogonal question:
"does this contract's declared metadata — name, version, description, tags,
and every schema — match what was previously deployed." By default it is
derived purely from that declared metadata, so it detects a schema, name, or
documentation change, but **not** a handler-implementation change that leaves
every declared field the same (renaming an internal variable, fixing a bug in
the generator body). When byte-level executable identity matters — rollout
verification, drift detection tied to what code actually runs — supply an
explicit opaque revision from your build pipeline instead (a Git SHA, a
content-addressed artifact digest, a release tag) via
`buildWorkflowRevisionManifest(contract, { revision })`.

`buildWorkflowContract()` converts an authoring-time workflow definition (name,
version, schemas, signals, updates, queries, activities, finalizer) into a
normalized `WorkflowContract` — the same representation `weft codegen` and
`contractHash()` both consume, so code generation and the hash it emits can
never silently diverge. `buildWorkflowRevisionManifest()` pairs that contract
with two computed identities:

- **`contractHash`** — a payload-only identity. It excludes `name`,
  `workflowVersion`, `description`, and `tags`, and hashes everything a caller
  may send and expect back: input/output schemas, every signal/update/query,
  every activity, and the finalizer. Two workflows named differently but with
  an identical payload contract hash identically; renaming a workflow or
  editing its description never changes `contractHash`.
- **`revision`** — the broader identity: `deriveWorkflowRevision()` hashes the
  _entire_ normalized contract, `name`/`workflowVersion`/`description`/`tags`
  included, so it changes on a documentation edit even when `contractHash`
  does not. `buildWorkflowRevisionManifest()` derives `revision` by default;
  pass `{ revision: 'my-opaque-id' }` to supply one explicitly instead (an
  empty or oversized supplied revision is rejected).

```ts
import { buildWorkflowContract, buildWorkflowRevisionManifest } from '@lostgradient/weft';

const contract = buildWorkflowContract({ name: 'checkout', version: '2.1.0' });
const manifest = await buildWorkflowRevisionManifest(contract);

console.log(manifest.contractHash); // sha256:… — payload-only
console.log(manifest.revision); // sha256:… — full identity, derived by default
```

`parseWorkflowRevisionManifest()` validates an untrusted `WorkflowRevisionManifest`
from `unknown` — persisted storage, a wire payload, an operator-supplied
fixture. It always recomputes `contractHash` from the (normalized) contract and
rejects with `'contract-hash-mismatch'` on any disagreement with the supplied
value; `revision` is validated (bounded, non-empty) but never recomputed — it
is an opaque label the parser trusts once it is well-formed, not a value it
can independently verify. See the [`WorkflowContract` and
`WorkflowRevisionManifest` reference](../reference/types.md#workflowcontract)
for the full type shapes.

### Discovering revisions at runtime

`GET /v1/registry` (`weft.system.registry` — see
[`api-server.md`](../reference/api-server.md#registry-snapshot)) is how a
caller discovers, over the wire, which content-addressed revision is
currently active for a workflow name: `activeRevisions[name]` names the
`revision`, and the matching entry in `workflows` carries that manifest's
full `contract`, `contractHash`, and `revision`. This is the same
`WorkflowRevisionManifest` this guide describes — the registry snapshot is
just its runtime-introspection surface, built fresh from the engine's
current registrations on every request rather than persisted.

### Discovering revisions at compile time

`weft codegen` (see [the CLI reference](../reference/cli.md#codegen)) reads
that same registry snapshot and surfaces each active workflow's `revision`
and `workflowVersion` as string-literal types on its generated
`WorkflowRegistry` entry, alongside the usual `input`/`output` fields:

```typescript partial
declare module '@lostgradient/weft' {
  interface WorkflowRegistry {
    checkout: {
      input: CheckoutInput;
      output: CheckoutOutput;
      revision: 'sha256:459490e3…';
      workflowVersion: '2.1.0';
    };
  }
}
```

Neither field is required to call `engine.start`, `WeftClient.start`/
`.schedule()`, or read `.result()` — an ordinary start needs no
caller-supplied revision, since those call sites only ever read `input`/
`output`. The literal types exist so a consumer's own tooling can assert an
expected pinned revision at compile time, the same way the runtime
discovery above lets it assert one at request time. When two or more
workflows in the same snapshot share an identical, non-trivial input or
output schema, the emitted `.d.ts` hoists that schema into one shared `type`
alias rather than repeating it inline at every entry.

## Activation Compatibility

`checkWorkflowCompatibility(current, candidate, policy?)` is the structured
comparison behind automatic activation: given two `WorkflowRevisionManifest`
values, it answers whether `candidate` may replace `current` as a
`WorkflowCompatibilityVerdict`—`{ compatible: true }`, or `{ compatible:
false, reasons }` naming every applicable
[`WorkflowCompatibilityReason`](../reference/types.md#workflowcompatibilityreason-and-workflowcompatibilityverdict),
never just the first one found. A catalog or refresh orchestrator may report
every reason this function returns; it may never treat an incompatible
verdict as compatible during automatic activation—that is the whole point
of a bounded, machine-readable reason list instead of a thrown error.

The five reasons relate to the two version axes already covered above, but
answer a narrower question than either:

- **`workflow-version-incompatible`** is the _same_ check
  `derivePreparedExecutionState()` already applies during recovery—this
  function calls `checkVersionCompatibility()` from `core/versioning.ts`
  directly, so the verdict's answer for this reason can never drift from
  what recovery enforces.
- **`artifact-revision-mismatch`** is new: it compares the broader
  `revision` identity, not `workflowVersion`. A `workflowVersion` bump is an
  author's explicit signal that replay compatibility changed; a `revision`
  change can happen from something as small as an edited description, with
  `workflowVersion` untouched.
- **`contract-hash-mismatch`**, **`name-mismatch`**, and
  **`manifest-version-unsupported`** have no existing recovery-side
  counterpart—`derivePreparedExecutionState()` has never had two full
  manifests to compare, only a bare stored `workflowVersion` string. These
  three reasons are the part of activation compatibility that manifests
  make possible for the first time.

Only one axis is policy-tunable. `requireExactRevision` (default `true`,
see `DEFAULT_WORKFLOW_COMPATIBILITY_POLICY`, frozen) controls whether a
`revision`-only difference—same `name`, same `workflowVersion`, same
`contractHash`, only `revision` differing—still blocks activation. What that
`revision`-only difference _means_ depends on how `revision` was produced:
under the default content-derived revision it is always
`contract.description`/`contract.tags` differing, but under a caller-supplied
revision (`buildWorkflowRevisionManifest(contract, { revision })`) it can be
any artifact-identity change the caller encoded there—this module has no way
to tell an opaque supplied revision from a derived one by inspecting the
manifest alone, so do not set `requireExactRevision: false` for manifests
using explicit revisions unless you intend to tolerate any `revision` change.
Setting `requireExactRevision: false` never suppresses `contract-hash-mismatch`,
since the two reasons are independent checks: under the default content-derived
revision a payload difference always implies a `revision` difference too, but
under a caller-supplied revision two manifests can share the same `revision`
string despite different `contractHash` values, so the independent hash check
is what still blocks activation there. The other four reasons can never be
loosened by policy at all—that is the concrete mechanism behind "the refresh
system may report these reasons but may not override them during automatic
activation."

```ts
import {
  buildWorkflowContract,
  buildWorkflowRevisionManifest,
  checkWorkflowCompatibility,
} from '@lostgradient/weft';

const current = await buildWorkflowRevisionManifest(
  buildWorkflowContract({ name: 'checkout', version: '1.0.0' }),
);
const candidate = await buildWorkflowRevisionManifest(
  buildWorkflowContract({ name: 'checkout', version: '2.0.0' }),
);

const verdict = checkWorkflowCompatibility(current, candidate);
console.log(verdict.compatible); // false
```

`checkWorkflowCompatibility()` is pure and synchronous—both manifests
already carry their computed `contractHash`/`revision`, so no hashing
happens inside it—and symmetric: `checkWorkflowCompatibility(a, b,
policy)` and `checkWorkflowCompatibility(b, a, policy)` always agree. The
internal workflow catalog (below) wires this in on its guarded activation
primitive; `engine.register()`'s own activation path is deliberately
unconditional and never calls it, so a re-registered workflow whose version
drifted still boots—only that one run fails at recovery time, not
registration.

## Revisions and the Catalog

Three identity concepts sit at different layers, and it is easy to conflate
them:

- **`workflowVersion`** is the existing semantic replay-compatibility
  boundary described above—an author-declared string, checked by
  `checkVersionCompatibility()` at recovery time against a workflow's own
  prior runs.
- **`revision`** (WFT-5) is a contract-metadata identity: content-derived by
  default, or explicitly supplied. It changes on a documentation-only edit
  even when the payload contract (`contractHash`) does not.
- **`generation`** is new: a per-name activation counter maintained by the
  internal workflow catalog. It has nothing to do with replay compatibility
  or contract identity—it counts how many times a name's active pointer has
  been written, and exists purely as the catalog's compare-and-swap fencing
  token (the literal "which revision did I last observe" a caller supplies
  back as `expectedGeneration`).

Every `engine.register(definition)` call durably installs the workflow's
current `WorkflowRevisionManifest` into the catalog and activates it,
keyed by `(name, revision)`—immutable once installed, so two revisions of
the same workflow name coexist without one overwriting the other. The
catalog's per-name active pointer (`{ revision, generation }`) is what
`RegistrySnapshot.activeRevisions` reads from, restored from durable
storage before recovery or any new start on every boot.

`engine.register()` itself stays synchronous—building a manifest requires
hashing (`crypto.subtle`), which is async—so the actual durable
install/activation is deferred to the next `await` boundary inside the
engine (`start()`, `Engine.create()`, `recoverAll()`, and similar entry
points). Two consequences follow: a `RegistryManifestLimitError` from an
oversized contract (a WFT-5 hostile-input limit) can now surface at one of
those await points rather than only when a registry snapshot or codegen run
is later requested—see [`register()`](../reference/api-engine.md) for the
full list of affected call sites—and `engine.register()`'s own activation is
always unconditional, never gated by `checkWorkflowCompatibility()`, exactly
matching the version-mismatch behavior described above. The compatibility
check is real and exercised, but on the catalog's separate guarded
activation primitive—`engine.workflows.activate()` (below), the public
caller this primitive was built for.

Activating a new revision never alters an already-started run: a workflow
instance's own recorded `workflowVersion` and checkpoint state are
unaffected by a later `engine.register()`/activation call for the same
name—only new starts and recovery resolve against the catalog's current
active pointer.

### Per-run revision pinning (WFT-17)

Every workflow run also carries its own `revision` field on
`WorkflowState`, sibling to `versionTuple`, set once at start admission and
never rewritten: the exact executable artifact this run started against—an
eager registration's `internals.registeredCatalogRevisions` entry (the
revision of the code actually loaded in _this_ process), or a dynamic
source's resolved candidate revision. `engine.get(id)` and `engine.list()`
both expose it (`WorkflowState.revision` / `WorkflowSummary.revision`),
distinct from `versionTuple.workflowVersion`—two different revisions can
share one `workflowVersion` (a documentation-only redeploy, for example),
and `weft version:check`'s report breaks running workflows out by both.

`revision` is identity and diagnostics only—it answers "which artifact,"
never "may this resume." `versionTuple` remains the sole semantic
compatibility axis recovery checks (`checkVersionCompatibility()`, above);
nothing in this section changes that.

The critical distinction from the catalog's active pointer above:
`state.revision` is fixed at start time and is deliberately **not** the
same value as `catalog.resolveActive(type)`, which can move later.
Concretely: if engine A registers `checkout` and later activates a
documentation-only revision it never itself loaded (`engine.workflows.activate()`
with `policy: { requireExactRevision: false }`), the catalog's active
pointer now names code this process cannot run—but a fresh start on that
same engine still persists `state.revision` from
`registeredCatalogRevisions` (this process's own loaded code), never from
the active pointer. This is what makes an already-pinned run's recovery
correct even after activation moves on—see
[Recovery and deploys](recovery-and-deploys.md) for the full recovery-time
grouping and classification this pin drives.

### Activity, finalizer, constraint, and retention routing follow the pin too (WFT-19)

WFT-17/18 pinned `WorkflowState.revision` for start and recovery, but left a
boundary open, named explicitly in that release's own notes: everything
downstream of a running instance—activity dispatch, finalizer resolution,
constraint evaluation, retention-deadline computation, and
search-attribute-schema validation—still resolved a dynamic-source type by
`type` alone, via whichever revision this process most recently resolved.
For a single revision per type that distinction never mattered; for two or
more revisions of the same `registerSource()`-registered type live in one
process at once (two concurrent runs pinned to different revisions, or a
redeploy with an old run still in flight), it meant a running instance
could silently execute against a **sibling run's** revision instead of its
own.

That boundary is closed as of this release. Every one of those resolvers
now reads the running instance's own exact pin from a per-instance identity
cache (`workflowId → { type, revision }`), populated the moment a workflow
begins executing—fresh start, delayed-start fire, resume, recovery, or an
`ownership: 'workflow-lease'` reclaim redrive—and consulted instead of a
type-only, last-resolved-wins lookup:

- **Activity dispatch** (`ctx.run('name')`) resolves a dynamic-source
  workflow's per-workflow `.activities({...})` registry via the instance's
  own `(type, revision)`, never a sibling run's more-recently-loaded
  revision.
- **Finalizer resolution** (the `wf-teardown:` drive) resolves the
  `finalizer` declared on the exact revision a `cancelled`/`timed-out` run
  was pinned to.
- **Constraint evaluation** checks the pinned revision's own `constraints`
  array at every checkpoint commit.
- **Retention-deadline computation** (`getWorkflowRetentionDeadline()`)
  applies the pinned revision's own `retention` policy, not the engine
  default a sibling run's more-recently-resolved revision happened to
  share.
- **Search-attribute-schema validation** (`setAttributes()`) validates
  against the pinned revision's own declared schema.

`getWorkflowActivityDefinition()`/`listWorkflowActivityDefinitions()` are
the one deliberate narrowing this closes rather than widens: their
per-workflow lookup is now eager-only for any `registerSource()`-registered
type, resolved or not, instead of possibly reflecting a stale or mismatched
revision's data—these two accessors have no running instance to pin
against, so eager-only is the only answer that cannot silently be wrong.
The two are not quite symmetric, though: `getWorkflowActivityDefinition()`
still falls back to the same-named **global** activity registry when the
per-workflow lookup misses, so a dynamic-source workflow requesting an
activity that is also registered globally still gets that metadata back,
never `undefined`, for that case. `listWorkflowActivityDefinitions()` has
no such fallback—it enumerates only the eager per-workflow registry's own
names.

This also closes a related, independently-reproducible latent gap: a
resumed or recovered workflow's per-instance identity cache was never
populated on ANY resume/recovery path before this release, so a builder
workflow's string-named `ctx.run('name')` activity call could fail to
resolve at all on its first turn after a fresh-process recovery, even for
an eagerly-registered type. `engine.fork()`'s checkpoint-launched run had
the same identity-cache gap—and, separately and more severely, resolved
its HANDLER against the catalog's currently active pointer rather than the
source run's own pinned revision, so a fork taken after the active pointer
moved could launch against a different revision's code entirely, not just
mis-route a downstream lookup. Both are fixed the same way every other
launch path already was: the identity is set, and the handler resolved
against the source's own `revision`, before the fork can drive its first
turn. See the `Fixed` entries in the changelog.

### Forking against a different revision (WFT-21)

By default, `engine.fork()` takes no `revision` opinion at all: it resolves
and persists the SOURCE run's own pinned revision, exactly as described
above, so a fork's differences from its source come only from `fromStep`,
input, or history choices—never a silently different revision of the code.

`ForkOptions.revision?: string` is an explicit, validated opt-in to fork
against a DIFFERENT installed revision instead—a genuine diagnostic need
("does this input fail on v1 or only on v2?"). It is validated against what
THIS process can actually run, before any checkpoint is ever read:

- For an **eager-registered** workflow type, `revision` must exactly equal
  the revision this process loaded. An eager type has no other revision
  available to fork against, so this is the one call site in the codebase
  where an eager type does NOT get to ignore a pin (the same exception
  `pinned-schedule-revision.ts`'s fire-time launch already makes, for the
  same reason: an explicit commitment must not silently degrade).
- For a **dynamic-source** type, `revision` must name one of this process's
  currently registered, resolvable candidates.

Either mismatch throws `WorkflowRevisionUnavailableError` with
`reason: 'not-registered'`, before any storage read for the checkpoint—so a
request for a revision this process cannot run leaves no partial write. A
`revision` whose registered `version` is semver-incompatible with the source
checkpoint still throws `VersionMismatchError`, via the same
`derivePreparedExecutionState()` compatibility gate every other fork
already goes through: forking against a different revision never bypasses
ordinary version compatibility checking.

The `weft.workflows.fork` operation accepts a matching optional `revision`
input field (REST body field, JSON-RPC param); an unresolvable request
surfaces as a `Conflict` (409) fault carrying `data.reason` over JSON-RPC
(REST discloses the reason in the error message text rather than
structured `data`, per the existing WFT-11 REST/JSON-RPC fidelity split).

The fork's own commit is fenced against a concurrent
`removeWorkflowRevision()` targeting the fork's persisted revision through
two layers, mirroring `start()`'s own defense exactly. Under `ownership:
'lease'` or `'workflow-lease'`, the commit fences on the target revision's
durable catalog entry—the same `buildCatalogEntryRevisionCondition` fence a
fresh `start()` carries—so a concurrent removal that lands first makes the
fork's own commit lose its CAS. Regardless of ownership mode, `fork()` also
reserves an in-memory `inFlightStartsByRevision` slot for its target
revision as soon as validation resolves it, released unconditionally once
the commit settles (mirroring `start()`'s own `reserveInFlightStart`/
`releaseInFlightStart` pairing)—this closes the same-process race two
overlapping async calls on one engine instance can still hit even under the
default `ownership: 'none'`, where the durable catalog-entry fence is
deliberately skipped (no `conditionalBatch` capability requirement for the
common single-writer-by-contract case). Without either layer, an
explicit-revision fork onto a revision other than the source run's own pin
would perform only a process-local availability check with no reservation
of any kind, so a concurrent removal could see zero references, delete the
catalog entry, and still let the fork's own commit land right behind
it—durably persisting a reference to a revision the catalog now claims is
gone.

**A lost commit-time catalog fence now surfaces as `Conflict`, not a masked
500** (Codex review round 4). When the fence above genuinely loses its
race, `resolveForkAccess()` now recognizes the resulting error as the same
typed `WorkflowRevisionUnavailableError` the pre-commit check already
throws for the identical class of loss—previously it fell through to a
generic `EngineFailure`, so `weft.workflows.fork` returned a 500 instead of
the documented 409 a client should retry against.

**The SOURCE run itself is also guarded against a concurrent replacement**
(Codex review, item 6). Everything above fences the fork's TARGET revision;
this is a different mechanism protecting the fork's SOURCE. `fork()` reads
`sourceState` once, at its own top, then performs a possibly-async
registration resolve before loading and hydrating the source checkpoint it
forks from, and further async work (header lookup, lineage construction,
search attribute derivation, the catalog-entry condition build) before its
own commit. A concurrent `start(..., { id: sourceWorkflowId,
onTerminalConflict: 'start-new' })` replacement landing in either window—if
version-compatible with the original—could let `derivePreparedExecutionState()`
accept a checkpoint already reflecting the replacement while the fork still
carried `sourceState`'s own STALE type/input, producing and executing a
mixed-generation fork. `fork()` now correlates `sourceState.workflowExecutionToken`
against the loaded checkpoint's own token immediately after hydration, and
revalidates it again by re-reading `WorkflowState` immediately before the
commit—either mismatch throws `ForkSourceReplacedError` (mapped to a
`Conflict` fault over REST/JSON-RPC) rather than risking a mixed-generation
commit. Both checks tolerate either side lacking the token (a pre-upgrade
record), the same bounded precedent `resolveReplayRevision()` uses for
`replayTo()`. The caller re-issues `fork()`, which reads the replacement's
own current state fresh.

**A third, narrower reservation closes one remaining legacy-source gap**
(Codex review round 3). The in-memory reservation above reserves against
`targetRevision` (`options.revision ?? sourceState.revision`)—a no-op when
BOTH are `undefined`, which happens only for a default fork of a legacy
(pre-revision-pinning) source run on a dynamic-source type with exactly one
registered candidate. The resolver still resolves—and the fork still
persists against—that sole candidate's real revision even though nothing
was reserved for it. `fork()` now reserves a SECOND, conditional in-memory
slot for the resolver's own resolved revision whenever it differs from
`targetRevision`—exactly this legacy case—closing the gap under every
ownership mode, released unconditionally alongside the first reservation.

That second reservation now fires from INSIDE the resolver, not after it
returns (Codex review round 5): reserving only once the whole resolve
completed left the resolver's own loader await—when the sole candidate
wasn't already locally cached—as a window where a concurrent
`removeWorkflowRevision()` could delete and finalize it before the
reservation ever ran. `resolveExecutableRegistrationForRevision()` accepts
the same synchronous, before-any-await `onRevisionChosen` hook `start()`'s
own resolver already used for the identical class of race, and `fork()`
now reserves from inside it the instant the resolver picks the candidate's
revision, closing the window entirely.

**Known residual, documented rather than fixed (Codex review round 6).**
That reservation is `inFlightStartsByRevision`—process-local, in-memory—so
under a supported multi-engine `ownership: 'workflow-lease'` deployment it
protects only a race against another caller on the SAME process. A sibling
engine (a separate process sharing durable storage) can still remove the
sole candidate after the hook fires but before the awaited source loader
finishes reading it—that sibling's own `removeWorkflowRevision()` sees
only durable references, never this process's local map, and the loader's
own `catalog.install()` then reinstalls the revision regardless of that
sibling's removal. The fork's own FINAL commit is still fenced durably
under lease ownership (`buildForkCatalogEntryCondition()`, above)—this gap
is narrower, in the intermediate load/install step before that commit.
Closing it needs a durable, cross-process reservation or a
tombstone-aware `catalog.install()`, not a bounded review-response fix—see
`reserveLegacyForkTargetRevision()`'s own doc comment for the full
explanation.

**Scope corrected one round later (Codex review round 9): this gap is not
limited to legacy forks.** An explicit-revision fork
(`ForkOptions.revision`) reserves just as early and just as
process-locally as the legacy path, then awaits the identical load/install
pipeline for its own resolved revision—a sibling engine's concurrent
removal wins the same race against an explicit target exactly as it can
against a legacy one. Every dynamic-source fork under `workflow-lease`
whose target requires a resolver load is exposed, not only a legacy one;
the root cause and candidate fixes are unchanged.

**A second, narrower residual, also documented rather than fixed (Codex
review round 8)—this one live even under the single-process `'none'` mode
`buildForkCatalogEntryCondition()` deliberately leaves unfenced.**
`removeWorkflowRevision()`'s post-delete half does re-count references once
after the catalog delete commits, but that one snapshot can read zero and
then a fork's reservation, resolution, and reinstall can all land in the
window between that snapshot and the tombstone's own finalization—a window
nothing re-checks. Neither commit in that window conditions on the other's
key, so they race cleanly past each other, and `removeWorkflowRevision()`
can report `{ removed: true }` while a live, referenced run now exists
against that revision. Unlike round 6 above (a sibling process racing the
fork's own intermediate load step under `workflow-lease`), this is
`removeWorkflowRevision()`'s own finalization step racing a fork on the
SAME process, reachable even under `'none'`. Closing it needs either
serializing removal against reservations through finalization or fencing
the fork's commit under `'none'` too—both real design decisions, not a
bounded fix—see `buildForkCatalogEntryCondition()`'s own doc comment for
the full explanation.

**Both residuals above are now fixed (Codex review, items 1-3).** The
shared root cause: `WorkflowCatalog.install()`'s durable write was
CAS-guarded only on the entry key being absent, never on its tombstone, so
a load/reinstall racing a concurrent removal could win the CAS and
resurrect an entry between its delete and its tombstone's resolution,
regardless of ownership mode or which process performed the load.
`writeCatalogEntry()` now also conditions on the entry's tombstone key
being absent, in the same `conditionalBatch`; a CAS loss caused
specifically by a present tombstone throws a new internal
`WorkflowRevisionTombstonedError` rather than the pre-existing
`WorkflowCatalogConflictError`. Since `core/catalog/**` cannot throw the
engine-layer `WorkflowRevisionUnavailableError` directly (the directional
import boundary `check-import-cycles.ts` enforces), `catalog.install()`'s
single call site—`core/engine/source-resolution.ts`'s
`runSharedSourceLoad()`, reached by every dynamic-source load, shared by
both the legacy fork resolver hook and the explicit-revision fork
load—catches it and translates it to `WorkflowRevisionUnavailableError(name,
revision, 'not-installed')`. Separately, `buildForkCatalogEntryCondition()`'s
`'none'`-mode branch is no longer a no-op: it now fences the fork's own
final commit on the target revision's catalog-entry bytes under every
ownership mode, since `writeCatalogEntry()` already unconditionally
requires the `conditionalBatch` storage capability regardless of ownership
mode—fencing under `'none'` adds no new capability requirement. Together
these close "removal is rejected while any durable or live reference
exists" for every ownership mode and load path named above.

**A narrower residual left by the tombstone-presence fence above is also
now closed (Codex review round 14, item Q7jH).** The tombstone-presence CAS
above protects a load racing a removal only up to that removal's own
tombstone finalizing—a load that begins before its target revision has
ever been installed anywhere, or after a full removal has already
completed, has no local cache to adopt, so `catalog.install()` genuinely
reaches its write path, and if a full remove-and-finalize cycle for the
same `(name, revision)` lands while that load is still in flight, the
entry and tombstone keys both read absent again by the time the write
runs—indistinguishable from "never installed." A new, permanently-retained
`catalog-removal-generation:<name>:<revision>` counter closes this:
`removeCatalogEntry()` bumps it atomically alongside the delete and
tombstone write, and `runSharedSourceLoad()` captures its bytes before
invoking the host loader, threading them through to `catalog.install()` as
an additional CAS condition. A removal that lands during the load—even one
whose own tombstone has already resolved—now fails the fenced install
closed instead of resurrecting the just-removed revision. `install()`'s
cache-hit path and `activateCandidate()`'s active-pointer CAS were fixed
the same round to close a related gap: a stale in-process cache hit could
return—or activate—a revision a peer had already durably removed; both now
revalidate against (or fence on) durable storage before proceeding.

The ADR 0002 workflow-lease reclaim-eligibility check
(`isWorkflowTypeRegistered`) is source- and revision-aware for the same
reason—see
[0002-multiengine-per-workflow-ownership.md](../contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md).

## Schedule revision policy (WFT-20)

A recurring schedule's future occurrences can resolve the workflow's
revision two ways, chosen via `ScheduleOptions.revisionPolicy` /
`ScheduleUpdateOptions.revisionPolicy`:

- **`'active-at-fire'`** (the default, and the pre-WFT-20 behavior,
  byte-for-byte unchanged): each occurrence resolves whichever revision is
  active—or, for an eagerly-registered type, whatever this process has
  currently loaded—at the moment it actually fires. A redeploy between
  ticks changes what the next tick runs.
- **`'pinned'`**: `engine.schedule(...)`/`schedule.update(...)` captures the
  revision that WOULD run right now (reusing the same resolver a fresh
  `engine.start()` call would use) and stores it as
  `ScheduleMetadata.pinnedRevision`. Every future occurrence resolves that
  exact revision, never whatever happens to be active at fire time, and the
  fired workflow's own persisted `WorkflowState.revision` equals the pin.

```ts
import { Engine, workflow, type WorkflowContext } from '@lostgradient/weft';

const engine = new Engine();
engine.register(
  workflow({ name: 'nightly-close' }).execute(async function* (_ctx: WorkflowContext) {
    return 'closed';
  }),
);

const handle = await engine.schedule('nightly-close', null, '0 2 * * *', {
  revisionPolicy: 'pinned',
});
const pinned = await handle.describe();
console.log(pinned.revisionPolicy, pinned.pinnedRevision); // 'pinned', 'sha256:…'
```

**Eager types get a real, checkable commitment.** A pin is not a hint for
an eagerly-registered type—capturing one requires this process's own
`registeredCatalogRevisions` entry, and every future fire re-checks that
the process's currently-loaded revision matches the pin EXACTLY. This is
the one place in the codebase where an eager type does **not** silently
ignore a stale pin the way recovery does (see
[Per-run revision pinning](#per-run-revision-pinning-wft-17) above,
"eager is always ready regardless of pin")—recovery's fallback is correct
because a process only ever runs the code it has loaded, but a schedule's
pin is a forward-looking promise about a specific artifact, and silently
degrading it to active-at-fire behavior would make that promise (and the
`pinnedSchedules` reference count backing it—see
[Reference Accounting and Removal](#reference-accounting-and-removal)
above) a lie.

**Unavailable pin pauses the schedule.** If a pinned revision later becomes
unavailable—removed via `removeWorkflowRevision()`, or an eager type
redeployed to a different revision—the next fire throws
`WorkflowRevisionUnavailableError` and the schedule transitions to
`'paused'` through the same `pauseScheduleAfterTimerFailure` path any other
fire-time failure already uses (a `WorkflowNotRegisteredError` for a
renamed workflow type, for example). This is a structural condition, not a
transient one skipped occurrence-by-occurrence: an operator sees the
schedule stop and pause, rather than the schedule silently reporting
`'active'` while never actually firing again.

**Updating the policy.** `ScheduleUpdateOptions.revisionPolicy` follows the
same "omitted fields retain their persisted value" rule every other update
option does, with one nuance: passing `revisionPolicy: 'pinned'` ALWAYS
re-resolves and re-captures the pin against whatever is active right
now—even when the schedule is already pinned—giving an operator an
explicit re-pin lever rather than a no-op. Passing
`revisionPolicy: 'active-at-fire'` clears any previously captured pin.

**Persisted shape.** `ScheduleMetadata` gains a required `revisionPolicy`
field and an optional `pinnedRevision` (present only when
`revisionPolicy === 'pinned'`). A schedule record persisted before WFT-20
has no `revisionPolicy` field at all; it decodes as `'active-at-fire'`, the
same "absent means legacy, not corrupt" treatment
[`WorkflowState.revision`](#per-run-revision-pinning-wft-17) got—this is
additive and does **not** bump `CURRENT_PERSISTED_DATA_SCHEMA_VERSION`.

## `engine.workflows`: public catalog control

`engine.workflows` promotes the catalog above to a public surface—`install`,
`activate`, `getActive`, `getRevision`, and `listRevisions`—plus five
matching server operations under `/v1/registry/`. This is catalog
bookkeeping and promotion control ONLY for an eagerly-registered workflow:
for a name only `engine.register()`-ed, activation never changes which
in-process handler `engine.start()` dispatches to—that always resolves
through whatever `engine.register()` most recently registered.
`RegistrySnapshot.activeRevisions` (what `weft.system.registry`, the
console's registry page, and `weft codegen` read) still just moves the
durable pointer, not execution, for that eager case. Connecting activation
to execution is dynamic module loading—see
[Dynamic Workflow Sources](#dynamic-workflow-sources) below for
`workflowSource()`/`registerSource()`/`resolveWorkflowSource()` and how
`engine.start()`/recovery await resolution for a `registerSource()`-registered
name (WFT-15/16).

```ts
import {
  Engine,
  buildWorkflowContract,
  buildWorkflowRevisionManifest,
  workflow,
  type WorkflowContext,
} from '@lostgradient/weft';

const checkout = workflow({ name: 'checkout', version: '1.0.0' }).execute(async function* (
  _ctx: WorkflowContext,
  input: string,
) {
  return input;
});

const engine = new Engine();
engine.register(checkout); // already in-process

const contract = buildWorkflowContract({ name: 'checkout', version: '1.0.0' });
const manifest = await buildWorkflowRevisionManifest(contract);

const record = await engine.workflows.install(manifest);
const active = await engine.workflows.getActive('checkout');
const result = await engine.workflows.activate('checkout', record.manifest.revision, {
  expectedGeneration: active!.generation,
});
```

`install(manifest)` requires `engine.getWorkflowDefinition(manifest.name)` to
already resolve in-process—it durably records a manifest for a definition
the engine already has, it does not load code (that is a later batch's
job). It deliberately does not check `manifest.workflowVersion` against the
in-process definition's own version: a version mismatch is a normal
activation-time `incompatible` refusal, not an install-time error.

`activate(name, revision, options)` requires `options.expectedGeneration`
once `name` has an active pointer—an omitted value there refuses with
`{ applied: false, reason: 'expected-generation-required' }` rather than
silently activating, which is exactly what stops two concurrent refreshers
from last-write-winning each other. Omit it (or pass `0`) only for the very
first activation of a name, which has no prior generation to name. Every
other refusal reason (`stale-generation`, `incompatible`, `conflict`) is
returned in the same structured result rather than thrown.

Under the **default** compatibility policy (`requireExactRevision: true`),
`activate()` can only re-stamp the revision that is already active—the
candidate's `revision` must match exactly, so a successful call bumps the
generation without changing what is active. Promoting a documentation-only
variant (same `contractHash`, different `revision`) requires
`policy: { requireExactRevision: false }`. Promoting a revision whose
contract genuinely differs is impossible through `activate()` by design—
`contract-hash-mismatch` and `workflow-version-incompatible` are never
tunable by policy (see [Activation Compatibility](#activation-compatibility)
above); that is `engine.register()`'s job.

**Sharp edge:** a later `engine.register()` call for the same name—including
a process restart that re-registers against the same durable store—reverts
a prior manual `activate()` back to the in-process registration's own
revision. `activateRegistered` is unconditional by design (see the
Activation Compatibility section above); it does not know about, and does
not preserve, a manual `activate()` call. Reconciling loader-driven and
registration-driven activation is covered by
[Dynamic Workflow Sources](#dynamic-workflow-sources) below—`registerSource()`
and `engine.register()` refuse to coexist under the same name, which is the
mechanism that prevents this exact sharp edge from applying to a
loader-driven registration.

The five server operations mirror the namespace 1:1 (`reference/api-server.md`
has the full table): `weft.workflows.revisions.install`,
`.activate`, `.get`, `.list`, and `weft.workflows.active.get` (named
`active.get` rather than `revisions.getActive`—operation names must be
lowercase-segmented, so `getActive` is only the TypeScript method name).
`install` and `activate` require the `workflows:admin` scope; the three
read operations require `workflows:read`.

## Reference Accounting and Removal

A revision cannot simply be deleted once installed—something might still be
relying on it. `WorkflowRevisionReferenceCounts` is the bounded accounting
interface a removal decision is gated on: seven fields, always present, so
a caller never special-cases an "unknown" reference kind.

Five fields are wired to real signals now:

- **`registeredDefinitions`**: `1` when this process's own
  `engine.register()`-drain path most recently activated exactly this
  revision for this name, `0` otherwise. Distinct from "is this revision
  active"—a process can register a workflow, then activate a different
  revision through the guarded primitive (`activateCandidate`), leaving its
  own registration still naming the first revision even though the active
  pointer moved elsewhere.
- **`inFlightStarts`**: the count of this process's own in-flight
  `startWorkflow` calls reserved against this revision, incremented and
  decremented inside `lifecycle/start.ts`'s single `startWorkflow` choke
  point itself, alongside the `pendingStarts` reservation it already holds.
  Every caller that funnels through that one function is already
  counted—not just `engine.start()`/`engine.startOrSignal()`'s create path,
  but `ctx.startChild()` too, since it calls the very same `startWorkflow`
  internally. There is no separate bulk `startBatch()` entry point to
  feed—`buildStartBatchOperations` is internal plumbing already inside this
  same `startWorkflow` call, building one start's own storage-write batch,
  not a distinct multi-start API.
- **`nonTerminalRuns`** (WFT-17): the count of non-terminal
  (`running`/`pending`/`suspended`) workflow runs whose persisted
  `WorkflowState.revision`—see [Per-run revision pinning](#per-run-revision-pinning-wft-17)
  above—pins exactly this revision. A bounded `storage.scan('wf:')`, not an
  in-process signal, so it is correct across every engine sharing the
  durable store, not just this process. This closes a real gap: before
  WFT-17, `removeWorkflowRevision()` could remove a revision a parked run
  still needed, because nothing counted non-terminal runs against it at
  all. A legacy run with no persisted `revision` never counts against any
  specific revision here.
- **`pinnedSchedules`** (WFT-20): the count of non-cancelled schedules with
  `revisionPolicy: 'pinned'` whose captured `pinnedRevision` names exactly
  this revision—see
  [Schedule revision policy](#schedule-revision-policy-wft-20) below. A
  bounded `storage.scan('schedule:')`, the same shape `nonTerminalRuns`
  uses. An `'active-at-fire'` schedule never counts, regardless of
  `workflowType`—it resolves whatever is active at each future fire, so it
  holds no standing reference to any one revision. A `'cancelled'` pinned
  schedule is excluded too (it will never fire again); a `'paused'` one
  still counts (it can be resumed).
- **`retainedRecoveryRecords`** (WFT-21): the sum of two durable-reference
  components, both pinned to exactly this revision. First, a terminal
  (`completed`/`failed`/`cancelled`/`timed-out`) `WorkflowState` still
  present in storage—not yet purged. A completed run is forkable against
  the exact revision it ran, and a failed run is retryable against it, so
  both durably pin the revision until purge or a retention sweep releases
  them; that release rides the SAME fenced `wf:` delete purge already
  performs, so no new write path was needed. Second, a
  `TeardownDeadLetterRecord`—a workflow whose finalizer permanently
  failed—pinned to this revision. Unlike the first component, a dead letter
  is **never** auto-released: it is deliberately excluded from the purge
  delete-set as permanent leak evidence, so a revision that ever
  dead-lettered stays non-removable indefinitely, with no acknowledge/clear
  API yet to reclaim it. Both components are bounded storage scans—the
  terminal-run component rides the exact same `storage.scan('wf:')` pass
  `nonTerminalRuns` already pays for (one scan classifies each record into
  exactly one of the two buckets); the dead-letter component is its own
  bounded `storage.scan('wf-teardown-deadletter-history:')`.

  The dead-letter component scans a dedicated **per-generation** history
  namespace, not the single-slot `wf-teardown-deadletter:<workflowId>` key
  the finalizer-status API reads (Codex review round 3, P2). That single
  slot is keyed by workflow id alone, so a workflow id reused across
  generations—purge, or `onTerminalConflict: 'start-new'`—would have a
  LATER generation's dead letter silently overwrite an EARLIER generation's
  at that slot, destroying both the audit record and the reference count
  for whatever revision the earlier generation had leaked. Every
  dead-lettering finalizer now ALSO writes the identical record to
  `wf-teardown-deadletter-history:<workflowId>:<workflowExecutionToken>`—
  keyed additionally by the dead-lettering run's own execution
  token—so every generation's record, and its revision reference, survives
  independently. The single-slot key is untouched, so the finalizer-status
  API keeps serving "the latest dead letter for this workflow id" exactly
  as before.

  The reference count ALSO scans the single-slot namespace as a fallback,
  for a dead letter written by a process from before the history namespace
  existed—such a record lives ONLY under the single-slot key, with no
  history sibling at all, and once its `WorkflowState` is purged it is the
  sole surviving evidence the revision was ever referenced. A single-slot
  record whose computed history key (its own `workflowExecutionToken`, or
  the fixed legacy fallback segment when it has none) already exists is
  skipped as already counted by the history scan above; a record with NO
  matching history key is provably pre-upgrade—both keys have been written
  together, in the same batch, on every write since the history namespace
  was added—regardless of whether it happens to carry a
  `workflowExecutionToken` (a field that predates the `revision` field this
  scan matches against). Among these provable orphans, one with a
  `revision` field uses an exact match; one without is pinned
  conservatively—counted toward every queried revision of the matching
  type—since its true revision cannot be determined at all.

The remaining two fields—`pendingDispatches` and `activeExecutionRealms`—
stay structurally present but always `0`. Each awaits revision identity
threaded through a different, later-owned subsystem—the dispatch ledger and
execution realms respectively—neither of which is scheduled yet. Until each
lands, its field exists as forward-compatible plumbing rather than a
promise the engine cannot keep.

Removal itself is a plain, root-exported async function—not an
`engine.workflows.*` method, and not (yet) a wire operation:

```ts
import { Engine, removeWorkflowRevision, workflow } from '@lostgradient/weft';

const engine = new Engine();
engine.register(
  workflow({ name: 'checkout', version: '1.0.0' }).execute(async function* () {
    return 'ok';
  }),
);
const result = await removeWorkflowRevision(engine, 'checkout', 'some-old-revision');
if (!result.removed) {
  console.log('kept:', result.reason);
}
```

`removeWorkflowRevision` refuses for one of two distinct reasons, checked
in order:

- **`'active'`**: `revision` is currently the active pointer for `name`. A
  structural invariant, independent of any reference count—every future or
  resuming run resolves the active pointer, so an active revision is never
  removable no matter what else references it.
- **`'referenced'`**: `revision` is installed and not active, but the sum
  of every field in `WorkflowRevisionReferenceCounts` is nonzero. The
  refusal carries the full breakdown so a caller can report exactly what is
  still holding the revision.

A `'not-found'` outcome means the `(name, revision)` pair was never
installed (a no-op, not an error), and `'conflict'` means the durable
delete's own compare-and-swap lost to a concurrent writer—the caller may
re-read and retry. On success, the entry is durably deleted (fenced on
both the exact entry bytes read and the exact active-pointer bytes read,
so a concurrent activation that makes the target revision active between
the read and the delete loses the race rather than being silently
overwritten) and `catalog:revision-removed` fires.

**Removal re-checks references AFTER the delete too** (WFT-17, closing a
cross-process TOCTOU): the reference count above is a snapshot, and a
concurrent `engine.start()` on a DIFFERENT process could read the entry as
still installed and commit a new run pinned to it in the narrow window
between this function's own pre-check and its delete landing. Once the
delete lands, `removeWorkflowRevision` re-counts references; if the count
is now nonzero, it restores the entry and returns `'referenced'` instead of
leaving a real run pinned to a revision the catalog no longer carries. This
is safe because it composes with the OTHER half of the fix below: any start
whose own commit lands after the delete necessarily loses its own
compare-and-swap, so a nonzero post-delete count can only be a run that
committed before the delete.

**The delete and its own restore-or-finalize resolution are each atomic**
(WFT-17/18, second-round Codex review on PR #958): a bare delete followed
by a SEPARATE restore/finalize commit left a crash window between the two
where the revision was durably uninstalled with no durable record of what
was deleted, recoverable by no one — not even the process that crashed.
`removeCatalogEntry`'s delete now lands in the SAME `conditionalBatch` as a
`catalog-tombstone:<name>:<revision>` record (the exact deleted bytes), and
`removeWorkflowRevision`'s restore-or-finalize is itself a single atomic
`conditionalBatch` against that tombstone. A process crash between the two
commits now leaves a durable tombstone any process — not just the crashed
one — can resolve from a fresh reference count:
`ensureWorkflowCatalogReady()` sweeps every orphaned tombstone at
catalog-boot time, before recovery's own preflight or any new start can
observe stale catalog state, and `removeWorkflowRevision` itself resolves a
stale tombstone for its own exact `(name, revision)` target before
proceeding (for a long-lived engine that observes a peer crash mid-lifetime,
after its own boot sweep already ran). See
`core/catalog/removal.ts` and `core/engine/catalog-tombstone-recovery.ts`
for the full mechanism.

The boot-time sweep isolates each tombstone's own resolution: a
tombstone whose manifest bytes fail to decode is left untouched (neither
restored nor finalized, since neither can be trusted), and a tombstone
whose fresh reference count cannot be computed—an unrelated undecodable
record elsewhere in the store—is restored rather than finalized, the same
conservative default used for a nonzero reference count. Either case
reports a bounded diagnostic (`CleanupWarningEvent`) and the sweep
continues to the next tombstone, rather than one bad record blocking
`ensureWorkflowCatalogReady()`—and therefore every `start`/`resume`/
`fork`/recovery call—until an operator repairs it. A malformed tombstone
KEY (not a decode failure) still fails the whole sweep closed, since that
can only mean storage corruption or a foreign write into the namespace.

`getWorkflowRevisionDiagnostics(engine, name, revision)` projects the same
accounting into a read-only shape—`installed`, `active`, `activeRevision`,
`references`, and a derived `removable` boolean—without attempting the
removal, useful for an operator checking whether a cleanup would succeed
before running it. It backs the `weft.catalog.diagnostics` operation; see
[api-observability.md](../reference/api-observability.md).

`registeredDefinitions` and `inFlightStarts` remain **in-process only**:
under `ownership: 'workflow-lease'` (ADR 0002), a second engine process
sharing the same durable store has its own, empty view of these two
signals. This is a known, deliberate scope limit for THOSE two fields—full
cross-process visibility into them depends on the same run-level revision
pinning the two remaining always-zero fields are waiting on. It no longer
means a second process can silently remove a revision the first is actively
running against, though: `nonTerminalRuns` is durable and cross-process
already (above), and start admission itself now closes the commit-timing
race under a lease ownership mode—see
[Start admission fences on the resolved catalog entry](#start-admission-fences-on-the-resolved-catalog-entry-wft-17)
below.

### Start admission fences on the resolved catalog entry (WFT-17)

Under `ownership: 'lease'` or `'workflow-lease'`, a fresh `engine.start()`'s
create batch carries an ADDITIONAL compare-and-swap precondition: the
resolved revision's durable catalog entry (`catalog-entry:<name>:<revision>`)
must still equal the bytes this process read. `conditionalBatch`'s
precondition is evaluated against LIVE storage state at commit time, not at
read time—so this needs no coordination with `removeWorkflowRevision()`'s
own CAS beyond both operating on the same key: whichever commit lands first
wins, and the loser's compare-and-swap fails closed. A start whose resolved
revision is concurrently removed by another process before its own commit
lands throws `WorkflowRevisionUnavailableError` with `reason: 'not-installed'`
directly to the caller—never retried inside the engine, and no `wf:` record
is ever created for that attempt. Scoped to lease ownership modes only:
under `ownership: 'none'` the durable store is single-writer by contract
(see [One engine per durable store](recovery-and-deploys.md#one-engine-per-durable-store)
in the recovery guide), so the cross-process race this closes cannot occur
there, and the zero-precondition plain-`batch()` fast path is unchanged.
Both `'lease'` and `'workflow-lease'` already require `conditionalBatch` for
an ordinary start's own epoch or claim fencing, so this adds no new storage
capability requirement for the common path.

### Checkpoint-backed retry admission fences on the pinned revision (WFT-17/18)

A checkpoint-backed `engine.retryFailedAll()` reactivation carries the same
kind of precondition, for a related but distinct reason: a `failed`
workflow is TERMINAL, so `countWorkflowRevisionReferences()`'s reference
scan—what `removeWorkflowRevision()`'s pre- and post-checks both rely
on—never counts it, even while a retry is actively reactivating it back to
`running` against its own pinned revision. Without this fence, a
`removeWorkflowRevision()` racing that reactivation's commit could report
`removed: true` for a revision a run is about to be reactivated against, in
every ownership mode—not just under a lease topology, since a retry's
reactivation carries no `inFlightStartsByRevision` reservation of its own
the way a fresh start's SAME-process protection does. `retryFailedAll()`'s
reactivation batch therefore always carries the `catalog-entry:<name>:<revision>`
precondition whenever the failed run has a pinned `revision`—unconditionally,
not scoped to `ownershipMode !== 'none'`—reusing the exact same
`conditionalBatch` mechanism as start admission above. A retry whose pinned
revision is concurrently removed before its own commit lands throws
`WorkflowRevisionUnavailableError` with `reason: 'not-installed'`, reported
per-workflow in `retryFailedAll()`'s `errors` array; the run is left
`failed`, exactly as it was before the retry attempt, never stranded
`running` with a reactivation that committed against a revision the catalog
no longer carries. A legacy (`revision === undefined`) failed run carries
no exact pin to fence on and is retried unfenced, the same bounded legacy
case documented throughout this guide.

### Catalog Events

Five events fire on the `Engine` alongside catalog activity, all bounded
(primitive fields only, never a full manifest or compatibility verdict):

- **`catalog:revision-installed`** (`WorkflowRevisionInstalledEvent`):
  fires only when a `(name, revision)` is durably installed for the first
  time—never for a byte-identical reinstall, and never for a cross-process
  durable adoption of content another process already installed.
- **`catalog:revision-activated`** (`WorkflowRevisionActivatedEvent`):
  fires whenever the active pointer record for a name actually changes
  (either its revision or its `generation`). `previousRevision` is
  `undefined` on a name's first-ever activation and whenever the revision
  itself did not change (only the generation bumped, as `activateCandidate`
  does even when reactivating the currently active revision); otherwise it
  names the revision this activation displaced.
- **`catalog:activation-rejected`** (`WorkflowRevisionActivationRejectedEvent`):
  fires when the guarded activation primitive refuses a candidate, with a
  bounded `reason` of `'incompatible'`, `'stale-generation'`, or
  `'conflict'`. Only `'incompatible'` carries `incompatibilityReasons`, the
  bounded array of every applicable `WorkflowCompatibilityReason`—never the
  full `WorkflowCompatibilityVerdict`.
- **`catalog:revision-draining`** (`WorkflowRevisionDrainingEvent`): fires
  alongside `catalog:revision-activated` only when a new activation
  actually displaces a different, previously active revision—never on a
  first-ever activation, and never when reactivating the same revision.
- **`catalog:revision-removed`** (`WorkflowRevisionRemovedEvent`): fires
  when `removeWorkflowRevision` durably deletes an entry.

`engine.register()`'s drain path (`activateRegistered`, unconditional) and
the guarded candidate primitive (`activateCandidate`, exercised through
the package-internal `activateCatalogRevisionCandidate` wrapper—`engine.workflows.activate()`'s
production caller, per the [`engine.workflows`](#engineworkflows-public-catalog-control)
section above) both dispatch through the same shared
installed/activated/draining logic, so the two producers can never
disagree about when an event fires. `WorkflowRevisionActivationRejectedEvent`'s
`reason` carries all four `activateCandidate` refusal reasons, including
`'expected-generation-required'`. See
[api-events.md](../reference/api-events.md#catalog-events) for the full
field-level reference.

## Dynamic Workflow Sources

WFT-13/14 adds the primitive + loader slice of dynamic workflow loading:
`workflowSource()`, `engine.registerSource()`, and
`engine.resolveWorkflowSource()`. WFT-15/16 wires it into every execution
entry point—`engine.start()`, `startOrSignal()`, `schedule()`, `fork()`,
`resume()`, recovery, and bulk-retry all await resolution for a
`registerSource()`-registered name before running any handler code, and add
bounded diagnostics plus process-local `workflow-source:*` events for the
load pipeline. See
[Engine Integration](#engine-integration-wft-1516) below for the full
wiring, the candidate-until-resolved invariant, and its recovery
limitation.

### `workflowSource()`: a typed, serializable source descriptor

`workflowSource(descriptor, loader)` pairs plain, serializable
`WorkflowSourceDescriptor` metadata (`kind`, `name`, `location`,
`exportName`, `revision`, and optional pinned `workflowVersion`/
`contractHash`) with a host-side loader capability—`() => Promise<unknown>`.
The descriptor is safe to log, persist, or send over the wire; it can never
execute code. **The loader is never serialized**—it is a plain JavaScript
closure, and pairing it with the descriptor rather than folding it into the
descriptor is the entire reason the two are separate types.

Pass a literal `() => import('./checkout.ts')` as the loader—not a
`pathVariable`-driven dynamic import—and TypeScript infers the returned
handle's input/output/name types from the named export the descriptor
points at, exactly as if you had imported the module directly:

```ts partial
import { workflowSource } from '@lostgradient/weft';

const checkoutSource = workflowSource(
  {
    name: 'checkout',
    location: './workflows/checkout.ts',
    exportName: 'checkout',
    revision: 'sha256:9f2c…',
  },
  () => import('./workflows/checkout.ts'),
);
```

`revision` is not a label you choose freely: it must equal the exact
content-derived revision `buildWorkflowManifestFromDefinition()` computes
from the loaded workflow's contract (`deriveWorkflowRevision()`, a
`sha256:`-prefixed digest of the normalized workflow contract—see
[Revision Identity](#revision-identity) above). A `resolveWorkflowSource()`
call whose loaded module's actual derived revision does not match the
descriptor's `revision` fails with `artifact-revision-mismatch`. In
practice a build/deploy pipeline computes this value offline from the same
source—with `deriveWorkflowRevision()`/`buildWorkflowContract()` against the
identical module, or by reading it off an already-published
`WorkflowRevisionManifest` (the registry snapshot `weft codegen` reads, or a
`GET /v1/registry` response)—and threads it into the descriptor, rather than
a caller inventing one.

A dynamic import path (`() => import(pathVariable)`, typed `Promise<any>`)
is rejected at the `workflowSource()` call site itself—TypeScript cannot
recover named-export types from `any`, so this package refuses to pretend
otherwise. An `exportName` that names a real export but not a
`WorkflowDefinition` compiles (TypeScript cannot know a module's export
shape is wrong without inspecting the module), but the resulting handle's
type parameters collapse to `never`, so misuse surfaces at the point you try
to use the handle rather than silently widening to `unknown`.

### `registerSource()`: records a candidate, never imports

```ts partial
import { Engine, workflowSource } from '@lostgradient/weft';

const engine = new Engine();
engine.registerSource(checkoutSource); // synchronous — never calls the loader
```

`registerSource()` is synchronous and side-effect-free beyond an in-memory
record keyed `(descriptor.name, descriptor.revision)`—it never invokes
`source.load`, never touches storage. A workflow name may not be both
eagerly registered (`engine.register()`) and a dynamic source; the two
throw symmetrically. Re-registering the identical handle reference for the
same `(name, revision)` is idempotent, matching `engine.register()`'s own
same-reference-is-idempotent rule; a different handle under the same key
throws. Multiple different revisions of the same lazy name may coexist
unresolved—the lazy analog of the catalog already supporting multiple
installed revisions per name.

**Inline execution mode only (WFT-15/16):** `registerSource()` throws when
`workflowExecutionMode: 'worker'` is configured. A dynamically-loaded
definition resolves into THIS process's in-memory engine internals, which
only the inline execution strategy reads directly — a Worker realm has no
mechanism to receive that same loaded module or manifest. Use
`workflowExecutionMode: 'inline'` (the default), or register the workflow
eagerly with `engine.register()` instead.

### `resolveWorkflowSource()`: load, validate, install

```ts partial
const record = await engine.resolveWorkflowSource('checkout', 'sha256:9f2c…');
console.log(record.manifest.revision, record.installedAt);
```

`resolveWorkflowSource(name, revision, options?)` loads the module,
validates it from `unknown`, and installs it into the durable catalog
(`WorkflowCatalog.install()`, the same WFT-9/10 primitive `engine.register()`'s
own drain uses)—returning the installed `WorkflowRevisionRecord`. Calling it
again for an already-installed `(name, revision)` returns the cataloged
record immediately without re-evaluating the module, including a revision
installed by a different process.

**Single-flight per `(name, revision)`:** concurrent callers for the same
key share one loader invocation. Each caller's own cancellation
(`options.signal`, or engine disposal) only rejects that caller's own
`resolveWorkflowSource()` call—a load already in flight for other callers
runs to completion regardless of who requested it or who later cancels.
Disposal rejects every outstanding waiter rather than leaving any promise
pending.

### Validation and `WorkflowSourceRejectionReason`

A loaded module is validated from `unknown` before anything is installed:
the named export must exist and must not itself be an ES module namespace
object (an `export * as x` barrel—`ambiguous-export`), it must be a
builder-produced `WorkflowDefinition` (a hand-rolled `{ name, handler }`
literal is the removed bare-handler shape, and is rejected the same way
`invalid-definition`), its contract must fit within the WFT-5 hostile-input
limits (`manifest-build-failed`), and the built manifest must be compatible
with the descriptor's expectations via `checkWorkflowCompatibility()`—a
`name`, `revision`, pinned `workflowVersion`, or pinned `contractHash`
mismatch is reported the same way `engine.workflows.activate()` reports an
incompatible candidate (see [Activation Compatibility](#activation-compatibility)
above). `workflowVersion` pinning routes through `checkWorkflowCompatibility`'s
existing `workflow-version-incompatible` check, which is exact string
equality (`checkVersionCompatibility()`'s entire contract is `storedVersion
=== registeredVersion`—there is no semver-range matching anywhere in that
path); a pinned `workflowVersion: '^1.0.0'` against an actual `'1.2.0'`
rejects, it does not match. Every applicable reason is
reported, never just the first one found; a failed resolve throws
`WorkflowSourceValidationError`, carrying `workflowName`, `revision`, and
the full `reasons` array.

A workflow registered both eagerly (`engine.register()`) and lazily
(`registerSource()` + `resolveWorkflowSource()`) from logically identical
content installs the same byte-identical manifest either way—both paths
route through the same contract-building normalization
(`buildWorkflowManifestFromDefinition`), so `WorkflowCatalog.install()`
never sees two different manifests for what is really one piece of content
under one `(name, revision)` key.

## Engine Integration (WFT-15/16)

Every entry point that can launch or resume a workflow—`engine.start()`,
`startOrSignal()`, `schedule()`, `fork()`, `resume()`, `recoverAll()`, and
bulk-retry—now awaits dynamic-source resolution for a `registerSource()`-registered
type before running any handler code. An eagerly `engine.register()`-ed
type still resolves synchronously and never touches the dynamic-source
machinery at all: starting an eager workflow never imports a differently-named
lazy source, even when both are registered on the same engine.

```ts partial
import { Engine, workflowSource } from '@lostgradient/weft';

const engine = new Engine();
engine.registerSource(
  workflowSource(
    {
      name: 'checkout',
      location: './checkout.ts',
      exportName: 'checkout',
      revision: 'sha256:9f2c…',
    },
    () => import('./checkout.ts'),
  ),
);

// Awaits resolution (loads, validates, and durably installs the revision)
// before the workflow's handler ever runs.
const handle = await engine.start('checkout', { orderId: 'order-1' });
```

**Candidate-until-resolved invariant:** no workflow handler runs while its
definition is still a catalog candidate. `resolveExecutableRegistration()`
(the shared internal helper every entry point above funnels through) always
awaits the full load→validate→install pipeline before returning an
executable registration—there is no path that hands a generator a
definition that has not yet cleared validation.

**Active-revision disambiguation:** a lazy name with exactly one registered
revision resolves it unambiguously. A lazy name with two or more registered
revisions resolves the catalog's active pointer (`engine.workflows.getActive()`)
when it names one of the registered candidates; with no active pointer set
and more than one candidate registered, resolution throws
`DynamicWorkflowSourceUnavailableError` with `reason: 'ambiguous-revision'`
rather than guessing—call `engine.workflows.activate()` first, or register
only one revision at a time. `StartOptions` still has no per-call revision
override—a one-shot `engine.start()` always resolves whatever is active (or
unambiguous) at that instant. `ScheduleOptions` gained one in WFT-20:
`revisionPolicy: 'pinned'` captures the revision active at schedule
create/update time and forces every future occurrence to resolve exactly
that revision—see
[Schedule revision policy](#schedule-revision-policy-wft-20) below.

**Concurrency and cancellation:** concurrent `engine.start()` calls (or a
`start()` racing an explicit `engine.resolveWorkflowSource()` call) for the
same `(name, revision)` share one loader invocation—the same single-flight
contract [`resolveWorkflowSource()`](#resolveworkflowsource-load-validate-install)
already documents. A cancelled `resolveWorkflowSource({ signal })` waiter
never aborts a load a concurrent `start()` still needs. Engine disposal
settles every pending waiter with `EngineDisposedError` and closes resolver
resources; the shared load itself is never aborted by disposal, only
orphaned.

### `engine.workflows.preload()`

```ts partial
const record = await engine.workflows.preload('checkout', 'sha256:9f2c…');
```

A documented thin alias for `engine.resolveWorkflowSource()`, offered on
the `engine.workflows` namespace so deployment tooling that already reaches
for `engine.workflows.*` for every other catalog operation does not need a
second entry point. Identical single-flight, cancellation, and error
contract. Exposed as the `weft.workflows.revisions.preload` server
operation (`POST /v1/registry/workflows/:name/preload`)—see
[api-server.md](../reference/api-server.md) and
[api-observability.md](../reference/api-observability.md).

### Recovery: durable per-run revision pinning, grouped by exact `(type, revision)` (WFT-17/WFT-18)

`recoverAll()` (and therefore `Engine.create()`, which calls it by default)
groups non-terminal state by the EXACT `(type, revision)` each run
persisted at start (`WorkflowState.revision`, see
[Per-run revision pinning](#per-run-revision-pinning-wft-17) above) and
preloads every group ONCE, before advancing any of that group's
generators—not once per run, and not once per type either: two runs of the
SAME type pinned to two DIFFERENT revisions recover against their own
revision's code, never against whichever revision happens to be active.

> [!NOTE]
> `Engine.create()`'s options accept eager `workflows`/`activities` but have
> no `sources` field, so there is no way to `registerSource()` a dynamic
> type before its automatic `recover: true` pass runs. To have automatic
> recovery resolve a `registerSource()`-registered type at all, build the
> engine manually instead: `new Engine({ storage, ... })`, then
> `engine.registerSource(...)` for every dynamic type, then
> `await engine.recoverAll()`—the same sequence `dynamic-source-recovery.test.ts`
> exercises. Passing `recover: false` to `Engine.create()` and driving
> recovery yourself is the supported path when you need dynamic sources
> registered before recovery runs. A group whose pinned revision cannot be
> resolved is classified `unavailable`: only its own non-terminal runs fail
> (with `WorkflowRevisionUnavailableError` as a `system`-category failure
> cause); sibling groups—including a DIFFERENT revision of the SAME
> type—continue recovering normally, mirroring the existing version-mismatch
> recovery isolation. A registered-but-not-yet-resolved dynamic source is
> never routed through the `'type-not-registered'` missing-registration
> classification (`WorkflowRecoverySkippedEvent`)—only a name with no
> registration of any kind (neither eager nor a registered source) is
> "missing."

**Recovery never falls back from a missing exact revision to the active
revision.** A legacy record from before `WorkflowState.revision` existed is
treated as unambiguous—and recovers exactly as before—for an eager type or
a dynamic source with at most one registered candidate; it is forced
`unavailable` (`reason: 'legacy-ambiguous'`) only when the ambiguity is
real: a dynamic source with two or more registered candidates and no pin to
disambiguate with. See
[Dynamic-source recovery](recovery-and-deploys.md#dynamic-source-recovery-durable-per-run-revision-pinning-wft-17wft-18)
in the recovery guide for the full ready/unavailable/incompatible
classification and worked examples.

The activity-registry caveat below is a separate, still-open limitation
this batch does not touch: resolving a dynamic type's revision installs its
activity registry keyed only by workflow `type`, not by `(type, revision)`.
If two revisions of one dynamic type are ever resolved concurrently on the
same engine—an already-running run on `r1` while a fresh `start()` or
recovery resolves `r2`—the later resolve's activity registry becomes the
one every run of that type executes against, including the `r1` run still
in flight. This is a WFT-19 routing-key boundary (see
[the batch scope note](recovery-and-deploys.md#dynamic-source-recovery-durable-per-run-revision-pinning-wft-17wft-18)):
avoid it by keeping one active revision per dynamic type, or by routing
activities through a mechanism that doesn't depend on this shared per-type
registry.

### Diagnostics and events

`weft.catalog.diagnostics` (and the in-process `getWorkflowRevisionDiagnostics()`
helper) gains an optional `source` field—kind, requested revision, load
state (`idle | loading | ready | failed | cancelled`), load duration, last
failure category, and outstanding waiter count—present only when the name
was ever `registerSource()`-registered on this engine. Four bounded,
process-local events fire around the load pipeline:
`workflow-source:load-started`, `-ready`, `-failed`, and `-cancelled`. See
[api-events.md](../reference/api-events.md#dynamic-workflow-source-events)
and [api-observability.md](../reference/api-observability.md) for the full
field-level reference.

### New errors

`WorkflowSourceNotRegisteredError` (`engine.resolveWorkflowSource()`/
`engine.workflows.preload()` called against a specific `(name, revision)`
`registerSource()` never recorded) and `DynamicWorkflowSourceUnavailableError`
(a registered source's target revision is ambiguous, or its load fails) are
new public error classes. A workflow `type` with no registration of any
kind—eager or dynamic—still throws the pre-existing `WorkflowNotRegisteredError`,
unchanged, from every execution entry point; see
[api-errors.md](../reference/api-errors.md) for the full table.
