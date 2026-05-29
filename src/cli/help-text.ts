export const HELP_TEXT = `
weft - Bun-native durable execution engine

Usage: weft [command] [options]

Commands:
  serve           Start the Weft server (default)
  doctor          Run diagnostics on the Weft database
  conformance     Run RemoteWorker protocol conformance checks
  schedule        Manage recurring schedules
  timeline        Inspect workflow timeline and replay history
  version:check   Check workflow version compatibility
  validate        Lint workflow registrations for design-time anti-patterns
  codegen         Generate TypeScript declarations from a registry snapshot
  api             Inspect and invoke catalog operations on a running server

Serve Options:
  -p, --port <port>           Server port (default: 7233)
  -d, --database <path>       Database file path (default: ./weft.db)
  -s, --storage <backend>     Storage backend: sqlite, lmdb, memory (default: sqlite)
  -w, --workflows <path>      Path to workflow module to register on startup
      --no-ui                 Disable the dashboard UI
  -h, --help                  Show this help message
`;

export const API_HELP_TEXT = `
weft api - Inspect and invoke catalog operations on a running server

Usage:
  weft api --list [options]
  weft api --describe <operation-name> [options]
  weft api <operation-name> [--input <json> | --input-file <path|->] [options]

Options:
      --server <url>       Server URL (default: WEFT_ADDR, profile, run lockfile, or localhost)
      --token <token>      Bearer token (default: WEFT_TOKEN)
      --profile <name>     Profile from ~/.weft/config (default: WEFT_PROFILE or default_profile)
      --input <json>       JSON object input for the operation
      --input-file <path>  Read JSON object input from a file, or '-' for stdin
      --list               List catalog operations
      --describe <name>    Print one operation's schema and metadata
      --yes                Confirm destructive operations without prompting
  -j, --json               Emit machine-readable JSON output
  -h, --help               Show this help message

Exit codes:
  0   Success
  1   Operation failed or destructive operation was not confirmed
  2   Connection error
  3   Usage or input validation error
`;

export const CONFORMANCE_HELP_TEXT = `
weft conformance - Run RemoteWorker protocol conformance checks

Usage: weft conformance [options] -- <worker-command> [args...]

The worker command receives:
  WEFT_WORKER_URL
  WEFT_WORKER_QUEUE
  WEFT_WORKER_ACTIVITIES
  WEFT_WORKER_PROTOCOL_VERSION

Options:
      --timeout <ms>       Per-check timeout in milliseconds (default: 15000)
  -j, --json               Output results as JSON
  -h, --help               Show this help message
`;

export const DOCTOR_HELP_TEXT = `
weft doctor - Run diagnostics on the Weft database

Usage: weft doctor [options]

Options:
  -d, --database <path>   Database file path (default: ./weft.db)
  -j, --json              Output results as JSON
  -h, --help              Show this help message
`;

export const VERSION_CHECK_HELP_TEXT = `
weft version:check - Check workflow version compatibility

Usage: weft version:check [options]

Options:
  -d, --database <path>     Database file path (default: ./weft.db)
  -w, --workflows <path>    Path to workflows module
  -j, --json                Output results as JSON
  -h, --help                Show this help message
`;

export const TIMELINE_HELP_TEXT = `
weft timeline - Inspect workflow timeline and replay history

Usage:
  weft timeline <workflowId> [options]
  weft timeline <workflowId> --diff <fromStep> <toStep> [options]

Options:
  -d, --database <path>     Database file path (default: ./weft.db)
      --step <step>         Show replay details for one checkpoint step
      --diff                Diff two checkpoint steps (requires two positional step numbers)
  -h, --help                Show this help message
`;

export const SCHEDULE_HELP_TEXT = `
weft schedule - Manage recurring schedules

Usage:
  weft schedule list [options]
  weft schedule create <workflowType> <cronExpression> [options]
  weft schedule create <workflowType> --every <duration> [options]
  weft schedule pause <scheduleId> [options]
  weft schedule resume <scheduleId> [options]
  weft schedule cancel <scheduleId> [options]

Provide a cron expression positional OR an --every interval (e.g. "30s", "1h"),
but not both. Interval schedules fire one period after creation, then every
period after that.

Options:
  -d, --database <path>     Database file path (default: ./weft.db)
  -s, --storage <backend>   Storage backend: sqlite, lmdb (default: sqlite)
  -w, --workflows <path>    Path to workflow registrations module (required for create)
      --every <duration>    Interval cadence for create (e.g. 30s, 5m, 1h); mutually exclusive with the cron positional
      --input <json>        JSON input payload for create (default: null)
      --id <id>             Custom schedule id for create
      --overlap <policy>    Overlap policy: skip, queue, cancel-running, allow
      --backfill            Run missed ticks on recovery
  -j, --json                Output results as JSON
  -h, --help                Show this help message
`;

export const VALIDATE_HELP_TEXT = `
weft validate - Lint workflow registrations for design-time anti-patterns

Usage: weft validate <entry.ts>... [options]

Arguments:
  <entry.ts>...           One or more TypeScript modules or glob patterns that
                          resolve to workflow registrations and/or activity
                          definitions.

Options:
  -j, --json              Output results as JSON
  -h, --help              Show this help message

Exit codes:
  0   No errors (warnings may be present)
  1   One or more errors detected
  2   Entry file could not be loaded (takes precedence over validation errors)

JSON output:
  { entries, valid, hasLoadErrors, hasValidationErrors }

Checks performed:
  unbounded-retry               Activity retry.maxAttempts is Infinity
  stateful-without-compensator  Non-idempotent activity has no compensate fn
`;

export const CODEGEN_HELP_TEXT = `
weft codegen - Generate TypeScript declarations from a registry snapshot

Usage:
  weft codegen --server <url> --out <file> [options]
  weft codegen --from <path> --out <file> [options]

Reads a Weft registry snapshot (live HTTP fetch or a vendored JSON file) and
emits a single deterministic .d.ts that augments the public 'weft' module
with typed entries for every registered workflow and activity. Subsequent
runs with unchanged input do not rewrite the output file.

Options:
      --server <url>     Base URL of a running Weft server. The CLI appends
                         /v1/registry to whatever path you supply, so
                         http://host/base becomes http://host/base/v1/registry
      --from <path>      Read the registry snapshot from a local JSON file
      --token <token>    Bearer token sent as Authorization header. Requires
                         --server. Falls back to the WEFT_TOKEN environment
                         variable when --token is not provided. A persistent
                         credentials file is not supported in this version
  -o, --out <file>       Output .d.ts path. Parent directory must already exist
      --timeout <ms>     Network timeout in milliseconds (default: 30000;
                         must be a positive integer)
  -j, --json             Emit a single JSON object on stdout for machine
                         consumers; errors become {"ok":false,"error":...}
                         on stderr
  -h, --help             Show this help message

Exit codes:
  0   Success or no changes needed (file is up to date)
  1   Validation, network, or filesystem error (no partial output written)
`;
