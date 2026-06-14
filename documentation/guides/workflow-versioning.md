# Workflow Versioning

Workflow versions are a recovery guard. When a workflow starts, Weft records the
registered workflow version in the workflow state and checkpoint. During
recovery, Weft compares the stored version with the currently registered
version. It also checks the recorded version tuple for workflow, agent, and tool
version drift.

Recovery continues only when the workflow versions match and the stored version
tuple has not drifted. A workflow version mismatch or version-tuple drift stops
recovery with a `VersionMismatchError` so the operator can decide how to handle
the in-flight workflow deliberately. Weft does not run a checkpoint migration
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
versions, recovery also throws `VersionMismatchError`. The `weft version:check`
diagnostic reports workflow-version compatibility; account for version-tuple
drift separately when changing agent or tool version metadata.

## Handling Mismatches

When recovery sees an incompatible workflow version or version-tuple drift, it
throws `VersionMismatchError`. The error carries the workflow id, workflow type,
stored version, registered version, and optional shape/version-drift details.

```typescript partial
import { VersionMismatchError } from '@lostgradient/weft';

try {
  await engine.recoverAll();
} catch (error) {
  if (error instanceof VersionMismatchError) {
    console.log(error.workflowId);
    console.log(error.workflowType);
    console.log(error.storedVersion);
    console.log(error.registeredVersion);
  }
}
```

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
