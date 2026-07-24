# CLI Reference

Weft provides a command-line interface for running the server and diagnosing database state.

This reference documents the `weft` CLI entrypoint (`src/cli-main.ts`). The published [`@lostgradient/weft`](https://www.npmjs.com/package/@lostgradient/weft) package installs both the `weft` binary and the [`weft-mcp`](api-server.md#mcp-server) binary.

> [!NOTE]
> [`serve`](#serve-default), [`doctor`](#doctor), and the leading-token version forms [`version`](#version), `--version`, and `-v` are the candidate-stable source/binary CLI commands for the pre-1.0 launch plan. [`conformance`](#conformance), [`codegen`](#codegen), and other specialized commands are useful, but their flags and output contracts remain experimental until the Tier-0 contract and 1.0 stability policy land. See the [canonical stability-tier inventory](../contributing/breaking-changes.md#stability-tiers).

## Usage

```bash
weft [command] [options]
```

## Commands

### serve (default)

Start the Weft durable execution server.

```bash
weft --port 7233 --database ./weft.db
weft serve --port 8080 --database /var/data/weft.db
```

**Options:**

| Flag          | Short | Default     | Description                                               |
| ------------- | ----- | ----------- | --------------------------------------------------------- |
| `--port`      | `-p`  | `7233`      | Server port                                               |
| `--database`  | `-d`  | `./weft.db` | SQLite database file path                                 |
| `--storage`   | `-s`  | `sqlite`    | Storage backend: `sqlite`, `lmdb`, or `memory`            |
| `--workflows` | `-w`  |             | Path to a workflow module to load and register on startup |
| `--console`   |       | `false`     | Mount `@lostgradient/weft-console` and its static assets  |
| `--help`      | `-h`  |             | Show help message                                         |

When `--workflows` is omitted, the server starts in inspect-only mode (useful for viewing existing persisted workflow state via the REST API, but no new workflow types can be executed). When provided, the module's exported `WorkflowDefinition` values and `ActivityDefinition` values are loaded and registered before the server begins accepting requests.

```bash
weft serve --workflows ./src/workflows.ts
weft serve --port 8080 --database /var/data/weft.db --workflows ./src/my-workflows.ts
```

To mount the optional operator console from the CLI, install it in the project
where `weft serve` runs and pass `--console`:

```bash
bun add @lostgradient/weft-console
weft serve --console --workflows ./src/workflows.ts
```

The CLI resolves the package from the current project, calls its exported
`weftConsole()` function, and mounts its adjacent `assets/` directory at
`/assets`. A missing package or invalid export is reported as an error before
the server binds. Library users can mount it directly with
`serve({ engine, dashboard: weftConsole() })`.

### doctor

Run diagnostics against a Weft database. Reports database health, workflow statistics, activity queue depths, and actionable recommendations.

```bash
weft doctor --database ./weft.db
weft doctor --database ./weft.db --json
```

**Options:**

| Flag         | Short | Default     | Description                                   |
| ------------ | ----- | ----------- | --------------------------------------------- |
| `--database` | `-d`  | `./weft.db` | SQLite database file path                     |
| `--json`     | `-j`  | `false`     | Output as JSON instead of human-readable text |
| `--help`     | `-h`  |             | Show help message                             |

**Output sections:**

- **Database**: file size, WAL size, integrity check, fragmentation estimate
- **Workflows**: total count by status, longest running workflow, largest checkpoint
- **Activities**: pending and in-flight operation counts per queue
- **Recommendations**: actionable warnings based on configurable thresholds

### conformance

Use these two commands when you need to prove worker compatibility or publish typed registry declarations from a live server.

Run the RemoteWorker protocol conformance harness against a worker command. Use this when validating a non-TypeScript SDK, a custom worker launcher, or a protocol-level change.

```bash
weft conformance -- ./bin/my-worker
weft conformance --timeout 30000 --json -- ./bin/my-worker --queue default
```

The worker command receives these environment variables:

| Variable                       | Description                                                      |
| ------------------------------ | ---------------------------------------------------------------- |
| `WEFT_WORKER_URL`              | Temporary WebSocket task-stream URL the worker should connect to |
| `WEFT_WORKER_QUEUE`            | Queue name assigned to the conformance run                       |
| `WEFT_WORKER_ACTIVITIES`       | Comma-separated activity names the worker should expose          |
| `WEFT_WORKER_PROTOCOL_VERSION` | Protocol version expected by the harness                         |

**Options:**

| Flag        | Short | Default | Description                        |
| ----------- | ----- | ------- | ---------------------------------- |
| `--timeout` |       | `15000` | Per-check timeout in milliseconds  |
| `--json`    | `-j`  | `false` | Output conformance results as JSON |
| `--help`    | `-h`  |         | Show help message                  |

### codegen

Generate deterministic TypeScript declarations from a registry snapshot. Use this when a client package needs typed workflow and activity names but does not have direct access to the `Engine` instance that registered them.

```bash
weft codegen --server http://localhost:7233 --out ./src/weft.generated.d.ts
weft codegen --from ./registry.json --out ./src/weft.generated.d.ts
weft codegen --server http://localhost:7233 --out ./src/weft.generated.d.ts --json
```

The generated file augments the public `weft` module with `WorkflowRegistry` entries — typed workflow names that make `engine.start('name', ...)` infer the right input shape. Activity names are no longer typed via a global module augmentation; they live on the workflow builder's `.activities({...})` step instead. Output is byte-stable: running the command again with the same snapshot reports that the file is up to date and does not rewrite it.

The source registry snapshot also exposes each workflow's statically declared signal, update, and query names with their available input/output JSON Schemas. Activity entries include their registered retry policy and timeout alongside queue and schema metadata. `weft codegen` currently uses workflow input/output schemas for declaration generation; activity schemas and the additional operator metadata remain available directly from `GET /v1/registry`.

When `--server` is used, connection resolution follows the same order as the server-inspection commands: explicit `--server`, `WEFT_ADDR`, selected profile, then the run lockfile written by `weft serve`. If the resolved server URL is malformed, the diagnostic reports the actual offending value regardless of which source supplied it. For example, a bad profile URL now fails as `codegen: invalid server URL '<value>'` rather than reconstructing the message from flags and environment alone.

**Options:**

| Flag        | Short | Default | Description                                                                                      |
| ----------- | ----- | ------- | ------------------------------------------------------------------------------------------------ |
| `--server`  |       |         | Base URL of a running Weft server. The CLI appends `/api/v1/registry` to the supplied path.      |
| `--from`    |       |         | Local registry snapshot JSON file. Mutually exclusive with `--server`.                           |
| `--token`   |       |         | Bearer token for `--server`. Falls back to `WEFT_TOKEN`; persistent credentials are unsupported. |
| `--out`     | `-o`  |         | Required output `.d.ts` file. The parent directory must already exist.                           |
| `--timeout` |       | `30000` | Network timeout in milliseconds for `--server`.                                                  |
| `--json`    | `-j`  | `false` | Emit one machine-readable JSON result on stdout; errors are JSON on stderr.                      |
| `--help`    | `-h`  |         | Show help message                                                                                |

**Exit codes:**

- `0`: declarations were written or were already up to date.
- `1`: validation, network, authentication, or filesystem failure. Partial output is not left behind.

**Generated declaration shape:**

```typescript partial
declare module '@lostgradient/weft' {
  interface WorkflowRegistry {
    checkout: {
      input: CheckoutInput;
      output: CheckoutOutput;
    };
  }
}
```

Unsupported JSON Schema features intentionally degrade to `unknown` rather than emitting an unsound type. `$ref`, `patternProperties`, `not`, `dependentRequired`, and other unsupported keywords should be simplified before publishing the registry snapshot if you need narrower generated types.

### version

Print the installed Weft version and exit. Equivalent forms:

```bash
weft version
weft --version
weft -v
```

The output is the bare version string (for example, `0.3.0`) so scripts can capture it without parsing decoration. The exit code is `0`.

Version is recognized only as the _leading_ token, which keeps each subcommand in control of its own option line. `weft serve --version` does not print the version—`serve` rejects `--version` as an unknown option—so a real command never silently short-circuits to version output. This is the same command surfaced as `version` in `--help` and shell completions.

Not to be confused with [`version:check`](#versioncheck), which compares registered workflow versions against a database.

### version:check

Analyze registered workflow versions against an existing database to check deployment compatibility.

> [!NOTE] Experimental
> `version:check` is experimental before 1.0. The candidate-stable CLI set is
> `serve`, `doctor`, `version`, `--version`, and `-v`; treat this command's
> flags and output as subject to change.

```bash
weft version:check --database ./weft.db --workflows ./src/workflows.ts
weft version:check --database ./weft.db --workflows ./src/workflows.ts --json
```

**Options:**

| Flag          | Short | Default     | Description                                   |
| ------------- | ----- | ----------- | --------------------------------------------- |
| `--database`  | `-d`  | `./weft.db` | SQLite database file path                     |
| `--workflows` | `-w`  | (required)  | Path to module exporting workflow definitions |
| `--json`      | `-j`  | `false`     | Output as JSON instead of human-readable text |
| `--help`      | `-h`  |             | Show help message                             |

The `--workflows` path is a TypeScript module resolved by Bun at runtime. Point it at source—for example `./src/workflows.ts`—not at compiled output in `dist/`, or version checks reflect stale code.

The workflows module may export builder-produced workflow definitions directly or as a map:

```typescript partial
import { workflow } from '@lostgradient/weft';

export const order = workflow({
  name: 'order',
  version: '2.0.0',
  description: 'Runs order fulfillment',
  tags: ['orders'],
}).execute(orderWorkflow);

export const onboard = workflow({ name: 'onboard', version: '1.0.0' }).execute(onboardWorkflow);

export default {
  order,
  onboard,
};
```

**Verdicts:**

- **Safe**: All stored workflow versions match registered versions.
- **Unsafe**: Version mismatches exist. Do not deploy until active workflows are
  resolved or the registered versions match the stored versions.

`version:check` reports safe or unsafe only. Weft no longer exposes a
`needs-migration` verdict or a checkpoint migration hook; mismatched active
workflows must be drained, cancelled, repaired, or served by code with the stored
version before the new workflow version recovers them.

### schedule

Manage durable schedules.

```bash
weft schedule list --database ./weft.db
weft schedule create my-workflow "0 * * * *" --database ./weft.db --workflows ./src/workflows.ts
weft schedule create my-workflow --every 1h --database ./weft.db --workflows ./src/workflows.ts
weft schedule create my-workflow "0 * * * *" --jitter 30s --database ./weft.db --workflows ./src/workflows.ts
weft schedule pause <schedule-id> --database ./weft.db
weft schedule resume <schedule-id> --database ./weft.db
weft schedule cancel <schedule-id> --database ./weft.db
```

A schedule fires either on a cron cadence (the positional cron expression) or at a fixed interval (`--every`), but not both. Interval schedules fire one period after creation, then every period after that, and reuse the same overlap and backfill machinery as cron schedules. Without `--backfill`, a timer that is more than one second late is skipped and recorded on the schedule as `missedFireCount` and `lastMissedFireAt`.

Use `--jitter` to spread schedules that share the same cadence. Weft stores `nextFireAt` as the nominal pre-jitter occurrence and derives a deterministic offset in `[0, jitter)` from the schedule ID and nominal fire time when it writes the dispatch timer.

**Options:**

| Flag          | Short | Default     | Description                                                                                       |
| ------------- | ----- | ----------- | ------------------------------------------------------------------------------------------------- |
| `--database`  | `-d`  | `./weft.db` | SQLite database file path                                                                         |
| `--storage`   | `-s`  | `sqlite`    | Storage backend: `sqlite` or `lmdb`                                                               |
| `--workflows` | `-w`  |             | Workflow registration module, required for create                                                 |
| `--every`     |       |             | Interval cadence for create (e.g. `30s`, `5m`, `1h`); mutually exclusive with the cron positional |
| `--input`     |       | `null`      | JSON input payload for create                                                                     |
| `--id`        |       |             | Custom schedule ID for create                                                                     |
| `--overlap`   |       |             | Overlap policy: `skip`, `queue`, `cancel-running`, or `allow`                                     |
| `--backfill`  |       | `false`     | Run missed ticks on recovery instead of skipping timers more than one second late                 |
| `--jitter`    |       |             | Deterministic dispatch jitter for create (e.g. `30s`, `5m`)                                       |
| `--json`      | `-j`  | `false`     | Output as JSON                                                                                    |
| `--help`      | `-h`  |             | Show help message                                                                                 |

### server

Inspect a running server over HTTP. These commands target a server (via `--server`, the `WEFT_ADDR` environment variable, a `--profile`, or the run lockfile written by `weft serve`) rather than a local database file.

```bash
weft server health --server http://localhost:7233
weft server health --wait --wait-timeout 60000   # block until the server is up (deploy scripts)
weft server info --json
```

`health` probes `GET /v1/health` and maps reachability to the exit code: `0` healthy, `1` unreachable, `2` connection error. `--wait` polls until the server responds or the timeout elapses, which deploy scripts use to gate on readiness. `info` additionally reports how many operations the server advertises in its `/openrpc.json` document that this CLI's bundled catalog does not know about, surfaced as "N additional operations available via weft api" so a newer server's surface is discoverable.

**Options:**

| Flag             | Short | Default | Description                                          |
| ---------------- | ----- | ------- | ---------------------------------------------------- |
| `--server`       |       |         | Server URL (default: `WEFT_ADDR`, profile, lockfile) |
| `--token`        |       |         | Bearer token (default: `WEFT_TOKEN`)                 |
| `--profile`      |       |         | Profile from `~/.weft/config`                        |
| `--wait`         |       | `false` | (`health`) Poll until the server is reachable        |
| `--wait-timeout` |       | `30000` | (`health`) Maximum wait, in milliseconds             |
| `--json`         | `-j`  | `false` | Emit machine-readable JSON                           |
| `--quiet`        | `-q`  | `false` | Suppress success/error text (use the exit code)      |
| `--help`         | `-h`  |         | Show help message                                    |

### workflow

List, inspect, start, signal, and cancel workflows on a running server. Every action routes through the generated typed operation client, so the command surface can never reference an operation the catalog does not define.

```bash
weft workflow ls --status running --limit 20
weft workflow get <workflow-id> --json
weft workflow events <workflow-id>
weft workflow start checkout --input '{"cart":"abc"}' --id order-123
weft workflow signal <workflow-id> approve --input 'true'
weft workflow cancel <workflow-id> --yes
weft workflow cancel <workflow-id> --dry-run
```

On a TTY, lists render as a table and single objects as indented JSON; `--json` emits NDJSON for lists (one object per line) and a single JSON object otherwise. The destructive `cancel` prompts for confirmation on a TTY (default No), is bypassed by `--yes`, prints the affected count under `--dry-run`, and on a non-interactive shell without `--yes` exits `1` without cancelling anything.

**Options:**

| Flag           | Short | Default | Description                                           |
| -------------- | ----- | ------- | ----------------------------------------------------- |
| `--server`     |       |         | Server URL (default: `WEFT_ADDR`, profile, lockfile)  |
| `--token`      |       |         | Bearer token (default: `WEFT_TOKEN`)                  |
| `--profile`    |       |         | Profile from `~/.weft/config`                         |
| `--type`       |       |         | (`ls`) Filter by workflow type                        |
| `--status`     |       |         | (`ls`) Filter by workflow status                      |
| `--limit`      |       |         | (`ls`) Maximum number of rows                         |
| `--input`      |       |         | (`start`/`signal`) JSON input payload                 |
| `--input-file` |       |         | (`start`/`signal`) Read JSON input from a file or `-` |
| `--id`         |       |         | (`start`) Explicit workflow id                        |
| `--yes`        | `-y`  | `false` | (`cancel`) Confirm without prompting                  |
| `--dry-run`    |       | `false` | (`cancel`) Print affected count without cancelling    |
| `--json`       | `-j`  | `false` | Emit machine-readable output (NDJSON for lists)       |
| `--quiet`      | `-q`  | `false` | Print ids only / suppress success text                |
| `--help`       | `-h`  |         | Show help message                                     |

Exit codes follow the operate/inspect convention: `0` success, `1` operation failed or destructive op not confirmed, `2` connection error, `3` usage or input error, `4` operation unavailable on this server (version skew). Connection-configuration errors name the resolved URL source instead of falling back to an empty value when it came from a profile or run lockfile.

### tail

Stream a workflow's token events from the server's Server-Sent Events endpoint (`GET /v1/workflows/:id/sse`).

```bash
weft tail <workflow-id>
weft tail <workflow-id> --json
```

Each frame is printed as one line: a TTY-formatted event on a terminal, or a compact JSON object under `--json` (valid NDJSON). The stream ends on the server's `done` event or when you press Ctrl-C, which resolves cleanly with exit code `0`.

**Options:**

| Flag        | Short | Default | Description                                          |
| ----------- | ----- | ------- | ---------------------------------------------------- |
| `--server`  |       |         | Server URL (default: `WEFT_ADDR`, profile, lockfile) |
| `--token`   |       |         | Bearer token (default: `WEFT_TOKEN`)                 |
| `--profile` |       |         | Profile from `~/.weft/config`                        |
| `--json`    | `-j`  | `false` | Emit one JSON object per line (NDJSON)               |
| `--quiet`   | `-q`  | `false` | Do not echo events to stdout                         |
| `--help`    | `-h`  |         | Show help message                                    |

### completions

Generate or install a shell completion script for the `weft` CLI.

```bash
weft completions generate --shell zsh
weft completions install --shell fish
```

`generate` prints the script to stdout; pipe it into your shell configuration. `install` writes it to the conventional per-shell completion directory and prints the path plus any one-time activation step.

**Options:**

| Flag      | Short | Default | Description                                       |
| --------- | ----- | ------- | ------------------------------------------------- |
| `--shell` |       |         | Target shell: `zsh`, `bash`, or `fish` (required) |
| `--help`  | `-h`  |         | Show help message                                 |

### timeline

Show the execution timeline for a workflow.

```bash
weft timeline <workflow-id> --database ./weft.db
weft timeline <workflow-id> --step 3 --database ./weft.db
weft timeline <workflow-id> --diff 2 3 --database ./weft.db
```

**Options:**

| Flag         | Short | Default     | Description                                              |
| ------------ | ----- | ----------- | -------------------------------------------------------- |
| `--database` | `-d`  | `./weft.db` | SQLite database file path                                |
| `--step`     |       |             | Show replay details for one checkpoint step              |
| `--diff`     |       | `false`     | Diff two checkpoint steps supplied after the workflow ID |
| `--help`     | `-h`  |             | Show help message                                        |

The timeline is a durable checkpoint-oriented summary, not an activity-attempt audit log. An
activity that retries appears as separate failed activity, retry-backoff sleep, and later activity
entries because each operation crosses its own durable boundary. Those entries deliberately do not
carry an explicit attempt number or grouping identifier, a snapshot of the effective retry policy,
or heartbeat payloads. Heartbeat details remain best-effort, in-process activity state and are never
retained by the timeline; persist an application cursor when progress must survive a restart.

Coordinator entries expose bounded metadata for their direct work without copying branch inputs or
results. `ctx.all()` and `ctx.runAll()` branches report `fulfilled` or `rejected`; `ctx.race()` reports
the first-settled branch as `won` and the others as `lost`. `lost` does not claim that an activity
stopped: race cancellation is cooperative. `ctx.speculate()` instead exposes its ordered direct
children and whether its child context was `committed` or `rolled-back`. Per-branch durations are
omitted because a recovered fulfilled branch or a detached race loser has no truthful duration at
the coordinator's durable boundary. When a coordinator exceeds the detail bound, `branchesOmitted`
or `childrenOmitted` reports how many direct operations are not included.

### validate

Validate a workflow module for correctness before deployment.

```bash
weft validate ./src/workflows.ts
weft validate ./src/workflows.ts ./src/activities.ts --json
```

**Options:**

| Flag     | Short | Default | Description                                   |
| -------- | ----- | ------- | --------------------------------------------- |
| `--json` | `-j`  | `false` | Output as JSON instead of human-readable text |
| `--help` | `-h`  |         | Show help message                             |

**Arguments:**

| Argument        | Description                                                                            |
| --------------- | -------------------------------------------------------------------------------------- |
| `<entry.ts>...` | One or more TypeScript modules or glob patterns containing workflow/activity metadata. |

## Programmatic API

Both diagnostic commands are available as library functions:

```typescript
import {
  collectDiagnostics,
  runVersionCheck,
  formatDiagnosticReport,
  formatVersionCheckReport,
} from '@lostgradient/weft';
```

See the TypeScript types for `DiagnosticReport` and `VersionCheckReport` for the full data model.
