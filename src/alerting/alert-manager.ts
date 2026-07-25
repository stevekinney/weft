/**
 * Engine event-driven alert manager. Evaluates metric-based rules against
 * sliding time windows and dispatches alert:fired/alert:resolved events
 * with optional webhook notifications.
 *
 * @module alerting/alert-manager
 */

import {
  ActivityCompletedEvent,
  AlertFiredEvent,
  AlertResolvedEvent,
  StorageSizeReportedEvent,
} from '../core/events';
import { parseDuration } from '../core/scheduler';
import { CounterWindow, HistogramWindow } from './sliding-window';
import type { AlertRule, AlertStateSnapshot, AlertingOptions } from './types';

/** Periodic re-evaluation interval in milliseconds. */
const TICK_INTERVAL_MS = 10_000;

type MutableAlertState = {
  rule: AlertRule;
  status: AlertStateSnapshot['status'];
  currentValue: number;
  lastFiredAt?: number;
  lastResolvedAt?: number;
};

function snapshotAlertState(state: MutableAlertState): AlertStateSnapshot {
  return {
    rule: { ...state.rule },
    status: state.status,
    currentValue: state.currentValue,
    ...(state.lastFiredAt === undefined ? {} : { lastFiredAt: state.lastFiredAt }),
    ...(state.lastResolvedAt === undefined ? {} : { lastResolvedAt: state.lastResolvedAt }),
  };
}

/**
 * Event-driven alert manager that evaluates metric-based rules against sliding
 * time windows and fires `alert:fired` / `alert:resolved` lifecycle events.
 *
 * Construct with an `EventTarget` (typically the {@link Engine} instance) and an
 * {@link AlertingOptions} configuration.  The manager subscribes to engine events
 * on construction and re-evaluates rules every 10 seconds.  Dispose it to stop
 * background evaluation and cancel pending webhooks.
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage, AlertManager } from '@lostgradient/weft';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 *
 * using manager = new AlertManager(engine, {
 *   rules: [
 *     { metric: 'workflow.failure_rate', threshold: 0.1, window: '5m', action: 'log' },
 *   ],
 * });
 *
 * engine.addEventListener('alert:fired', (e) => {
 *   console.log('Alert fired!', e);
 * });
 * ```
 */
export class AlertManager implements Disposable {
  #target: EventTarget;
  #options: AlertingOptions;
  #states: MutableAlertState[];
  #windows: Map<number, CounterWindow | HistogramWindow>;
  #listeners: Array<{ type: string; handler: EventListener }>;
  #latestStorageSize: number;
  #pendingWebhooks: Set<AbortController>;
  #getNow: () => number;
  #tickInterval: ReturnType<typeof setInterval> | null;

  constructor(
    target: EventTarget,
    options: AlertingOptions,
    getNow: () => number = Date.now,
    startBackgroundTick = true,
  ) {
    this.#target = target;
    this.#options = {
      ...options,
      rules: options.rules.map((rule) => ({ ...rule })),
      ...(options.webhooks === undefined
        ? {}
        : {
            webhooks: options.webhooks.map((webhook) => ({
              ...webhook,
              events: [...webhook.events],
            })),
          }),
    };
    this.#getNow = getNow;
    this.#latestStorageSize = 0;
    this.#pendingWebhooks = new Set();
    this.#listeners = [];

    // Initialize states for each rule (all start idle)
    this.#states = [];
    for (const rule of this.#options.rules) {
      this.#states.push({
        rule,
        status: 'idle' as const,
        currentValue: 0,
      });
    }

    // Create windows for rules that specify one
    this.#windows = new Map();
    for (let i = 0; i < this.#options.rules.length; i++) {
      const rule = this.#options.rules[i]!;
      const windowMs = rule.window ? parseDuration(rule.window) : 60_000; // default 1m

      if (rule.metric === 'workflow.failure_rate') {
        this.#windows.set(i, new CounterWindow(windowMs));
      } else if (rule.metric === 'activity.p99_duration') {
        this.#windows.set(i, new HistogramWindow(windowMs));
      }
    }

    // Subscribe to engine events based on configured metrics
    this.#subscribeToEvents();

    // Periodic tick to re-evaluate rules even when no events arrive,
    // so alerts in 'firing' state can auto-resolve once the window expires.
    this.#tickInterval = startBackgroundTick
      ? setInterval(this.#evaluateAll.bind(this), TICK_INTERVAL_MS)
      : null;
  }

  /** Re-evaluate every rule once, for hosts that drive maintenance explicitly. */
  tick(): void {
    this.#evaluateAll();
  }

  #evaluateAll(): void {
    for (let i = 0; i < this.#options.rules.length; i++) {
      this.#evaluate(i);
    }
  }

  #subscribeToEvents(): void {
    const hasFailureRate = this.#options.rules.some(
      (rule) => rule.metric === 'workflow.failure_rate',
    );
    const hasDuration = this.#options.rules.some((rule) => rule.metric === 'activity.p99_duration');

    if (hasFailureRate) {
      const recordFailureRate = (failed: boolean) => {
        const now = this.#getNow();
        for (let i = 0; i < this.#options.rules.length; i++) {
          const rule = this.#options.rules[i]!;
          if (rule.metric !== 'workflow.failure_rate') continue;
          const window = this.#windows.get(i) as CounterWindow;
          window.record(now, failed);
          this.#evaluate(i);
        }
      };

      // Success events
      this.#addListener('workflow:completed', () => recordFailureRate(false));

      // Failure events
      for (const eventType of [
        'workflow:failed',
        'workflow:timed-out',
        'workflow:cancelled',
      ] as const) {
        this.#addListener(eventType, () => recordFailureRate(true));
      }
    }

    if (hasDuration) {
      this.#addListener('activity:completed', (event: Event) => {
        if (!(event instanceof ActivityCompletedEvent)) return;
        const now = this.#getNow();
        for (let i = 0; i < this.#options.rules.length; i++) {
          const rule = this.#options.rules[i]!;
          if (rule.metric !== 'activity.p99_duration') continue;
          const window = this.#windows.get(i) as HistogramWindow;
          window.record(now, event.duration);
          this.#evaluate(i);
        }
      });
    }

    const hasStorageSize = this.#options.rules.some((rule) => rule.metric === 'storage.size');

    if (hasStorageSize) {
      this.#addListener('storage:size-reported', (event: Event) => {
        if (!(event instanceof StorageSizeReportedEvent)) return;
        this.#latestStorageSize = event.sizeBytes;
        for (let i = 0; i < this.#options.rules.length; i++) {
          const rule = this.#options.rules[i]!;
          if (rule.metric !== 'storage.size') continue;
          this.#evaluate(i);
        }
      });
    }
  }

  #addListener(type: string, handler: EventListener): void {
    this.#listeners.push({ type, handler });
    this.#target.addEventListener(type, handler);
  }

  #evaluate(ruleIndex: number): void {
    const rule = this.#options.rules[ruleIndex]!;
    const state = this.#states[ruleIndex]!;
    const now = this.#getNow();

    let currentValue = 0;
    const threshold = rule.threshold;

    if (rule.metric === 'workflow.failure_rate') {
      const window = this.#windows.get(ruleIndex) as CounterWindow;
      currentValue = window.rate(now);
    } else if (rule.metric === 'activity.p99_duration') {
      const window = this.#windows.get(ruleIndex) as HistogramWindow;
      currentValue = window.percentile(99, now);
    } else if (rule.metric === 'storage.size') {
      currentValue = this.#latestStorageSize;
    }

    state.currentValue = currentValue;

    if (currentValue >= threshold && state.status === 'idle') {
      state.status = 'firing';
      state.lastFiredAt = now;
      this.#target.dispatchEvent(
        new AlertFiredEvent(rule.metric, threshold, currentValue, rule.window),
      );
      this.#executeAction(rule, 'alert:fired', currentValue);
    } else if (currentValue < threshold && state.status === 'firing') {
      state.status = 'idle';
      state.lastResolvedAt = now;
      this.#target.dispatchEvent(
        new AlertResolvedEvent(rule.metric, threshold, currentValue, rule.window),
      );
      this.#executeAction(rule, 'alert:resolved', currentValue);
    }
  }

  #executeAction(
    rule: AlertRule,
    eventType: 'alert:fired' | 'alert:resolved',
    currentValue: number,
  ): void {
    if (rule.action === 'log') {
      console.warn(
        `[weft:alert] ${eventType}: ${rule.metric} = ${currentValue} (threshold: ${rule.threshold})`,
      );
    }
    if (rule.action === 'webhook') {
      this.#sendWebhooks(rule, eventType, currentValue);
    }
  }

  #sendWebhooks(
    rule: AlertRule,
    eventType: 'alert:fired' | 'alert:resolved',
    currentValue: number,
  ): void {
    const webhooks = this.#options.webhooks ?? [];
    for (const target of webhooks) {
      if (!target.events.includes(eventType)) continue;
      const controller = new AbortController();
      this.#pendingWebhooks.add(controller);
      const payload = {
        event: eventType,
        alert: {
          metric: rule.metric,
          threshold: rule.threshold,
          currentValue,
          window: rule.window,
          timestamp: this.#getNow(),
        },
      };
      void fetch(target.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
      })
        .catch(() => {})
        .finally(this.#pendingWebhooks.delete.bind(this.#pendingWebhooks, controller));
    }
  }

  /** Get a detached snapshot of all alert rules (for debugging/testing). */
  get states(): readonly AlertStateSnapshot[] {
    return this.#states.map(snapshotAlertState);
  }

  /** Get detached snapshots of the alert rules that are currently firing. */
  get activeStates(): readonly AlertStateSnapshot[] {
    return this.#states.filter((state) => state.status === 'firing').map(snapshotAlertState);
  }

  [Symbol.dispose](): void {
    // Stop periodic re-evaluation
    if (this.#tickInterval !== null) {
      clearInterval(this.#tickInterval);
      this.#tickInterval = null;
    }

    // Remove all event listeners from target
    for (const { type, handler } of this.#listeners) {
      this.#target.removeEventListener(type, handler);
    }
    this.#listeners = [];

    // Abort all pending webhook fetches
    for (const controller of this.#pendingWebhooks) {
      controller.abort();
    }
    this.#pendingWebhooks.clear();
  }
}
