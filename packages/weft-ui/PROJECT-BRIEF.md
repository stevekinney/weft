# Weft Console — Agent Brief

You are implementing one slice of the Weft Console: the operator UI for the Weft durable-workflow
engine. Read this file completely before touching code. Then read:

1. `docs/implementation-plan.md` — the authoritative plan (locked decisions §1, component policy §7,
   surfaces §9, cross-cutting patterns §10, acceptance checklist Appendix B, API reference Appendix A).
2. `design/README.md` — the design handoff (binding visual rules, screen inventory, interaction spec).
3. The relevant sections of the `design/*.dc.html` files for YOUR surfaces. These are high-fidelity
   HTML design references: all styles inline, every value literal or a `var(--cinder-*)` token.
   They are large — use Grep to find your screen's markup rather than reading whole files.

## Hard rules (non-negotiable)

- **Repo root is `/Users/stevekinney/Developer/weft-console`.** Your shell cwd resets between Bash
  calls — always use absolute paths or `cd /Users/stevekinney/Developer/weft-console && …`.
- **Own your paths only.** Your task prompt names the directories you own. Never edit files outside
  them (shared files listed in your prompt are the only exception). Other agents work in parallel.
- **Do not run `git` at all.** The orchestrator commits at phase boundaries.
- **Cinder-first.** Every UI need uses the installed `@lostgradient/cinder` package when a
  component exists. Treat `package.json`, the installed package, and its supported public
  entrypoints as version and API truth. Cinder component entrypoints load their own styles. The
  base `@lostgradient/cinder/styles` import is already wired in the entry CSS; do not add a
  component style ledger. A documented transitive dependency may retain its specific stylesheet
  when the owning entrypoint does not bundle it.
  Key components that EXIST upstream (do not hand-roll): ConnectionIndicator, ScheduleBuilder,
  RunStepTimeline (branch groups, `rewound`, `compensates`, child lanes, waiting_approval),
  EventStreamViewer, FacetedFilterBar, PayloadInspector, SchemaForm, DataTable, ApprovalCard,
  PermissionMatrix, CommandPalette, ConfirmDialog, AlertDialog, StatusDot, Badge, Meter, Feed,
  EmptyState, Skeleton, Drawer, Steps, Tabs, SegmentedControl, DescriptionList, Stat/StatGroup,
  BarChart/LineChart/AreaChart, Tree, CopyButton, Tooltip, Banner, ToastRegion/useToast, Kbd.
- **Svelte 5 runes only** (`$state`/`$derived`/`$effect`/`$props`), snippets over slots, no SvelteKit,
  no legacy stores. Shared reactive logic in `.svelte.ts` modules.
- **TypeScript only**, kebab-case filenames, implementation files ≤500 lines, no `any` in production
  code, treat `as` casts as suspect.
- **Transport is `HttpClient`** from `@lostgradient/weft/client` via the app context (`src/lib/client.ts`).
  Ergonomic methods first, `client.operations['weft.<name>'](input)` for the rest. Never `fetch()` the
  API directly. API surface: plan Appendix A. Weft source ground truth (v0.15.0):
  `/Users/stevekinney/Developer/weft/src/` (read-only reference — e.g. `src/client/`, `src/server/routes/`).
- **TanStack Query** (`@tanstack/svelte-query`) owns server state; URL owns filter/pagination/tab
  state; runes own ephemeral UI state.
- **Design fidelity is the acceptance bar.** Colors/spacing/typography/copy come from the `.dc.html`
  references and `design/tokens/*.css` (already imported). Use Cinder tokens (`var(--cinder-*)`),
  never hard-coded per-theme colors; everything must work in light AND dark (`data-theme` +
  `light-dark()`). Status is never color alone (icon + text). Sentence case; `…` in-progress;
  `·` metadata separator; no emoji. IDs truncate `first8…last4` monospace, hover full, click-copy.
  Permission-gated actions are disabled-with-reason, never hidden.
- **Tests are required.** Pure logic in `src/lib/**` gets colocated `bun test` unit tests (no DOM).
  Components get tests with `bun test` + happy-dom + `@testing-library/svelte` where the harness
  supports it (see `tests/setup` wiring from the scaffold). Every state named for your surface in
  plan Appendix B should exist in code (empty/loading/denied/fault states included).
- **Before you finish**: run `cd /Users/stevekinney/Developer/weft-console && bun run typecheck && bun run lint && bun test`
  and fix everything yours. Do not skip/disable tests; do not bump timeouts; fix root causes.
- **Responsive is not optional.** The `.dc.html` references are desktop mocks; every surface you
  ship must also be correct at 375px (mobile) and 768px (tablet), verified by actually resizing.
  Binding rules: no page-level horizontal scroll ever — wide tables/timelines/code scroll inside
  their own `overflow-x:auto` container; grid/stat layouts use `repeat(auto-fit, minmax(…))` or
  collapse to one column; two-panel layouts (list+detail) stack vertically below 900px; the
  sidebar collapses to a drawer below 1024px with panel width `min(280px, 85vw)` — never
  full-bleed, no dead space, engine pill and badges intact; topbar condenses (icon-only ⌘K,
  overflow menu for secondary controls); drawers/slide-overs become full-width sheets ≤640px;
  interactive targets ≥40px on touch; test with the dev server at all three widths before
  reporting done. Density stays: this is an operator console, not a marketing site — compress
  chrome, never information hierarchy.
- **Cinder bugs/gaps get filed upstream, never patched locally.** If a Cinder component has a bug,
  a missing prop/state you need, a styling defect vs the design reference, or an a11y problem:
  do NOT fork, wrap-to-restyle, or monkey-patch it. File an issue instead:
  `gh issue create --repo stevekinney/cinder --title "…" --body "…"` with a minimal repro or spec
  and a pointer to the design reference. First run
  `gh issue list --repo stevekinney/cinder --search "<keywords>" --state all` to avoid duplicates.
  Then ship the console using the component as-is (degraded-but-correct) or a minimal app-local
  composition, and record the issue URL in your final report.

## Shared contracts (frozen after the Foundation phase)

- `src/lib/client.ts` — `getClient()` from Svelte context; runtime config from
  `<script type="application/json" id="weft-console-config">`.
- `src/lib/scopes.svelte.ts` — principal store, `hasScope(...scopes)`; disable-with-tooltip helpers.
- `src/lib/router.svelte.ts` — history-API router; `href()`/`navigate()`/`route` rune; routes under
  `/`, `/workflows`, `/workflows/*`, `/reviews`, `/workers` (+ client-side `/schedules`, `/storage`,
  `/system`).
- `src/lib/filters.ts` — typed ListFilter ↔ URLSearchParams serializer (REST grammar).
- `src/lib/live-source/` — `LiveSource<Frame>` interface + `WorkflowTailSource`, `FleetEventSource`,
  `PollingSource`; status rune consumed by ConnectionIndicator.
- `src/lib/faults.ts` — six-code fault → UI treatment mapping.
- `src/lib/format/` — id truncation, durations, bytes, relative time, cron preview (`computeNextFires`).
- `src/app/` — shell: sidebar, topbar, command palette, notification center, toasts, scope banner.
  Route content components mount via the shell's route registry (see `src/app/routes.ts`).
- Card-slot contract: dashboard cards live with their owning track under
  `src/routes/<domain>/cards/` and are registered in `src/routes/dashboard/cards.ts`.

## Dev harness

`bun run dev` = Vite dev server (port 5173) proxying `/api`, `/v1`, `/openapi.json`, `/openrpc.json`,
`/asyncapi.json`, `/.well-known` (+ WS) to a seeded local weft server (port 7233) started by
`bun run dev:server` (`scripts/dev-server.ts`, fixtures in `fixtures/workflows.ts`). Fixtures are
append-only — extend, never mutate existing ones other tracks assert against.
