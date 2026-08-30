# Handoff: Weft UI — workflow console UI (Cinder design system)

## Overview
Weft is a Temporal-style durable-workflow engine; this package covers the design for its operator console: the full console shell (dashboard, workflow list, run detail, schedules, workers, reviews, system health) plus eight new/changed surfaces (live-connection indicator, schedule builder, workflow lineage, notification center, alerts view, linked selection across Timeline/Events/Logs, coordination & saga branch cards, export + conformance) and a shared pattern library.

## About the design files
The `.dc.html` files in this bundle are **design references created in HTML**—prototypes showing intended look and behavior, not production code to copy directly. Recreate these designs in the target codebase's existing environment using its established patterns and libraries. In Weft UI, `package.json` is live Cinder version truth and currently pins `@lostgradient/cinder` v0.24.0. Verify APIs against the installed package's supported public entrypoints and package documentation. The version-specific component inventory below is a historical authoring snapshot, not a current implementation contract. The token CSS in `tokens/` remains framework-agnostic.

Note: the `.dc.html` files reference a runtime (`support.js`) and a bundled component recreation (`_ds/...`) that are not included — open them in the original design project to see them live. Use the files here as **source-of-truth markup and styling reference** (all styles are inline; every value is literal or a `var(--cinder-*)` token defined in `tokens/`).

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii, shadows, copy, and states are final. Recreate pixel-perfectly using Cinder components/tokens. Data shown is representative mock data.

## Design system — binding rules
- **Cinder visual contract**: preserve the historical v0.16.x handoff's indigo (`oklch(50% 0.22 270)` light / `oklch(72% 0.14 270)` dark) on cool blue-grey neutrals (hue 245). This is a binding visual requirement, not a live API baseline. Use a 14px base size, platform `system-ui` + `ui-monospace` stacks, Lucide icons at 1.5–1.6px stroke sized 10–17px inline, sentence case, no emoji, `…` for in-progress, and `·` for metadata separators.
- **Theming**: every color is OKLCH in `light-dark()`, keyed off `color-scheme` / `data-theme="light|dark"`. All surfaces shown in both themes in the mocks; implement with the tokens, never hard-coded per-theme values.
- **Elevation**: `bg → surface → surface-raised → surface-inset` ladder; 1px `--cinder-border` does structural separation; shadows are subtle (`--cinder-shadow-sm/md/lg`).
- **Status is never color alone** — always icon + text.
- Full token values: `tokens/colors.css`, `tokens/typography.css`, `tokens/spacing.css`, `tokens/motion.css`.

## Historical Cinder component inventory

Use the library rather than hand-rolling these surfaces, but verify current props and exports through public entrypoints before implementation.

- **ConnectionIndicator** (historical 0.10.0 snapshot): every live/polling/stale transport pill in all three files. Six states: `connecting | live | reconnecting (attempt slot) | polling | stale | closed`. Polling is deliberately quieter than live (no dot, no motion) so staleness is never mistaken for push.
- **ScheduleBuilder** (historical 0.10.0 snapshot): schedule creation cadence control (Console → Create schedule; New Surfaces §A). Presets/Cron/Interval tablist, lossless mode switching, plain-English summary, injected `computeNextFires(value, count)` preview (consumer supplies real date math—the implementer's job), timezone label slot. Emits `{ mode: 'cron', expression } | { mode: 'interval', every, unit }`.
- **RunStepTimeline** (historical 0.10.0–0.12.x snapshot): run detail timeline and New Surfaces §F: `kind:'branch'` groups with won/lost/settled lanes (winner emphasized, losers muted), per-step `rewound: true` (struck-through, inspectable), `compensates: '<forwardStepId>'` (inset beneath forward step with dashed reversal connector), `children` lanes, `waiting_approval`, `attemptCount`, `link`.
- Also: Badge, StatusDot, Button, Input/Select/Checkbox/Switch, Alert, Card, Kbd, FacetedFilterBar, EventStreamViewer, PayloadInspector, ApprovalCard, Meter, ActionRow/SelectableRow.

## Screens (file → surfaces)

### `Weft UI.dc.html` — full console shell
Left nav (240px, `surface` bg, badge counts) + topbar (⌘K search, scopes pill, env switcher) + content. Screens are switched by nav state:
- **Dashboard** — stat cards, schedule health card, recent-activity feed (live via ConnectionIndicator).
- **Workflow list** — faceted filter bar, dense table (grid `110px 1fr 150px 170px 90px 90px 70px 60px`), status badges, bulk-select, live toolbar pill.
- **Run detail** — header with status/actions, tabs (Overview · Timeline · Events · Logs · Payload · Pending); Events tab has live pill + type filter + 847-event table.
- **Schedules** — list (paused/active/cancelled badges, cadence, next/last fire, missed-fires warning), detail (spec dl + next-5-fires + current/queued runs), **create/edit page** (name/ID, workflow picker, **ScheduleBuilder** for cadence, overlap policy radio cards Skip/Queue/Cancel-running with consequence copy, backfill warning callout, start-paused).
- **Workers, Reviews, Definitions, System** (health/discovery/catalog/scopes) — see file.

### `Weft New Surfaces.dc.html` — new & changed surfaces (each framed light + dark)
0. **ConnectionIndicator** — 6-state matrix + in-context (list header, engine pills, tab dots).
A. **ScheduleBuilder** — three live mode mounts + a cron validation-error spec card (per-field `aria-invalid`, error copy "Day of week must be 0–6 or SUN–SAT.", summary and preview suppressed until valid).
A2. **Create-schedule slide-over** — 440px right panel over scrim: name/workflow, embedded builder, overlap policy radios with consequences, jitter, start-paused switch, backfill range with enqueue-count warning; footer service-account note + actions. Missing-permission state: primary button **disabled, never hidden**, with "Requires schedules:write" tooltip pill.
B. **Workflow lineage** (Overview tab panel, 680px) — schedule provenance row; continuation chain chips (Previous run → This run → No successor; `white-space:nowrap`, chips never wrap internally); forked-from row; child-workflow tree. IDs truncated `first8…last4`, full value on hover `title`, copy icon; names — never IDs — are link labels.
C. **Notification center** — bell + count badge; dropdown grouped Critical/Warning/Info (unread heavier; read at 0.65 opacity); footer live pill + "Open alerts view →". Critical strip below header (danger triple, dismissible). Toasts: high urgency `role="alert"` (danger left edge, persists) vs normal `role="status"` (auto-dismiss 6s). ~32 event kinds → 3 tiers: critical → strip + toast, warning → toast, info → bell only. Every item deep-links.
D. **Alerts view** — since-page-load collection (not persistent history — say so in UI copy), severity edge + Firing/Resolved badges, resolved rows dim to 0.6; empty state links to Diagnostics.
E. **Linked selection** — selecting a Timeline step tints it indigo (`color-mix(in oklch, var(--cinder-accent), transparent 90%)`), filters Events + Logs; matching rows get indigo left edge + accent tint, non-matching dim to 0.45; filter chips removable; works in either direction; Clear restores. Event rows are flush (no per-row radius).
F. **Branch & saga cards** — RunStepTimeline with race branch group, rewound speculate children, `compensates` rollback; plus two run-level badges: **Finalizing** (warning) and **Cancelled — cleanup failed** (danger); finalizer step strip (Weft concept, custom section under the timeline).
G/H. **Export & conformance** — Events Download menu (Event history · JSON / Events + timeline · JSON); conformance panel is CLI-only (copyable `weft conformance --engine …` command), link not trigger.

### `Weft Patterns.dc.html` — shared patterns
Status badge system, payload editor, search-attribute query builder, confirmation tiers, fault banner (six fault codes), empty/onboarding states, live indicator (ConnectionIndicator), workflow flows (start wizard, replay, fork, async completion), aggregate triage.

## Interactions & behavior
- Motion: 120–200ms, `cubic-bezier(0.2, 0, 0, 1)`; hover shifts background, press darkens; all 0ms under `prefers-reduced-motion`. Live dots pulse at 2s ease-in-out.
- Permission-gated actions: disabled with a reason pill, never hidden.
- Linked selection is bidirectional and clearable; state = `{ selectedStepId: string | null }` shared by three panels.
- Notifications: severity → tier mapping above; unread count on bell; "Mark all read".
- ScheduleBuilder: mode switching never emits by itself; only committed edits emit; preview recomputes via injected callback.
- IDs everywhere: truncate `first8…last4`, hover for full, click-to-copy.

## State management (minimum)
- Nav/screen state; run-detail tab; selected schedule; linked-selection step id; notification list + read state; alert list (session-scoped); connection status per stream (drives ConnectionIndicator); schedule-form draft (`ScheduleValue` + overlap/jitter/backfill/paused).
- Data: workflow list (paged, live-updating), run event history (append-only stream with reconnect-replay), schedules with computed next fires, worker pools.

## Assets
None. Icons are Lucide (via library package, not CDN, in production). No images or webfonts.

## Files
- `Weft UI.dc.html` — full console shell (all screens)
- `Weft New Surfaces.dc.html` — the eight new/changed surfaces, light + dark
- `Weft Patterns.dc.html` — shared pattern library
- `tokens/*.css` — Cinder design tokens (colors, typography, spacing/radii/shadows, motion)
