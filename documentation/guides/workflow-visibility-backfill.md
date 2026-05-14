# Workflow Visibility Backfill

Weft writes workflow visibility indexes as the engine updates workflow state. Existing databases may have workflows that predate those index rows, so filtered `engine.list()` and `engine.aggregate()` calls need a one-time backfill before they can trust the `wf-idx-*` rows for the whole database.

The backfill script builds the same visibility-index rows the runtime writes for new workflow updates. When the scan finishes without racing writes, it records a watermark that tells the engine the index is current. Until that watermark exists, the engine keeps using the slower fallback path for visibility queries.

> [!WARNING]
> Run this from a maintenance window. Any writer that bypasses the engine's visibility-index update path can leave an older workflow un-indexed below the backfill cursor while the watermark later claims the database is fully covered.

## When to run it

Run the backfill after deploying the workflow visibility indexes to a Bun SQLite deployment that already has persisted workflow state.

You do not need this script for an empty database. You also do not need it for browser storage, because this production script instantiates `BunSQLiteStorage` directly and expects a SQLite database file.

## Before running

Pause every path that can write workflow state or write directly to Weft storage:

- Weft engine processes that can start, update, signal, cancel, time out, recover, or complete workflows.
- Import scripts that create or mutate workflow records.
- Repair tooling that edits workflow state, checkpoints, search attributes, tags, deadlines, archives, or operation keys.
- Custom storage-layer write paths that call `put`, `delete`, `batch`, `conditionalBatch`, `deletePrefix`, or raw SQL against the Weft key-value table.
- Direct database jobs, migrations, or maintenance scripts that touch `wf:*`, `wf-idx-*`, `attr:*`, `idx:*`, `tag:*`, or related workflow visibility keys.

The engine's normal write path is safe because it updates visibility indexes together with workflow state. The dangerous case is a foreign write path that changes a workflow below the current cursor without also maintaining its manifest and index rows.

## Run the backfill

Use the production SQLite database path:

```bash
bun scripts/rebuild-workflow-visibility-indexes.ts --storage /var/lib/weft/weft.db
```

For large databases, keep the default batch size unless you have measured a reason to change it. Smaller batches create more checkpoints and make progress more granular. Larger batches reduce checkpoint writes but increase the amount of work repeated after an interruption.

```bash
bun scripts/rebuild-workflow-visibility-indexes.ts --storage /var/lib/weft/weft.db --batch-size 250
```

Add `--verbose` when you need progress logs for a long maintenance window:

```bash
bun scripts/rebuild-workflow-visibility-indexes.ts --storage /var/lib/weft/weft.db --verbose
```

A successful run prints:

```text
Backfill complete. Processed <count> workflows. Watermark advanced.
```

After that message, restart the paused engines.

Only resume a paused foreign write path if it now uses the engine write path or maintains the same visibility-index contract as the engine. A direct storage writer that still changes workflow state without updating the manifest and `wf-idx-*` rows remains unsafe after the watermark exists, because visibility queries will trust the index.

## Exit codes

| Exit code | Meaning                          | Operator action                                                                                                                                       |
| --------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1`       | Fatal usage or runtime error     | Fix the reported problem, such as a missing `--storage` value or an unexpected exception, then run the command again.                                 |
| `2`       | Backend lacks `conditionalBatch` | Use the Bun SQLite storage file targeted by this script. The backfill refuses unsafe backends because racing writes could leave workflows un-indexed. |
| `3`       | Conditional conflicts occurred   | Keep writers paused and re-run the command. A conflict means the script skipped at least one workflow that changed during the scan.                   |

Exit code `3` is retryable. The script leaves its cursor in storage, so a follow-up run resumes from the last committed cursor instead of starting from the beginning.

## Roll back the index

If you need to force the engine back to the slow visibility path, drop the generated index rows and watermark:

```bash
bun scripts/rebuild-workflow-visibility-indexes.ts --storage /var/lib/weft/weft.db --drop
```

The drop order is intentional:

- The watermark is removed first, so the engine immediately stops trusting the index.
- The `wf-idx-*` rows are swept after the watermark is gone.
- The cursor is cleared last.

That ordering avoids the unsafe window where the engine sees a current watermark but the indexed rows are missing or partially deleted.

## Verify the rollout

Before restarting production writers, confirm the command exited with code `0` and printed `Watermark advanced`.

After restart, exercise the visibility paths your operators depend on:

- List workflows with the filters used by dashboards or operations scripts.
- Run representative aggregate queries.
- Check application logs for `WorkflowListScanCapExceededError`; that error means the query had to fall back to scanning and still exceeded the configured cap.

If a verification query looks incomplete, pause writers again, run `--drop`, re-run the backfill, and only then restart engines.

## Related

- [Storage guide](./storage.md) — backend behavior and key-value storage contracts.
- [Search Attributes guide](./search-attributes.md) — query dimensions that feed workflow visibility.
- [Recovery and Deploys](./recovery-and-deploys.md) — maintenance-window guidance for persisted workflows.
