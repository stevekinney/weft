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
activation primitive—the one a future dynamic-loading system will call, not
`engine.register()`.

Activating a new revision never alters an already-started run: a workflow
instance's own recorded `workflowVersion` and checkpoint state are
unaffected by a later `engine.register()`/activation call for the same
name—only new starts and recovery resolve against the catalog's current
active pointer.

## Reference Accounting and Removal

A revision cannot simply be deleted once installed—something might still be
relying on it. `WorkflowRevisionReferenceCounts` is the bounded accounting
interface a removal decision is gated on: seven fields, always present, so
a caller never special-cases an "unknown" reference kind.

Two fields are wired to real in-process signals now:

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

The remaining five fields—`nonTerminalRuns`, `pinnedSchedules`,
`pendingDispatches`, `activeExecutionRealms`, and `retainedRecoveryRecords`—
stay structurally present but always `0`. Each depends on run-level
revision pinning, which does not exist yet: a `WorkflowState` does not
currently record which catalog revision it was started against, so there
is nothing yet to count a non-terminal run, a pinned schedule, a queued
dispatch, an active execution realm, or a retained recovery record
against. That dependency lands with run-level revision pinning; until
then, these fields exist as forward-compatible plumbing rather than a
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

`getWorkflowRevisionDiagnostics(engine, name, revision)` projects the same
accounting into a read-only shape—`installed`, `active`, `activeRevision`,
`references`, and a derived `removable` boolean—without attempting the
removal, useful for an operator checking whether a cleanup would succeed
before running it. It backs the `weft.catalog.diagnostics` operation; see
[api-observability.md](../reference/api-observability.md).

Reference accounting in this batch is **in-process only**: under
`ownership: 'workflow-lease'` (ADR 0002), a second engine process sharing
the same durable store has its own, empty `registeredDefinitions`/
`inFlightStarts` signals and can remove a revision the first process still
has registered and is actively running against. This is a known, deliberate
scope limit—durable, cross-process reference tracking depends on the same
run-level revision pinning the five always-zero fields above are waiting
on.

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
the package-internal `activateCatalogRevisionCandidate` wrapper—still
without a production caller this batch) both dispatch through the same
shared installed/activated/draining logic, so the two producers can never
disagree about when an event fires. See
[api-events.md](../reference/api-events.md#catalog-events) for the full
field-level reference.
