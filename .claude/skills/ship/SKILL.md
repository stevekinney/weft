---
name: ship
description: >-
  Autonomous development loop that reads the architecture doc, picks the
  next body of work, implements it with TDD, opens a PR, monitors for
  reviews and CI, merges, and repeats. Use when the user says "ship",
  "start the development loop", "work through the architecture",
  "implement the next feature from the roadmap", or "keep building".
disable-model-invocation: true
---

> Monorepo note: all repository paths and commands in this skill are relative to `packages/weft/` unless a path explicitly starts with `packages/`.

Autonomous development loop: analyze the architecture, pick the next work, implement it, ship it, repeat.

## Phase 1: Analyze — What's Next?

Read `reference/architecture.md`, focusing on the **Acceptance Criteria Checklist** near the end of the document (look for lines starting with `- [ ]` and `- [x]`).

Cross-reference unchecked items against what already exists in `src/`. Some items may be partially implemented even if not checked off. Use grep/glob to verify.

Group the unchecked items into coherent bodies of work. A good unit of work is a section heading's worth of items (e.g., "Workflow Versioning", "Interceptors", "Resource Management") or a tightly coupled subset of items that make sense to ship together.

**Pick the next body of work** based on these priorities:

1. **Foundation first.** Core engine features before features that depend on them.
2. **Dependencies.** If item B requires item A, do A first.
3. **Parallelizable.** If two bodies of work are independent, note that they can be done in parallel.

If multiple independent bodies of work can proceed in parallel, use the Agent tool with `isolation: "worktree"` to run them concurrently. Each agent gets one body of work and follows phases 2-7 independently. Coordinate at the merge step.

State clearly what you're working on and why it's the right next thing.

## Phase 2: Branch

If you're not already on a fresh feature branch off `main`:

```bash
git checkout main
git pull origin main
git checkout -b <descriptive-branch-name>
```

Branch names should be descriptive: `feat/workflow-versioning`, `feat/interceptors`, `feat/resource-management`.

## Phase 3: Plan

Before writing any code, make a plan:

- Read the relevant sections of `reference/architecture.md` for the detailed design.
- Read the existing source files in the affected modules.
- Outline the implementation: which files to create/modify, which types to add, which tests to write.
- Identify public API changes (new exports in `src/index.ts` or secondary entrypoints).
- Consider storage backend implications and browser compatibility.

## Phase 4: Implement (TDD)

Follow the TDD workflow skill (`/skill tdd-workflow`):

1. **Red**: Write a failing test that describes the expected behavior from the architecture doc.
2. **Green**: Write the minimum code to make it pass.
3. **Refactor**: Clean up with passing tests as safety net.
4. Repeat for each acceptance criterion in the body of work.

Use `TestEngine`, `TimeControl`, and `ActivityMockRegistry` as appropriate. Reference the architecture doc's acceptance criteria as your test specifications — each `- [ ]` item should have at least one test.

## Phase 5: Security Review

Run through the security review skill (`/skill security-review`) for the sections relevant to your changes. Focus on:

- Input validation at new API boundaries
- No `any` types at trust boundaries
- Credentials not leaking into checkpoints, logs, or error messages
- Storage operations using safe patterns

## Phase 6: Verify

Run the verification loop skill (`/skill verification-loop`):

```bash
bun run build
bun run typecheck
bun run lint
bun test
```

Review the diff for `src/index.ts` changes and leftover debug code. Fix any issues before proceeding.

## Phase 7: Ship — Open a PR

Update the architecture doc to check off completed items:

```bash
# In reference/architecture.md, change completed items from:
# - [ ] Item description
# to:
# - [x] Item description
```

Stage all changes, commit, push, and open a PR:

```bash
git add <specific-files>
git commit -m "<conventional commit message>"
git push -u origin <branch-name>
draft_title="<concise sentence-case action title>"
normalized_title=$(bun run scripts/pr-title.ts normalize --title "$draft_title" | jq -r '.normalizedTitle // empty')
pr_title="${normalized_title:-$draft_title}"
bun run scripts/pr-title.ts validate --title "$pr_title"
gh pr create --title "$pr_title" --body "$(cat <<'EOF'
## Summary
<what was implemented and why>

## Acceptance Criteria Completed
<list the specific items from reference/architecture.md that are now checked off>

## Test Plan
<what tests were added and what they verify>
EOF
)"
created_title=$(gh pr view --json title --jq '.title')
test "$created_title" = "$pr_title"
```

PR title contract:

- Optional Linear prefix only when applicable: `ABC-123: `
- Then a concise sentence-case action title
- No branch slug prefix
- No Markdown or inline code formatting
- No conventional-commit prefixes like `feat:` or `fix:`
- No multi-sentence acceptance-criteria dump

## Phase 8: Monitor — Address Reviews, Wait for Green

After opening the PR, enter a monitoring loop:

1. **Check for review comments:**

   ```bash
   gh pr view <number> --json reviews,comments,reviewDecision
   gh api "repos/$(gh repo view --json owner,name --jq '.owner.login + "/" + .name')/pulls/<number>/comments"
   ```

2. **If there are unresolved review comments:** Address them. Push fixes. Return to step 1.

3. **Check CI status:**

   ```bash
   gh pr checks <number>
   ```

4. **If CI is failing:** Read the failure logs, fix the issue, push, return to step 1.

5. **If CI is green AND no unresolved review comments:** Wait 4 minutes (use `sleep 240`), then check one final time for any last-minute comments. If still clear, proceed to merge.

## Phase 9: Merge

```bash
gh pr merge <number> --squash --delete-branch
```

After merge, update local main:

```bash
git checkout main
git pull origin main
```

## Phase 10: Repeat

Go back to **Phase 1**. Re-read the architecture doc, find the next body of work, and continue the loop.

---

## Ground Rules

- **One PR per body of work.** Keep PRs focused and reviewable.
- **Every acceptance criterion gets a test.** The `- [ ]` items in the architecture doc are your test specifications.
- **Check off what you complete.** Update `reference/architecture.md` to mark items as `[x]` in the same PR.
- **Don't skip the verification loop.** Every PR must pass build, typecheck, lint, and tests before opening.
- **Respect the architecture doc.** It is the source of truth for the design. If you disagree with something in it, flag it rather than silently deviating.
- **Prefer depth over breadth.** Fully implement one section rather than partially implementing three.
