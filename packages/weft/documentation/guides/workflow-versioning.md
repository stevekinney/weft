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
