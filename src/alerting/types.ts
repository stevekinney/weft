/**
 * What an alert rule does when its threshold is exceeded.
 *
 * `'log'` writes to the engine's console; `'webhook'` POSTs an
 * `alert:fired` or `alert:resolved` payload to the configured
 * {@link WebhookTarget} URLs.
 */
export type AlertAction = 'log' | 'webhook';

/** Runtime vocabulary shared by alerting types and operation schemas. */
export const ALERT_METRICS = [
  'workflow.failure_rate',
  'activity.p99_duration',
  'storage.size',
] as const;

/**
 * Which built-in metric an {@link AlertRule} monitors.
 *
 * - `'workflow.failure_rate'` — fraction of workflows that failed within the
 *   sliding window.
 * - `'activity.p99_duration'` — 99th-percentile activity execution duration in
 *   milliseconds.
 * - `'storage.size'` — total storage size in bytes as reported by the engine's
 *   `StorageSizeReported` event.
 *
 * @example
 * ```ts
 * import { type AlertMetric, type AlertRule } from '@lostgradient/weft';
 *
 * const metric: AlertMetric = 'workflow.failure_rate';
 * const rule: AlertRule = {
 *   metric,
 *   threshold: 0.1,
 *   window: '5m',
 *   action: 'log',
 * };
 * void rule;
 * ```
 */
export type AlertMetric = (typeof ALERT_METRICS)[number];

/**
 * Defines a single alerting threshold applied to a named metric.
 *
 * When the metric's current value in the sliding window exceeds `threshold`,
 * the configured `action` is triggered.  An optional `window` duration string
 * (e.g. `'5m'`, `'1m'`) controls how far back the evaluation looks; it defaults
 * to one minute when omitted.
 *
 * @example
 * ```ts
 * import { AlertManager, type AlertRule } from '@lostgradient/weft';
 *
 * const rule: AlertRule = {
 *   metric: 'workflow.failure_rate',
 *   threshold: 0.05,
 *   window: '10m',
 *   action: 'webhook',
 * };
 *
 * const engine = new EventTarget();
 * using manager = new AlertManager(engine, { rules: [rule] });
 * void manager;
 * ```
 */
export type AlertRule = {
  metric: AlertMetric;
  threshold: number;
  window?: string; // duration string like '5m', '1m' — parsed by parseDuration
  action: AlertAction;
};

/**
 * Webhook destination that receives `alert:fired` and `alert:resolved` HTTP
 * POST requests from the {@link AlertManager}.
 *
 * Specify which event types to subscribe to via the `events` array.  Both
 * `alert:fired` and `alert:resolved` are sent as JSON objects with the rule
 * and current metric value.
 *
 * @example
 * ```ts
 * import { AlertManager, type WebhookTarget, type AlertingOptions } from '@lostgradient/weft';
 *
 * const target: WebhookTarget = {
 *   url: 'https://hooks.example.com/alerts',
 *   events: ['alert:fired', 'alert:resolved'],
 * };
 *
 * const options: AlertingOptions = {
 *   rules: [{ metric: 'workflow.failure_rate', threshold: 0.1, action: 'webhook' }],
 *   webhooks: [target],
 * };
 * const engine = new EventTarget();
 * using manager = new AlertManager(engine, options);
 * void manager;
 * ```
 */
export type WebhookTarget = {
  url: string;
  events: Array<'alert:fired' | 'alert:resolved'>;
};

/**
 * Top-level alerting configuration passed to {@link AlertManager}.
 *
 * Provide an array of {@link AlertRule} definitions that the manager evaluates
 * continuously against the engine's event stream.  Optionally supply
 * {@link WebhookTarget} destinations for `alert:fired` and `alert:resolved`
 * notifications.
 *
 * @example
 * ```ts
 * import { AlertManager, type AlertingOptions } from '@lostgradient/weft';
 *
 * const options: AlertingOptions = {
 *   rules: [
 *     { metric: 'workflow.failure_rate', threshold: 0.1, window: '5m', action: 'log' },
 *     { metric: 'activity.p99_duration', threshold: 5000, action: 'webhook' },
 *   ],
 *   webhooks: [{ url: 'https://hooks.example.com', events: ['alert:fired'] }],
 * };
 * const engine = new EventTarget();
 * using manager = new AlertManager(engine, options);
 * void manager;
 * ```
 */
export type AlertingOptions = {
  rules: AlertRule[];
  webhooks?: WebhookTarget[];
};

/**
 * Whether an alert rule is currently quiet or actively firing.
 *
 * Transitions from `'idle'` to `'firing'` when the metric exceeds the
 * threshold and back to `'idle'` once the metric drops below it again.
 * Read this off an {@link AlertStateSnapshot} object to see the current state
 * of a rule.
 *
 * @example
 * ```ts
 * import { AlertManager, type AlertStatus } from '@lostgradient/weft';
 *
 * const engine = new EventTarget();
 * using manager = new AlertManager(engine, {
 *   rules: [{ metric: 'workflow.failure_rate', threshold: 0.05, action: 'log' }],
 * });
 * const states = manager.states;
 * const status: AlertStatus = states[0]?.status ?? 'idle';
 * console.log(status); // 'idle'
 * ```
 */
export type AlertStatus = 'idle' | 'firing';

/**
 * Detached, deeply read-only observation of a single alert rule's runtime
 * state. The manager returns a fresh snapshot for every getter call, so
 * changing it cannot affect alert evaluation.
 *
 * Users observe this shape via `AlertManager.states` or
 * `Engine.getActiveAlerts()` to see the current metric value, firing status,
 * and timestamps of the last transition.
 */
export type AlertStateSnapshot = {
  readonly rule: Readonly<AlertRule>;
  readonly status: AlertStatus;
  readonly currentValue: number;
  readonly lastFiredAt?: number;
  readonly lastResolvedAt?: number;
};
