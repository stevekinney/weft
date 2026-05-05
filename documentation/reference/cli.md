# CLI Reference

Weft provides a command-line interface for running the server and diagnosing database state.

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

| Flag         | Short | Default     | Description                                    |
| ------------ | ----- | ----------- | ---------------------------------------------- |
| `--port`     | `-p`  | `7233`      | Server port                                    |
| `--database` | `-d`  | `./weft.db` | SQLite database file path                      |
| `--storage`  | `-s`  | `sqlite`    | Storage backend: `sqlite`, `lmdb`, or `memory` |
| `--no-ui`    |       | `false`     | Disable the web dashboard                      |
| `--help`     | `-h`  |             | Show help message                              |

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

### version:check

Analyze registered workflow versions against an existing database to check deployment compatibility.

```bash
weft version:check --database ./weft.db --workflows ./src/workflows.ts
weft version:check --database ./weft.db --workflows ./src/workflows.ts --json
```

**Options:**

| Flag          | Short | Default     | Description                                     |
| ------------- | ----- | ----------- | ----------------------------------------------- |
| `--database`  | `-d`  | `./weft.db` | SQLite database file path                       |
| `--workflows` | `-w`  | (required)  | Path to module exporting workflow registrations |
| `--json`      | `-j`  | `false`     | Output as JSON instead of human-readable text   |
| `--help`      | `-h`  |             | Show help message                               |

The workflows module must default-export a `Record<string, WorkflowRegistration>`:

```typescript partial
import type { WorkflowRegistration } from 'weft';

export default {
  order: {
    version: '2.0.0',
    description: 'Runs order fulfillment',
    tags: ['orders'],
    handler: orderWorkflow,
    migrate: migrateOrder,
  },
  onboard: { version: '1.0.0', handler: onboardWorkflow },
} satisfies Record<string, WorkflowRegistration>;
```

**Verdicts:**

- **Safe**: All stored workflow versions match registered versions.
- **Needs migration**: Version mismatches exist, but all affected types provide migration functions.
- **Unsafe**: Version mismatches exist without migration functions. Do not deploy.

### schedule

Manage durable schedules.

```bash
weft schedule list --database ./weft.db
weft schedule create --database ./weft.db --type my-workflow --cron "0 * * * *"
weft schedule pause --database ./weft.db --id <schedule-id>
weft schedule unpause --database ./weft.db --id <schedule-id>
weft schedule delete --database ./weft.db --id <schedule-id>
```

**Options:**

| Flag         | Short | Default     | Description                            |
| ------------ | ----- | ----------- | -------------------------------------- |
| `--database` | `-d`  | `./weft.db` | SQLite database file path              |
| `--id`       |       |             | Schedule ID (for pause/unpause/delete) |
| `--type`     |       |             | Workflow type (for create)             |
| `--cron`     |       |             | Cron expression (for create)           |
| `--json`     | `-j`  | `false`     | Output as JSON                         |
| `--help`     | `-h`  |             | Show help message                      |

### timeline

Show the execution timeline for a workflow.

```bash
weft timeline --database ./weft.db --id <workflow-id>
```

**Options:**

| Flag         | Short | Default     | Description               |
| ------------ | ----- | ----------- | ------------------------- |
| `--database` | `-d`  | `./weft.db` | SQLite database file path |
| `--id`       |       | (required)  | Workflow ID to inspect    |
| `--json`     | `-j`  | `false`     | Output as JSON            |
| `--help`     | `-h`  |             | Show help message         |

### validate

Validate a workflows module for correctness before deployment.

```bash
weft validate --workflows ./src/workflows.ts
```

**Options:**

| Flag          | Short | Default    | Description                                     |
| ------------- | ----- | ---------- | ----------------------------------------------- |
| `--workflows` | `-w`  | (required) | Path to module exporting workflow registrations |
| `--json`      | `-j`  | `false`    | Output as JSON                                  |
| `--help`      | `-h`  |            | Show help message                               |

## Programmatic API

Both diagnostic commands are available as library functions:

```typescript
import {
  collectDiagnostics,
  runVersionCheck,
  formatDiagnosticReport,
  formatVersionCheckReport,
} from 'weft';
```

See the TypeScript types for `DiagnosticReport` and `VersionCheckReport` for the full data model.
