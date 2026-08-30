import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import {
  ActivityCompletedEvent,
  AlertFiredEvent,
  AlertResolvedEvent,
  StorageSizeReportedEvent,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowTimedOutEvent,
} from '../core/events';
import { AlertManager } from './alert-manager';
import type { AlertingOptions } from './types';

describe('AlertManager', () => {
  let target: EventTarget;
  let time: number;
  const getNow = () => time;

  beforeEach(() => {
    target = new EventTarget();
    time = 1000;
  });

  it('returns detached alert snapshots that cannot change evaluation', () => {
    const options: AlertingOptions = {
      rules: [{ metric: 'storage.size', threshold: 100, action: 'log' }],
    };
    const manager = new AlertManager(target, options, getNow, false);
    const states = manager.states as unknown as Array<Record<string, unknown>>;
    const state = states[0]!;

    states.pop();
    Reflect.set(state, 'status', 'firing');
    Reflect.set(state, 'currentValue', 999);
    Reflect.set(state['rule'] as object, 'threshold', 1_000);
    Reflect.set(state['rule'] as object, 'action', 'webhook');

    const fired: AlertFiredEvent[] = [];
    target.addEventListener('alert:fired', (event) => {
      fired.push(event as AlertFiredEvent);
    });
    target.dispatchEvent(new StorageSizeReportedEvent(100));

    expect(fired).toHaveLength(1);
    expect(fired[0]!.threshold).toBe(100);
    expect(manager.states).toEqual([
      {
        rule: options.rules[0]!,
        status: 'firing',
        currentValue: 100,
        lastFiredAt: 1000,
      },
    ]);
    expect(manager.states).not.toBe(manager.states);
    expect(manager.states[0]!.rule).not.toBe(options.rules[0]);

    manager[Symbol.dispose]();
  });

  it('owns configured rules and detaches active snapshots', () => {
    const rule: AlertingOptions['rules'][number] = {
      metric: 'storage.size',
      threshold: 100,
      action: 'log',
    };
    const manager = new AlertManager(target, { rules: [rule] }, getNow, false);
    rule.threshold = 1_000;
    rule.action = 'webhook';

    const fired: AlertFiredEvent[] = [];
    const resolved: AlertResolvedEvent[] = [];
    target.addEventListener('alert:fired', (event) => fired.push(event as AlertFiredEvent));
    target.addEventListener('alert:resolved', (event) =>
      resolved.push(event as AlertResolvedEvent),
    );
    target.dispatchEvent(new StorageSizeReportedEvent(100));

    const activeStates = manager.activeStates as unknown as Array<Record<string, unknown>>;
    activeStates.pop();
    const activeState = manager.activeStates[0]!;
    Reflect.set(activeState, 'status', 'idle');
    Reflect.set(activeState['rule'] as object, 'threshold', 1_000);
    Reflect.set(activeState['rule'] as object, 'action', 'webhook');
    target.dispatchEvent(new StorageSizeReportedEvent(50));

    expect(fired).toHaveLength(1);
    expect(fired[0]!.threshold).toBe(100);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.threshold).toBe(100);
    expect(manager.activeStates).toHaveLength(0);

    manager[Symbol.dispose]();
  });

  describe('workflow.failure_rate', () => {
    it('fires AlertFiredEvent when failure rate exceeds threshold', () => {
      const options: AlertingOptions = {
        rules: [
          {
            metric: 'workflow.failure_rate',
            threshold: 0.5,
            window: '5m',
            action: 'log',
          },
        ],
      };

      const manager = new AlertManager(target, options, getNow);
      const fired: AlertFiredEvent[] = [];
      target.addEventListener('alert:fired', (event) => {
        fired.push(event as AlertFiredEvent);
      });

      // Start with successes to avoid immediate firing on first failure
      target.dispatchEvent(new WorkflowCompletedEvent('wf-1', 'ok', 100));
      time += 1000;
      target.dispatchEvent(new WorkflowCompletedEvent('wf-2', 'ok', 100));
      time += 1000;

      // No alert yet — 0% failure rate
      expect(fired.length).toBe(0);

      // Now add failures to push rate to 50% (2/4 = 0.5, which is >= threshold)
      target.dispatchEvent(new WorkflowFailedEvent('wf-3', new Error('fail')));
      time += 1000;
      target.dispatchEvent(new WorkflowFailedEvent('wf-4', new Error('fail')));

      expect(fired.length).toBe(1);
      expect(fired[0]!.metric).toBe('workflow.failure_rate');
      expect(fired[0]!.threshold).toBe(0.5);
      expect(fired[0]!.currentValue).toBe(0.5);
      expect(manager.states[0]!.status).toBe('firing');
      expect(manager.activeStates).toEqual([
        {
          rule: options.rules[0]!,
          status: 'firing',
          currentValue: 0.5,
          lastFiredAt: 4000,
        },
      ]);

      manager[Symbol.dispose]();
    });

    it('fires AlertResolvedEvent when rate drops below threshold', () => {
      const options: AlertingOptions = {
        rules: [
          {
            metric: 'workflow.failure_rate',
            threshold: 0.5,
            window: '1m',
            action: 'log',
          },
        ],
      };

      const manager = new AlertManager(target, options, getNow);
      const resolved: AlertResolvedEvent[] = [];
      target.addEventListener('alert:resolved', (event) => {
        resolved.push(event as AlertResolvedEvent);
      });

      // Push failure rate above 50%
      target.dispatchEvent(new WorkflowFailedEvent('wf-1', new Error('fail')));
      time += 1000;
      target.dispatchEvent(new WorkflowFailedEvent('wf-2', new Error('fail')));

      expect(manager.states[0]!.status).toBe('firing');

      // Now add enough successes to drop below 50%
      time += 1000;
      target.dispatchEvent(new WorkflowCompletedEvent('wf-3', 'ok', 100));
      time += 1000;
      target.dispatchEvent(new WorkflowCompletedEvent('wf-4', 'ok', 100));
      time += 1000;
      target.dispatchEvent(new WorkflowCompletedEvent('wf-5', 'ok', 100));

      expect(resolved.length).toBe(1);
      expect(resolved[0]!.metric).toBe('workflow.failure_rate');
      expect(manager.states[0]!.status).toBe('idle');

      manager[Symbol.dispose]();
    });

    it('does not fire duplicate alert:fired when already firing', () => {
      const options: AlertingOptions = {
        rules: [
          {
            metric: 'workflow.failure_rate',
            threshold: 0.5,
            window: '5m',
            action: 'log',
          },
        ],
      };

      const manager = new AlertManager(target, options, getNow);
      const fired: AlertFiredEvent[] = [];
      target.addEventListener('alert:fired', (event) => {
        fired.push(event as AlertFiredEvent);
      });

      // All failures — rate stays above threshold
      target.dispatchEvent(new WorkflowFailedEvent('wf-1', new Error('fail')));
      time += 1000;
      target.dispatchEvent(new WorkflowFailedEvent('wf-2', new Error('fail')));
      time += 1000;
      target.dispatchEvent(new WorkflowFailedEvent('wf-3', new Error('fail')));

      // Only one fired event despite multiple evaluations while above threshold
      expect(fired.length).toBe(1);

      manager[Symbol.dispose]();
    });

    it('counts timed-out and cancelled workflows as failures', () => {
      const options: AlertingOptions = {
        rules: [
          {
            metric: 'workflow.failure_rate',
            threshold: 0.5,
            window: '5m',
            action: 'log',
          },
        ],
      };

      const manager = new AlertManager(target, options, getNow);
      const fired: AlertFiredEvent[] = [];
      target.addEventListener('alert:fired', (event) => {
        fired.push(event as AlertFiredEvent);
      });

      target.dispatchEvent(new WorkflowTimedOutEvent('wf-1', 'execution', 5000));
      time += 1000;
      target.dispatchEvent(new WorkflowCancelledEvent('wf-2'));

      expect(fired.length).toBe(1);
      expect(manager.states[0]!.currentValue).toBe(1);

      manager[Symbol.dispose]();
    });

    it('re-evaluates rules on the periodic interval tick', () => {
      const originalSetInterval = globalThis.setInterval;
      globalThis.setInterval = ((handler: TimerHandler) => {
        if (typeof handler === 'function') {
          handler();
        }
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval;

      try {
        const options: AlertingOptions = {
          rules: [
            {
              metric: 'workflow.failure_rate',
              threshold: 0.5,
              window: '5m',
              action: 'log',
            },
          ],
        };

        const manager = new AlertManager(target, options, getNow);
        expect(manager.states[0]!.status).toBe('idle');
        manager[Symbol.dispose]();
      } finally {
        globalThis.setInterval = originalSetInterval;
      }
    });
  });

  describe('activity.p99_duration', () => {
    it('fires when p99 duration exceeds threshold', () => {
      const options: AlertingOptions = {
        rules: [
          {
            metric: 'activity.p99_duration',
            threshold: 5000,
            window: '5m',
            action: 'log',
          },
        ],
      };

      const manager = new AlertManager(target, options, getNow);
      const fired: AlertFiredEvent[] = [];
      target.addEventListener('alert:fired', (event) => {
        fired.push(event as AlertFiredEvent);
      });

      // Record 97 fast activities — p99 stays below threshold
      for (let i = 0; i < 97; i++) {
        time += 100;
        target.dispatchEvent(new ActivityCompletedEvent(`op-${i}`, 'wf-1', 'process', 100));
      }
      expect(fired.length).toBe(0);

      // Add 3 very slow activities so that >= 2% of observations are slow,
      // pushing p99 above threshold
      for (let i = 0; i < 3; i++) {
        time += 100;
        target.dispatchEvent(new ActivityCompletedEvent(`op-slow-${i}`, 'wf-1', 'process', 10_000));
      }

      expect(fired.length).toBe(1);
      expect(fired[0]!.metric).toBe('activity.p99_duration');
      expect(fired[0]!.currentValue).toBeGreaterThanOrEqual(5000);

      manager[Symbol.dispose]();
    });
  });

  describe('storage.size', () => {
    it('fires when storage size exceeds threshold', () => {
      const options: AlertingOptions = {
        rules: [
          {
            metric: 'storage.size',
            threshold: 1_000_000, // 1 MB
            action: 'log',
          },
        ],
      };

      const manager = new AlertManager(target, options, getNow);
      const fired: AlertFiredEvent[] = [];
      target.addEventListener('alert:fired', (event) => {
        fired.push(event as AlertFiredEvent);
      });

      // Report a size below threshold — no alert
      target.dispatchEvent(new StorageSizeReportedEvent(500_000));
      expect(fired.length).toBe(0);
      expect(manager.states[0]!.status).toBe('idle');

      // Report a size at threshold — alert fires
      target.dispatchEvent(new StorageSizeReportedEvent(1_000_000));
      expect(fired.length).toBe(1);
      expect(fired[0]!.metric).toBe('storage.size');
      expect(fired[0]!.threshold).toBe(1_000_000);
      expect(fired[0]!.currentValue).toBe(1_000_000);
      expect(manager.states[0]!.status).toBe('firing');

      manager[Symbol.dispose]();
    });

    it('resolves when storage size drops below threshold', () => {
      const options: AlertingOptions = {
        rules: [
          {
            metric: 'storage.size',
            threshold: 1_000_000,
            action: 'log',
          },
        ],
      };

      const manager = new AlertManager(target, options, getNow);
      const resolved: AlertResolvedEvent[] = [];
      target.addEventListener('alert:resolved', (event) => {
        resolved.push(event as AlertResolvedEvent);
      });

      // Push above threshold to enter firing state
      target.dispatchEvent(new StorageSizeReportedEvent(2_000_000));
      expect(manager.states[0]!.status).toBe('firing');

      // Drop below threshold — should resolve
      target.dispatchEvent(new StorageSizeReportedEvent(500_000));
      expect(resolved.length).toBe(1);
      expect(resolved[0]!.metric).toBe('storage.size');
      expect(resolved[0]!.currentValue).toBe(500_000);
      expect(manager.states[0]!.status).toBe('idle');

      manager[Symbol.dispose]();
    });

    it('does not fire duplicate alerts while already firing', () => {
      const options: AlertingOptions = {
        rules: [
          {
            metric: 'storage.size',
            threshold: 1_000_000,
            action: 'log',
          },
        ],
      };

      const manager = new AlertManager(target, options, getNow);
      const fired: AlertFiredEvent[] = [];
      target.addEventListener('alert:fired', (event) => {
        fired.push(event as AlertFiredEvent);
      });

      target.dispatchEvent(new StorageSizeReportedEvent(2_000_000));
      target.dispatchEvent(new StorageSizeReportedEvent(3_000_000));
      target.dispatchEvent(new StorageSizeReportedEvent(4_000_000));

      // Only one fired event despite multiple reports above threshold
      expect(fired.length).toBe(1);

      manager[Symbol.dispose]();
    });
  });

  describe('log action', () => {
    it('calls console.warn on alert:fired', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

      const options: AlertingOptions = {
        rules: [
          {
            metric: 'workflow.failure_rate',
            threshold: 0.5,
            window: '5m',
            action: 'log',
          },
        ],
      };

      const manager = new AlertManager(target, options, getNow);
      target.dispatchEvent(new WorkflowFailedEvent('wf-1', new Error('fail')));

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[weft:alert] alert:fired'));

      warnSpy.mockRestore();
      manager[Symbol.dispose]();
    });
  });

  describe('webhook action', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('sends POST with correct payload', () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;
      const fetchMock = mock((url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        return Promise.resolve(new Response('ok', { status: 200 }));
      });
      globalThis.fetch = fetchMock as any;

      const options: AlertingOptions = {
        rules: [
          {
            metric: 'workflow.failure_rate',
            threshold: 0.5,
            window: '5m',
            action: 'webhook',
          },
        ],
        webhooks: [
          {
            url: 'https://hooks.example.com/alert',
            events: ['alert:fired', 'alert:resolved'],
          },
        ],
      };

      const manager = new AlertManager(target, options, getNow);
      target.dispatchEvent(new WorkflowFailedEvent('wf-1', new Error('fail')));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(capturedUrl).toBe('https://hooks.example.com/alert');
      expect(capturedInit!.method).toBe('POST');
      expect(capturedInit!.headers).toEqual({ 'Content-Type': 'application/json' });

      const body = JSON.parse(capturedInit!.body as string);
      expect(body.event).toBe('alert:fired');
      expect(body.alert.metric).toBe('workflow.failure_rate');
      expect(body.alert.threshold).toBe(0.5);
      expect(body.alert.currentValue).toBe(1);
      expect(body.alert.timestamp).toBe(1000);

      manager[Symbol.dispose]();
    });

    it('filters webhooks by event type', () => {
      const fetchMock = mock(() => Promise.resolve(new Response('ok', { status: 200 })));
      globalThis.fetch = fetchMock as any;

      const options: AlertingOptions = {
        rules: [
          {
            metric: 'workflow.failure_rate',
            threshold: 0.5,
            window: '5m',
            action: 'webhook',
          },
        ],
        webhooks: [
          {
            url: 'https://hooks.example.com/resolved-only',
            events: ['alert:resolved'], // won't match alert:fired
          },
        ],
      };

      const manager = new AlertManager(target, options, getNow);
      target.dispatchEvent(new WorkflowFailedEvent('wf-1', new Error('fail')));

      // Should not have been called because webhook only listens for resolved
      expect(fetchMock).not.toHaveBeenCalled();

      manager[Symbol.dispose]();
    });

    it('swallows webhook delivery failures and cleans up pending state', async () => {
      const fetchMock = mock(() => Promise.reject(new Error('network failed')));
      globalThis.fetch = fetchMock as any;

      const options: AlertingOptions = {
        rules: [
          {
            metric: 'workflow.failure_rate',
            threshold: 0.5,
            window: '5m',
            action: 'webhook',
          },
        ],
        webhooks: [
          {
            url: 'https://hooks.example.com/alert',
            events: ['alert:fired'],
          },
        ],
      };

      const manager = new AlertManager(target, options, getNow);

      expect(() => {
        target.dispatchEvent(new WorkflowFailedEvent('wf-1', new Error('fail')));
      }).not.toThrow();

      await Promise.resolve();
      await Promise.resolve();

      manager[Symbol.dispose]();
    });
  });

  describe('dispose', () => {
    it('removes listeners so events after dispose do not trigger alerts', () => {
      const options: AlertingOptions = {
        rules: [
          {
            metric: 'workflow.failure_rate',
            threshold: 0.5,
            window: '5m',
            action: 'log',
          },
        ],
      };

      const manager = new AlertManager(target, options, getNow);
      manager[Symbol.dispose]();

      const fired: AlertFiredEvent[] = [];
      target.addEventListener('alert:fired', (event) => {
        fired.push(event as AlertFiredEvent);
      });

      target.dispatchEvent(new WorkflowFailedEvent('wf-1', new Error('fail')));

      // No alert should fire after dispose
      expect(fired.length).toBe(0);
      expect(manager.states[0]!.status).toBe('idle');
    });

    it('aborts pending webhooks', async () => {
      const savedFetch = globalThis.fetch;
      try {
        const abortedSignals: AbortSignal[] = [];
        const fetchMock = mock((_url: string, init: RequestInit) => {
          abortedSignals.push(init.signal!);
          // Return a promise that never resolves to simulate pending request
          return new Promise<Response>(() => {});
        });
        globalThis.fetch = fetchMock as any;

        const options: AlertingOptions = {
          rules: [
            {
              metric: 'workflow.failure_rate',
              threshold: 0.5,
              window: '5m',
              action: 'webhook',
            },
          ],
          webhooks: [
            {
              url: 'https://hooks.example.com/alert',
              events: ['alert:fired'],
            },
          ],
        };

        const manager = new AlertManager(target, options, getNow);
        target.dispatchEvent(new WorkflowFailedEvent('wf-1', new Error('fail')));

        // The fetch should have been called
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Dispose should abort the pending webhook
        manager[Symbol.dispose]();

        expect(abortedSignals[0]!.aborted).toBe(true);
      } finally {
        globalThis.fetch = savedFetch;
      }
    });
  });
});
