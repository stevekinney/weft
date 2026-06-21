---
name: documentation-refresh
description: >-
  Use this skill when refreshing Weft public documentation, AGENTS.md,
  CLAUDE.md, or mirrored skills from recent pull requests.
---

# Documentation Refresh

## When to use

- A task asks to review recent pull requests and update documentation.
- Public documentation, agent guidance, and mirrored skills must stay aligned.
- A documentation-only pull request needs evidence grounded in merged code or review feedback.

## Workflow

1. Start from the requested pull request window. If an earlier documentation refresh already covered part of the window, treat that refresh as the lower bound instead of documenting the same behavior twice.
2. Gather evidence before editing: pull request titles, bodies, changed files, review comments, and verification commands. Prefer merged pull requests; do not document open pull request behavior as shipped.
3. Map behavior changes to the right surface. User-facing runtime behavior belongs in `README.md` or `documentation/**`; agent workflow lessons belong in `AGENTS.md`, `CLAUDE.md`, `.agents/skills/**`, and `.claude/skills/**`.
4. Keep each update anchored to exact contracts, commands, and file paths. Avoid generic advice that could apply to any repository.
5. Mirror skill changes between `.agents/skills` and `.claude/skills` when the same workflow applies to both agent surfaces.
6. In the pull request body, include an evidence section that names the source pull requests and the contracts or workflows documented.

## Verification

Run the documentation gates that match the edited surfaces:

```bash
bun run format
bun run verify:documentation
bun run verify:markdown-doctests
bun run typecheck
bun run validate
```

Run `bun run verify:jsdoc:doctests` when public JSDoc examples change. Run `bun run scripts/check-type-ergonomics.ts` when type-shape documentation or declaration examples change.
