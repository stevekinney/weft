# Recovery and Deploys

Weft promises that workflows survive process death. The mechanism is `engine.recoverAll()` — at boot, the engine scans storage for workflows that were running when the previous process exited and resumes them. Call it directly on a manually-built engine, or pass `recover: true` to `Engine.create()` so recovery runs after definition registration.

This guide is about what happens when recovery and your deploy lifecycle disagree — when storage holds workflows whose code is no longer in the new build, when you're rolling pods one at a time, or when you genuinely want to abandon old workflows and need to do it on purpose.

## The default: loud failure on unknown types

If `recoverAll()` finds a running workflow whose type isn't registered on the engine, it throws `WorkflowTypeNotRegisteredForRecoveryError` before resuming anything. No partial recovery, no quiet skip, no zombie workflows hanging around in storage with no process to drive them.

```typescript partial
import { Engine, WorkflowTypeNotRegisteredForRecoveryError } from 'weft';
import { SQLiteStorage } from 'weft/storage/sqlite';

try {
  const engine = await Engine.create({
    storage: new SQLiteStorage('./weft.db'),
    workflows: { greet },
    recover: true,
  });
} catch (error) {
  if (error instanceof WorkflowTypeNotRegisteredForRecoveryError) {
    console.error(
      'Cannot boot — storage references workflow types this build does not know about:',
    );
    console.error('  registered:', error.registeredTypes);
    console.error('  missing:   ', error.missingTypes);
    console.error('  affected workflows:', error.missingWorkflowCount);
    process.exit(1);
  }
  throw error;
}
```

The error carries enough structure to make the failure actionable:

| Property                 | Meaning                                                                          |
| ------------------------ | -------------------------------------------------------------------------------- |
| `registeredTypes`        | Sorted list of every workflow type registered on this engine.                    |
| `missingTypes`           | Sorted, deduplicated list of workflow types found in storage but not registered. |
| `missingWorkflowSamples` | Up to 20 `{ type, workflowId }` pairs for the affected workflows.                |
| `missingWorkflowCount`   | Total affected workflow count, regardless of sample cap.                         |
| `samplesTruncated`       | `true` when `missingWorkflowCount > 20`.                                         |

The `Error.message` lists missing _type names_ (capped at ten with `+N more` past that), but never includes workflow IDs. If you serialize the error over an HTTP boundary, IDs are stripped from the response by default — see the server section below.

> [!NOTE]
> Storage with `pending`, `completed`, `failed`, `cancelled`, or `timed-out` workflows is unaffected by this check. Only `running` workflows that need their generator function back to make progress trigger the throw.

## Why throw rather than skip?

Earlier versions of Weft silently skipped unregistered workflow types during recovery. The result: a deploy that accidentally dropped a workflow definition would boot cleanly, look healthy, and silently abandon every in-flight execution of that workflow type. The bug surfaced only when someone noticed a customer's order had been stuck in `running` for a week.

The default has flipped because abandoned workflows are almost always a bug, not an intent. If you _do_ intend it — see the next section — you have to say so explicitly.

## Acknowledging drift: `acknowledgeUnknownWorkflowTypes`

Sometimes drift is intentional: a rolling deploy where old pods are still serving the workflow type the new pod doesn't know; a storage migration where you're copying records into a partial registry; a one-shot operator script that doesn't need to drive every workflow type the database holds.

For these cases, pass `acknowledgeUnknownWorkflowTypes: true`:

```typescript partial
import { Engine, WorkflowRecoverySkippedEvent } from 'weft';

const engine = await Engine.create({
  storage,
  workflows: { greet },
  acknowledgeUnknownWorkflowTypes: true,
});

engine.addEventListener(WorkflowRecoverySkippedEvent.type, (event) => {
  const skipped = event as WorkflowRecoverySkippedEvent;
  console.warn(
    `[recovery] skipped workflow ${skipped.workflowId} of type ${skipped.workflowType}`,
    `(reason: ${skipped.reason})`,
  );
});
```

The flag does two things:

1. Suppresses the `WorkflowTypeNotRegisteredForRecoveryError` throw.
2. Emits one `WorkflowRecoverySkippedEvent` per skipped workflow, so a logging or metrics pipeline can record the drift instead of silently swallowing it.

The verbose flag name is intentional. `skipUnknownTypes` would be too tempting to reach for; `acknowledgeUnknownWorkflowTypes` reads like what it is — an acknowledgment that you're aware some workflows in storage will not be recovered by this process.

## Rolling deploys

The most common reason recovery sees an unknown type is a deploy that hasn't finished. A new pod starts up with a build that no longer includes `oldFlow`, but old pods still own running `oldFlow` workflows. The new pod doesn't need to recover those — the old pods do — but during the rollover the new pod might `recoverAll()` against the same storage.

Two patterns work, depending on how strict you want to be:

**Pattern A — co-deploy old and new.** Keep the old workflow definition registered alongside the new build until storage drains. Once every running `oldFlow` instance has reached a terminal state, ship a follow-up deploy that drops the registration. This is the safest path because the workflow's _real_ code is still around to drive its checkpoints.

**Pattern B — acknowledge during cutover.** Pass `acknowledgeUnknownWorkflowTypes: true` on the new pods for the duration of the rollover, listen for `WorkflowRecoverySkippedEvent` to confirm the affected workflows are who you expected, and ship a follow-up deploy that drops the flag once old pods are fully gone. This is fine when the old pods are still around to recover their own workflows; it is dangerous if no process owns the affected types because those workflows simply stop making progress.

> [!WARNING]
> **Do not** "shim" a retired workflow with a stub handler that throws or no-ops. Workflow checkpoints are tied to the original code's `yield*` boundaries — a stub handler does not match those boundaries and replay will diverge in ways that range from "throws on resume" to "silently produces a wrong result." If you genuinely want to terminate a running workflow whose code you've removed, do it as an explicit storage migration that marks the workflow `cancelled` or `failed`, not as a fake handler.

## Retiring a workflow type for good

When you want to permanently drop a workflow type, the only safe sequence is:

1. **Stop new starts.** Remove the workflow's code from the start-side surface (whatever HTTP route, queue consumer, or scheduled job kicks off `engine.start('oldFlow', ...)`). Keep the registration.
2. **Drain.** Let in-flight `oldFlow` workflows reach terminal states naturally. This may take hours, days, or weeks depending on what the workflow does.
3. **Verify storage is clean.** Query for any remaining non-terminal `oldFlow` records (or use the bulk-list API). If you find some that are stuck, decide whether to wait, cancel them explicitly via `engine.cancel(workflowId)`, or — only as a last resort — write a storage migration that marks them terminal.
4. **Drop the registration.** Once step 3 is satisfied, ship the deploy that removes the workflow from `Engine.create({ workflows: ... })`.

The order matters: dropping the registration before draining is the bug pattern this guide exists to prevent.

## What about activities?

Recovery validates **workflow types**, not activity registrations. A workflow can survive recovery and then call a removed activity, at which point the activity dispatch fails at runtime via the existing activity-not-registered path.

The asymmetry is deliberate. A workflow's running state is owned by its checkpoint, which the engine has to be able to drive forward — that's why a missing handler at recovery is a hard fail. An activity is a leaf operation: it runs once, gets a result, and the workflow moves on. A missing activity surfaces at the moment of dispatch, which is the right time to surface it because that's the only point where the workflow actually needs the implementation.

If you're retiring an activity, the same drain-then-drop discipline applies — just at the activity-call boundary rather than the workflow-recovery boundary.

## Recovery from the server (HTTP)

When you expose recovery over HTTP via the `weft.recover.all` operation, the same drift behavior applies, with two extra constraints to keep the public surface safe:

- **Workflow IDs never cross the HTTP boundary.** Storage with unknown types causes the operation to return a `409 Conflict` fault. The fault payload includes `missingTypes` (array of type names), `missingWorkflowCount` (integer), and `samplesTruncated` (boolean) — but never workflow IDs. IDs stay on the structured error in-process.
- **The `acknowledgeUnknownWorkflowTypes` opt-out is not exposed over HTTP.** Letting an unauthenticated caller silently skip recovery would be a footgun on a public route, so the HTTP request body has no input fields. Operators who need the opt-out call `engine.recoverAll({ acknowledgeUnknownWorkflowTypes: true })` from their own boot code, where the intent is established before the engine starts handling requests.

This is intentionally one-way: an HTTP client gets enough information to know recovery is blocked and what types are missing, but cannot enumerate affected workflows or skip the gate. If your operators need ID-level visibility or the skip behavior, they need access to the engine process — logs, metrics, or the in-process API — not the HTTP route.

## Demo: a workflow that survives a restart

Hello-world is too short to actually exercise recovery — it completes in under a second. To see recovery do its job, build a workflow that suspends on a signal, run it once to leave the workflow in `running`, then run a second script that resumes it.

`recovery-demo.ts`:

```typescript
import { Engine, WorkflowAlreadyExistsError, signal, workflow, type WorkflowContext } from 'weft';
import { SQLiteStorage } from 'weft/storage/sqlite';

const release = signal<{ message: string }>('release');

const waiter = workflow({ name: 'recoveryDemoWaiter' }).execute(async function* (
  ctx: WorkflowContext,
  input: { id: string },
) {
  console.log(`[workflow ${input.id}] suspending on signal`);
  const payload = yield* ctx.waitForSignal(release);
  console.log(`[workflow ${input.id}] released with: ${payload.message}`);
  return { id: input.id, message: payload.message };
});

const engine = await Engine.create({
  storage: new SQLiteStorage('./recovery-demo.db'),
  workflows: { recoveryDemoWaiter: waiter },
});

const workflowId = 'recovery-demo:1';
try {
  await engine.start('recoveryDemoWaiter', { id: workflowId }, { id: workflowId });
  console.log('Started a fresh waiter — kill the process now (Ctrl+C) and re-run this script.');
  console.log('After the second start, send the release signal from another shell.');
  // Block forever so the workflow stays in `running`.
  await new Promise(() => {});
} catch (error) {
  if (!(error instanceof WorkflowAlreadyExistsError)) throw error;

  console.log('Recovered an existing waiter — sending the release signal.');
  await engine.signal(workflowId, release, { message: 'recovered cleanly' });

  const handle = engine.getHandle(workflowId);
  const result = await handle.result();
  console.log('Workflow finished:', result);
}
```

The flow:

1. **First run.** `Engine.create` registers the waiter and recovers nothing (storage is empty). `engine.start()` creates the workflow; it suspends on `ctx.waitForSignal(release)` and persists a checkpoint. The script blocks. Kill it with Ctrl+C.
2. **Second run.** `Engine.create` runs `recoverAll()`, finds the running waiter in storage, and resumes it from the suspended-on-signal checkpoint. `engine.start()` throws `WorkflowAlreadyExistsError`, the `catch` handles it by sending the signal, and `handle.result()` returns the workflow's output.

If between runs you remove `recoveryDemoWaiter` from the `workflows` map, the second run throws `WorkflowTypeNotRegisteredForRecoveryError` instead of recovering — that's the loud-failure default in action.

## Related

- [Hello World](../getting-started/hello-world.md) — the basic boot pattern with `Engine.create`.
- [Server guide](./server.md) — exposing `recoverAll` over HTTP.
- [Migration guide](./migration.md) — upgrading existing call sites.
