# PR 6: CLI module split

## Moved modules

- `src/cli/types.ts`: CLI command, schedule command, storage backend, and command output types.
- `src/cli/help-text.ts`: top-level, doctor, version check, timeline, schedule, and validate help text constants.
- `src/cli/parse-arguments.ts`: command dispatch, serve parsing, diagnostic parsing, validation parsing, timeline parsing, and schedule parsing helpers.
- `src/cli/storage-factory.ts`: storage backend factory and memory storage helper.
- `src/cli/utilities.ts`: glob splitting, validation glob expansion, value formatting, and checkpoint diff collection.
- `src/cli/doctor.ts`: doctor command executor.
- `src/cli/version-check.ts`: workflow version compatibility command executor.
- `src/cli/validate.ts`: validation command executor and entry path expansion.
- `src/cli/timeline.ts`: timeline, replay, and diff command executor.
- `src/cli/schedule.ts`: schedule list, create, pause, resume, and cancel executor helpers.
- `src/cli/index.ts`: shebang-preserving CLI library barrel that re-exports the previous public surface.

## Removed suppressions

- `cli-build-schedule-create-command-complexity`
- `cli-execute-validate-complexity`
- `cli-file-length`
- `cli-parse-cli-arguments-complexity`
- `cli-parse-timeline-arguments-complexity`

## Compatibility notes

- `src/cli.ts` was deleted.
- Internal call sites now import from `src/cli/index.ts`.
- Binary build documentation now points at `src/cli-main.ts`, which remains the executable runner.
