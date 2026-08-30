import { describe, expect, it } from 'bun:test';

import { Engine } from '../engine.ts';
import { AlertResolvedEvent, StorageSizeReportedEvent } from '../events.ts';

describe('Engine alert snapshots', () => {
  it('detaches getActiveAlerts results before later evaluation', () => {
    using engine = new Engine({
      backgroundTasks: 'manual',
      alerts: {
        rules: [{ metric: 'storage.size', threshold: 100, action: 'log' }],
      },
    });
    const resolved: AlertResolvedEvent[] = [];
    engine.addEventListener('alert:resolved', (event) => {
      resolved.push(event);
    });

    engine.dispatchEvent(new StorageSizeReportedEvent(100));
    const active = engine.getActiveAlerts() as unknown as Array<Record<string, unknown>>;
    active.pop();
    const snapshot = engine.getActiveAlerts()[0]!;
    Reflect.set(snapshot, 'status', 'idle');
    Reflect.set(snapshot, 'currentValue', 0);
    Reflect.set(snapshot['rule'] as object, 'threshold', 1_000);
    Reflect.set(snapshot['rule'] as object, 'action', 'webhook');

    engine.dispatchEvent(new StorageSizeReportedEvent(50));

    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.threshold).toBe(100);
    expect(engine.getActiveAlerts()).toHaveLength(0);
  });
});
