# Workflow Versioning

Workflow versions are a recovery guard. When a workflow starts, Weft records the
registered workflow version in the workflow state and checkpoint. During
recovery, Weft compares the stored version with the currently registered
version.

If the versions match, recovery continues. If they differ, recovery stops with a
`VersionMismatchError` so the operator can decide how to handle the in-flight
workflow deliberately.

## Version Pinning

The default workflow version is `'1'` when you do not specify one during
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

`checkVersionCompatibility()` has two outcomes:

- **`'compatible'`**: versions match and recovery can continue.
- **`'incompatible'`**: versions differ and recovery must stop.

```typescript partial
import { checkVersionCompatibility } from '@lostgradient/weft';

checkVersionCompatibility('1.0.0', '1.0.0'); // 'compatible'
checkVersionCompatibility('1.0.0', '2.0.0'); // 'incompatible'
```

## Handling Mismatches

When recovery sees an incompatible version, it throws `VersionMismatchError`.
The error carries the workflow id, workflow type, stored version, registered
version, and optional shape/version-drift details.

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
