---
name: tasks
description: >-
  Use the `tasks` CLI when you need to inspect or update the local task graph for this project. The `tasks` CLI manages a local SQLite database of tasks, their relationships, and their lifecycle state. It also provides commands for synchronizing task state with Git branches and GitHub pull requests, recording incremental progress, and inspecting the current work in the context of the project.
disable-model-invocation: false
---

# Tasks CLI

Use the `tasks` CLI when you need to inspect or update the local task graph for this project.

## Rules

- Run commands from anywhere inside the project; the CLI resolves the Git root first and only then opens `tmp/tasks.db`.
- Data commands return JSON when they have output. Parse the JSON instead of scraping human-readable text.
- If `tasks next` prints nothing and exits 0, there is no available task; stop instead of treating that as an error.
- Use `tasks remaining` when you need a count of unfinished tasks, including tasks with future start dates.
- Run `tasks init` when the project has not been set up yet. It creates and migrates `tmp/tasks.db`, writes local task skills, and installs managed Scrumlord Lefthook jobs when a Lefthook configuration exists.
- Run `tasks setup status` before changing setup. It reports whether `tasks`, provider CLIs, skills, subagents, hooks, and `tmp/tasks.db` are present without creating the database.
- Use `tasks setup --yes` for the default full setup when the user wants Scrumlord initialized for installed providers. Use `tasks setup --codex` or `tasks setup --claude` only when the user wants that CLI launched after setup.
- Use `tasks setup-subagents` to install the `scrumlord-task-manager` subagent for installed providers. Use `tasks setup-subagents codex`, `tasks setup-subagents claude`, or `tasks setup-subagents --all` when a provider is explicit.
- Use `tasks --help` or `tasks <command> --help` when you need the current command syntax. Help output is colorized for humans; data output stays parseable JSON.
- Prefer `tasks available` or `tasks next` before choosing new work.
- Use `tasks list` before decomposing a long document or checklist so you can avoid duplicating existing tasks. Use `tasks list --all` only when archived or deleted tasks matter.
- Store the Git branch on tasks with `--branch` when work is branch-bound.
- Do not store worktree paths. Scrumlord derives the worktree from Git when it needs one.
- Use `tasks session $TASK_ID` before resuming or inspecting agent session state.
- If a task has a `plan`, read that plan file before taking on the task.
- If you generate a plan, write it to the task plan file and update the task with `tasks update $TASK_ID --plan <path>`.
- If you re-enter plan mode for a task, update the existing plan file or replace it with the new plan you generate.
- Do not edit `tmp/tasks.db` directly. Use the CLI so migrations, timestamps, and graph checks stay consistent.

## Branch-bound task auto-context

At the start of any session that may involve task work — and at minimum before answering "what am I working on?", planning, implementing, or opening a pull request — check whether the current Git branch is bound to a task and, if so, load that task's full context before doing anything else:

```bash
BRANCH="$(git branch --show-current)"
tasks with-branch "$BRANCH"
```

If the JSON result includes one or more tasks, the branch is task-bound. For each returned task:

1. Read the task record (subject, description, status, tags, blockers).
2. If `plan` is set and the file exists, read the plan file in full. A missing plan file means the task is unplanned — do not invent one without going through plan mode.
3. Run `tasks progress $TASK_ID` and read every prior entry. This is the durable working memory left by previous agents; resume from the most recent entry rather than restarting.
4. Run `tasks session $TASK_ID` if the task was started with `tasks start` so provider and session metadata is on hand.

Only after this context is loaded should you act on the user's request. If `tasks with-branch` returns an empty array, the branch is not task-bound — proceed normally without inventing a task association.

If the branch has multiple bound tasks, surface that to the user and ask which one is in scope before continuing; do not silently pick.

## Progress Tracking

Use `tasks add-progress` to record incremental progress on a task so a future agent picking up the work (after a context reset, crash, or handoff) can read what has already been done. Treat progress entries as the durable working memory for the task.

- Append a progress entry at every meaningful checkpoint: plan written, first failing test added, implementation milestone reached, blocker discovered, CI green, review feedback addressed. Aim for one entry per logical step — not one per command, and not just at the end.
- Always record progress before declaring sub-work complete and before any action that could end the session (PR opened, status change to `in-review` or `completed`, surfacing a blocker to the user).
- Use `tasks progress $TASK_ID` to read prior entries when resuming a task with `tasks resume` or after `tasks session` shows existing state. Read progress before re-planning.
- Keep entries short, factual, and oriented toward what the next agent needs: what is done, what is in flight, what is blocked, and where the relevant files or commits live. Reference commit SHAs, file paths, and PR numbers explicitly.
- `--provider` and `--session` are filled in from the task session metadata when omitted; pass them explicitly only when recording progress from outside the task's recorded session.

## Task Lifecycle

- When you begin work on a `ready` task, immediately move it to `in-progress` and record the branch:
  `tasks update $TASK_ID --status in-progress --branch "$(git branch --show-current)"`.
- When you open the pull request for that branch, move the task to `in-review`.
- When the pull request is merged into `origin/main`, move the task to `completed`.
- Prefer `tasks start $TASK_ID --cli codex` or `tasks start $TASK_ID --cli claude` when beginning an agent-owned task. It launches the provider with task context, starts in plan mode, and records provider/session metadata when the provider supports it.
- Use `tasks resume $TASK_ID` to resume a recorded Claude or Codex session from the derived worktree.
- Before changing status manually, run `tasks sync-git-status` if GitHub might already know the current pull request state.
- If `tasks setup-git-hooks` has been run in a repository with Lefthook, `tasks sync-git-status --quiet` handles lifecycle transitions from Git and GitHub state.
- If `tasks setup-agent-hooks` has been run, local Bun hooks try to keep plan, session, branch, and pull request lifecycle state synchronized. Hooks exit quietly when `tmp/tasks.db` or `tasks` is unavailable unless `SCRUMLORD_DEBUG` is truthy.
- Before merging, run `tasks pr status`. Only treat the pull request as merge-ready when `readyToMerge` is `true`.

## GitHub Review Workflow

- Use `tasks pr --url` to find the current branch pull request.
- Use `tasks pr status` for the complete readiness report: unresolved review comment IDs and URLs, pending checks, failed checks, and `readyToMerge`.
- Use `tasks overview` to inspect every open pull request for the project with CI status, unresolved review comment counts, and branch-associated tasks.
- Use `tasks comments` to inspect unresolved review comments before deciding what to fix.
- Use `tasks ci` to inspect pull request check status.
- If `tasks pr`, `tasks pr status`, `tasks overview`, `tasks comments`, or `tasks ci` fails with `gh_not_found`, install the GitHub CLI or continue with non-GitHub task commands.
- If a command fails with `pull_request_not_found`, open a pull request or keep the task in `in-progress`.
- If a command fails with `project_root_not_found`, move into the Git repository or npm workspace before retrying. Do not create or edit a database by hand.

## Useful Commands

```bash
tasks --help
tasks create --help
tasks init
tasks next
tasks list
tasks remaining
tasks with-branch "$(git branch --show-current)"
tasks session $TASK_ID
tasks start $TASK_ID --cli codex
tasks resume $TASK_ID
tasks progress $TASK_ID
tasks add-progress $TASK_ID --message "Plan written to tmp/plans/$TASK_ID.md"
tasks available
tasks blocked
tasks create --title "Write tests" --description "Add regression coverage" --priority 3
tasks update $TASK_ID --status in-progress --branch "$(git branch --show-current)"
tasks add-blocker $TASK_ID $BLOCKER_TASK_ID
tasks add-tag $TASK_ID testing
tasks sync-git-status --quiet
tasks pr --url
tasks pr status
tasks overview
tasks comments
tasks ci
tasks setup status
tasks setup --yes
tasks setup-subagents
tasks setup-agent-hooks
```
