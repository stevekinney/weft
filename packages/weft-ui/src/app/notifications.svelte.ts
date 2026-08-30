/**
 * Notification center store (plan `design/Weft New Surfaces.dc.html` §C,
 * `design/README.md` "Notification center", §13 T1.6). Fed by the shell's
 * shared `FleetEventSource` (`src/app/engine-status.svelte.ts` owns opening
 * that connection); this module owns turning each of the 31 client-visible
 * fleet event kinds (`EVENTS_READ_EVENT_TYPES`,
 * `weft/src/server/runtime/client-visible-events.ts`, v0.11.0) into a
 * severity tier, human copy, and a deep link.
 *
 * ## Severity mapping — a documented design decision, not a wire contract
 *
 * The design reference shows example items for exactly 8 of the 31 kinds
 * (`design/Weft New Surfaces.dc.html` §C's `notifCritical`/`notifWarning`/
 * `notifInfo` arrays) — not an exhaustive kind → tier table. Those 8 are
 * matched here verbatim; the remaining 23 follow one explicit principle so
 * the mapping isn't arbitrary:
 *
 *   - `critical` (strip + toast, persists, `role="alert"`) — an engine-wide
 *     incident with no natural owning surface: a firing alert, a
 *     dead-lettered task.
 *   - `warning` (toast, auto-dismiss 6s) — a notable but scoped bad outcome:
 *     a workflow/activity failure, a missed schedule fire, a constraint
 *     violation, a size/health warning, a worker dropping off the fleet.
 *   - `info` (bell only) — routine lifecycle: started/completed/resumed,
 *     signals, updates, attribute changes, a schedule firing normally, a
 *     review completing, a worker reconnecting.
 *
 * `design/Weft Patterns.dc.html`'s alerts-view mock separately colors
 * `constraint:violated` as `danger`, which would make it `critical` here —
 * that mock is a different screen (session-scoped Alerts view, §9.7) using
 * `Firing`/`Resolved` semantics, not the notification center's 3-tier
 * severity; the two are not required to agree, and this module follows the
 * notification-center mock (`notifWarning`) since that is the surface this
 * module feeds.
 */
import type { FleetEventFrame } from '../lib/live-source/fleet-event-source.svelte.ts';

export type NotificationTier = 'critical' | 'warning' | 'info';

export interface NotificationItem {
  readonly id: string;
  readonly tier: NotificationTier;
  readonly icon: string;
  readonly title: string;
  readonly body: string;
  /** Deep link path (router-relative), per design README: "Every item deep-links." */
  readonly href: string;
  readonly emittedAtMs: number;
  read: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(payload: unknown, key: string): string | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(payload: unknown, key: string): number | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `first8…last4` truncation (plan §10.8) for copy embedding an id inline. */
function truncateId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

interface NotificationRule {
  readonly tier: NotificationTier;
  readonly icon: string;
  readonly title: (frame: FleetEventFrame) => string;
  readonly body: (frame: FleetEventFrame) => string;
  readonly href: (frame: FleetEventFrame) => string;
}

function workflowBody(frame: FleetEventFrame, fallback: string): string {
  return frame.workflowId ? `Workflow ${truncateId(frame.workflowId)}` : fallback;
}

function workflowHref(frame: FleetEventFrame): string {
  return frame.workflowId ? `/workflows/${encodeURIComponent(frame.workflowId)}` : '/workflows';
}

/** Every client-visible fleet event kind mapped to its notification treatment. */
const NOTIFICATION_RULES: Readonly<Record<string, NotificationRule>> = {
  'alert:fired': {
    tier: 'critical',
    icon: 'siren',
    title: () => 'Alert fired',
    body: (frame) => stringField(frame.payload, 'name') ?? 'An alert condition is firing',
    href: () => '/system',
  },
  'task:dead-lettered': {
    tier: 'critical',
    icon: 'circle-x',
    title: (frame) =>
      `Task dead-lettered · ${stringField(frame.payload, 'activityName') ?? 'activity'}`,
    body: (frame) => workflowBody(frame, 'Retries exhausted'),
    href: workflowHref,
  },
  'schedule:missed-fire': {
    tier: 'warning',
    icon: 'calendar-x',
    title: () => 'Schedule missed fire',
    body: (frame) => {
      const missed = numberField(frame.payload, 'missedCount');
      return missed !== undefined
        ? `${missed} scheduled tick${missed === 1 ? '' : 's'} skipped`
        : 'A scheduled tick was skipped';
    },
    href: () => '/schedules',
  },
  'constraint:violated': {
    tier: 'warning',
    icon: 'shield-alert',
    title: (frame) =>
      `Constraint violated · ${stringField(frame.payload, 'constraint') ?? 'unnamed'}`,
    body: (frame) => workflowBody(frame, 'A workflow exceeded a configured constraint'),
    href: workflowHref,
  },
  'checkpoint:size-warning': {
    tier: 'warning',
    icon: 'database',
    title: () => 'Checkpoint size warning',
    body: (frame) => workflowBody(frame, 'A checkpoint is approaching the size limit'),
    href: workflowHref,
  },
  'human-review:requested': {
    tier: 'info',
    icon: 'user-check',
    title: (frame) =>
      `Human review requested · ${stringField(frame.payload, 'reviewType') ?? 'review'}`,
    body: (frame) => workflowBody(frame, 'Waiting on reviewers'),
    href: () => '/reviews',
  },
  'alert:resolved': {
    tier: 'info',
    icon: 'check-check',
    title: () => 'Alert resolved',
    body: (frame) => stringField(frame.payload, 'name') ?? 'A firing alert has resolved',
    href: () => '/system',
  },
  'worker:connected': {
    tier: 'info',
    icon: 'plug',
    title: () => 'Worker connected',
    body: (frame) => stringField(frame.payload, 'id') ?? 'A worker joined the fleet',
    href: () => '/workers',
  },
  'worker:disconnected': {
    tier: 'warning',
    icon: 'plug-zap',
    title: () => 'Worker disconnected',
    body: (frame) => stringField(frame.payload, 'id') ?? 'A worker left the fleet',
    href: () => '/workers',
  },
  'workflow:started': {
    tier: 'info',
    icon: 'play',
    title: () => 'Workflow started',
    body: (frame) => workflowBody(frame, 'A workflow started'),
    href: workflowHref,
  },
  'workflow:completed': {
    tier: 'info',
    icon: 'circle-check',
    title: () => 'Workflow completed',
    body: (frame) => workflowBody(frame, 'A workflow completed'),
    href: workflowHref,
  },
  'workflow:failed': {
    tier: 'warning',
    icon: 'circle-x',
    title: () => 'Workflow failed',
    body: (frame) => workflowBody(frame, 'A workflow failed'),
    href: workflowHref,
  },
  'workflow:cancelled': {
    tier: 'warning',
    icon: 'ban',
    title: () => 'Workflow cancelled',
    body: (frame) => workflowBody(frame, 'A workflow was cancelled'),
    href: workflowHref,
  },
  'workflow:timed-out': {
    tier: 'warning',
    icon: 'clock-alert',
    title: () => 'Workflow timed out',
    body: (frame) => workflowBody(frame, 'A workflow exceeded its execution deadline'),
    href: workflowHref,
  },
  'workflow:resumed': {
    tier: 'info',
    icon: 'play',
    title: () => 'Workflow resumed',
    body: (frame) => workflowBody(frame, 'A workflow resumed'),
    href: workflowHref,
  },
  'workflow:suspended': {
    tier: 'info',
    icon: 'pause',
    title: () => 'Workflow suspended',
    body: (frame) => workflowBody(frame, 'A workflow was suspended'),
    href: workflowHref,
  },
  'workflow:teardown': {
    tier: 'info',
    icon: 'trash-2',
    title: () => 'Workflow torn down',
    body: (frame) => workflowBody(frame, 'A finalizer ran for a terminal workflow'),
    href: workflowHref,
  },
  'activity:started': {
    tier: 'info',
    icon: 'play',
    title: (frame) =>
      `Activity started · ${stringField(frame.payload, 'activityName') ?? 'activity'}`,
    body: (frame) => workflowBody(frame, 'An activity started'),
    href: workflowHref,
  },
  'activity:completed': {
    tier: 'info',
    icon: 'circle-check',
    title: (frame) =>
      `Activity completed · ${stringField(frame.payload, 'activityName') ?? 'activity'}`,
    body: (frame) => workflowBody(frame, 'An activity completed'),
    href: workflowHref,
  },
  'activity:failed': {
    tier: 'warning',
    icon: 'circle-x',
    title: (frame) =>
      `Activity failed · ${stringField(frame.payload, 'activityName') ?? 'activity'}`,
    body: (frame) => workflowBody(frame, 'An activity failed'),
    href: workflowHref,
  },
  'activity:async-pending': {
    tier: 'info',
    icon: 'clock',
    title: (frame) =>
      `Awaiting external completion · ${stringField(frame.payload, 'activityName') ?? 'activity'}`,
    body: (frame) => workflowBody(frame, 'An activity is waiting on an external completion'),
    href: workflowHref,
  },
  'signal:received': {
    tier: 'info',
    icon: 'radio',
    title: (frame) => `Signal received · ${stringField(frame.payload, 'name') ?? 'signal'}`,
    body: (frame) => workflowBody(frame, 'A workflow received a signal'),
    href: workflowHref,
  },
  'signal:delivered': {
    tier: 'info',
    icon: 'radio',
    title: (frame) => `Signal delivered · ${stringField(frame.payload, 'name') ?? 'signal'}`,
    body: (frame) => workflowBody(frame, 'A queued signal was delivered'),
    href: workflowHref,
  },
  'attributes:changed': {
    tier: 'info',
    icon: 'tag',
    title: () => 'Attributes changed',
    body: (frame) => workflowBody(frame, 'A workflow updated its search attributes'),
    href: workflowHref,
  },
  'update:received': {
    tier: 'info',
    icon: 'pencil',
    title: (frame) => `Update received · ${stringField(frame.payload, 'name') ?? 'update'}`,
    body: (frame) => workflowBody(frame, 'A workflow received an update'),
    href: workflowHref,
  },
  'update:completed': {
    tier: 'info',
    icon: 'file-check',
    title: (frame) => `Update completed · ${stringField(frame.payload, 'name') ?? 'update'}`,
    body: (frame) => workflowBody(frame, 'A pending update settled'),
    href: workflowHref,
  },
  'schedule:fired': {
    tier: 'info',
    icon: 'calendar-clock',
    title: () => 'Schedule fired',
    body: (frame) => workflowBody(frame, 'A schedule launched a run'),
    href: workflowHref,
  },
  'development:warning': {
    tier: 'warning',
    icon: 'triangle-alert',
    title: () => 'Development warning',
    body: (frame) => stringField(frame.payload, 'message') ?? 'A development-mode diagnostic fired',
    href: () => '/system',
  },
  'cleanup:warning': {
    tier: 'warning',
    icon: 'triangle-alert',
    title: () => 'Cleanup warning',
    body: (frame) =>
      stringField(frame.payload, 'message') ?? 'A retention cleanup pass reported a warning',
    href: () => '/system',
  },
  'storage:size-reported': {
    tier: 'warning',
    icon: 'hard-drive',
    title: () => 'Storage size warning',
    body: (frame) =>
      stringField(frame.payload, 'message') ?? 'Storage usage crossed a reporting threshold',
    href: () => '/storage',
  },
  'human-review:completed': {
    tier: 'info',
    icon: 'circle-check',
    title: () => 'Review completed',
    body: (frame) => workflowBody(frame, 'A human review was decided'),
    href: () => '/reviews',
  },
};

const NOTIFICATION_HISTORY_LIMIT = 50;

/** Classifies one fleet frame into a `NotificationItem`, or `null` for a kind this module doesn't track (none today — every `EVENTS_READ_EVENT_TYPES` kind has a rule). */
export function classifyFleetEvent(
  frame: FleetEventFrame,
): Omit<NotificationItem, 'id' | 'read'> | null {
  const rule = NOTIFICATION_RULES[frame.kind];
  if (!rule) return null;
  return {
    tier: rule.tier,
    icon: rule.icon,
    title: rule.title(frame),
    body: rule.body(frame),
    href: rule.href(frame),
    emittedAtMs: frame.emittedAtMs,
  };
}

export class NotificationStore {
  items: NotificationItem[] = $state([]);

  get unreadCount(): number {
    return this.items.filter((item) => !item.read).length;
  }

  get critical(): NotificationItem[] {
    return this.items.filter((item) => item.tier === 'critical');
  }

  /** Unread critical items only — what the dismissible strip below the header shows. A dismissed (read) critical item leaves the strip but stays visible, dimmed, in the bell dropdown. */
  get criticalUnread(): NotificationItem[] {
    return this.items.filter((item) => item.tier === 'critical' && !item.read);
  }

  get warning(): NotificationItem[] {
    return this.items.filter((item) => item.tier === 'warning');
  }

  get info(): NotificationItem[] {
    return this.items.filter((item) => item.tier === 'info');
  }

  /** Appends a classified fleet frame to the top of the list, bounded to `NOTIFICATION_HISTORY_LIMIT`. Returns the new item, or `null` for an unmapped kind. */
  ingest(frame: FleetEventFrame): NotificationItem | null {
    const classified = classifyFleetEvent(frame);
    if (!classified) return null;
    const item: NotificationItem = { id: frame.cursor, read: false, ...classified };
    this.items = [item, ...this.items].slice(0, NOTIFICATION_HISTORY_LIMIT);
    return item;
  }

  markAllRead(): void {
    this.items = this.items.map((item) => (item.read ? item : { ...item, read: true }));
  }

  markRead(id: string): void {
    this.items = this.items.map((item) => (item.id === id ? { ...item, read: true } : item));
  }

  /** Dismisses one item from the critical strip without marking it read elsewhere in the dropdown — matches the design's "dismissible" strip while the bell dropdown keeps its own history. */
  dismissCritical(id: string): void {
    this.items = this.items.map((item) =>
      item.id === id && item.tier === 'critical' ? { ...item, read: true } : item,
    );
  }
}
