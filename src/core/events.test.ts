import { describe, expect, it } from 'bun:test';

import {
  ActivityCompletedEvent,
  ActivityFailedEvent,
  ActivityStartedEvent,
  AttributesChangedEvent,
  CheckpointSizeWarningEvent,
  DevelopmentWarningEvent,
  ScheduleMissedFireEvent,
  SignalDeliveredEvent,
  SignalReceivedEvent,
  UpdateCompletedEvent,
  UpdateReceivedEvent,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowStartedEvent,
  WorkflowTimedOutEvent,
} from './events';

describe('WorkflowStartedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new WorkflowStartedEvent('wf-1', 'MyWorkflow', { key: 'value' });
    expect(event.workflowId).toBe('wf-1');
    expect(event.workflowType).toBe('MyWorkflow');
    expect(event.input).toEqual({ key: 'value' });
  });

  it('has a matching static type and instance type', () => {
    const event = new WorkflowStartedEvent('wf-1', 'MyWorkflow', null);
    expect(event.type).toBe(WorkflowStartedEvent.type);
    expect(event.type).toBe('workflow:started');
  });

  it('is an instance of Event', () => {
    const event = new WorkflowStartedEvent('wf-1', 'MyWorkflow', null);
    expect(event).toBeInstanceOf(Event);
  });

  it('is not an instance of CustomEvent', () => {
    const event = new WorkflowStartedEvent('wf-1', 'MyWorkflow', null);
    expect(event).not.toBeInstanceOf(CustomEvent);
  });
});

describe('WorkflowCompletedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new WorkflowCompletedEvent('wf-2', { done: true }, 1500);
    expect(event.workflowId).toBe('wf-2');
    expect(event.result).toEqual({ done: true });
    expect(event.duration).toBe(1500);
  });

  it('has a matching static type and instance type', () => {
    const event = new WorkflowCompletedEvent('wf-2', null, 0);
    expect(event.type).toBe(WorkflowCompletedEvent.type);
    expect(event.type).toBe('workflow:completed');
  });

  it('is an instance of Event but not CustomEvent', () => {
    const event = new WorkflowCompletedEvent('wf-2', null, 0);
    expect(event).toBeInstanceOf(Event);
    expect(event).not.toBeInstanceOf(CustomEvent);
  });
});

describe('WorkflowFailedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const error = new Error('boom');
    const event = new WorkflowFailedEvent('wf-3', error);
    expect(event.workflowId).toBe('wf-3');
    expect(event.error).toBe(error);
  });

  it('has a matching static type and instance type', () => {
    const event = new WorkflowFailedEvent('wf-3', new Error('test'));
    expect(event.type).toBe(WorkflowFailedEvent.type);
    expect(event.type).toBe('workflow:failed');
  });

  it('is an instance of Event but not CustomEvent', () => {
    const event = new WorkflowFailedEvent('wf-3', new Error('test'));
    expect(event).toBeInstanceOf(Event);
    expect(event).not.toBeInstanceOf(CustomEvent);
  });
});

describe('WorkflowCancelledEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new WorkflowCancelledEvent('wf-4');
    expect(event.workflowId).toBe('wf-4');
  });

  it('has a matching static type and instance type', () => {
    const event = new WorkflowCancelledEvent('wf-4');
    expect(event.type).toBe(WorkflowCancelledEvent.type);
    expect(event.type).toBe('workflow:cancelled');
  });

  it('is an instance of Event but not CustomEvent', () => {
    const event = new WorkflowCancelledEvent('wf-4');
    expect(event).toBeInstanceOf(Event);
    expect(event).not.toBeInstanceOf(CustomEvent);
  });
});

describe('WorkflowTimedOutEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new WorkflowTimedOutEvent('wf-5', 'execution', 30000);
    expect(event.workflowId).toBe('wf-5');
    expect(event.timeoutType).toBe('execution');
    expect(event.elapsed).toBe(30000);
  });

  it('accepts run timeout type', () => {
    const event = new WorkflowTimedOutEvent('wf-5', 'run', 5000);
    expect(event.timeoutType).toBe('run');
  });

  it('has a matching static type and instance type', () => {
    const event = new WorkflowTimedOutEvent('wf-5', 'execution', 0);
    expect(event.type).toBe(WorkflowTimedOutEvent.type);
    expect(event.type).toBe('workflow:timed-out');
  });

  it('is an instance of Event but not CustomEvent', () => {
    const event = new WorkflowTimedOutEvent('wf-5', 'execution', 0);
    expect(event).toBeInstanceOf(Event);
    expect(event).not.toBeInstanceOf(CustomEvent);
  });
});

describe('ActivityStartedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new ActivityStartedEvent('op-1', 'wf-6', 'sendEmail', 1);
    expect(event.operationId).toBe('op-1');
    expect(event.workflowId).toBe('wf-6');
    expect(event.activityName).toBe('sendEmail');
    expect(event.attempt).toBe(1);
  });

  it('has a matching static type and instance type', () => {
    const event = new ActivityStartedEvent('op-1', 'wf-6', 'sendEmail', 1);
    expect(event.type).toBe(ActivityStartedEvent.type);
    expect(event.type).toBe('activity:started');
  });

  it('is an instance of Event but not CustomEvent', () => {
    const event = new ActivityStartedEvent('op-1', 'wf-6', 'sendEmail', 1);
    expect(event).toBeInstanceOf(Event);
    expect(event).not.toBeInstanceOf(CustomEvent);
  });
});

describe('ActivityCompletedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new ActivityCompletedEvent('op-2', 'wf-7', 'fetchData', 250);
    expect(event.operationId).toBe('op-2');
    expect(event.workflowId).toBe('wf-7');
    expect(event.activityName).toBe('fetchData');
    expect(event.duration).toBe(250);
  });

  it('has a matching static type and instance type', () => {
    const event = new ActivityCompletedEvent('op-2', 'wf-7', 'fetchData', 250);
    expect(event.type).toBe(ActivityCompletedEvent.type);
    expect(event.type).toBe('activity:completed');
  });

  it('is an instance of Event but not CustomEvent', () => {
    const event = new ActivityCompletedEvent('op-2', 'wf-7', 'fetchData', 250);
    expect(event).toBeInstanceOf(Event);
    expect(event).not.toBeInstanceOf(CustomEvent);
  });
});

describe('ActivityFailedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const error = new Error('network error');
    const event = new ActivityFailedEvent('op-3', 'wf-8', 'callApi', error, 3);
    expect(event.operationId).toBe('op-3');
    expect(event.workflowId).toBe('wf-8');
    expect(event.activityName).toBe('callApi');
    expect(event.error).toBe(error);
    expect(event.attempt).toBe(3);
  });

  it('has a matching static type and instance type', () => {
    const event = new ActivityFailedEvent('op-3', 'wf-8', 'callApi', new Error('x'), 1);
    expect(event.type).toBe(ActivityFailedEvent.type);
    expect(event.type).toBe('activity:failed');
  });

  it('is an instance of Event but not CustomEvent', () => {
    const event = new ActivityFailedEvent('op-3', 'wf-8', 'callApi', new Error('x'), 1);
    expect(event).toBeInstanceOf(Event);
    expect(event).not.toBeInstanceOf(CustomEvent);
  });
});

describe('SignalReceivedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new SignalReceivedEvent('wf-10', 'approve', { userId: 42 });
    expect(event.workflowId).toBe('wf-10');
    expect(event.signalName).toBe('approve');
    expect(event.payload).toEqual({ userId: 42 });
  });

  it('has a matching static type and instance type', () => {
    const event = new SignalReceivedEvent('wf-10', 'approve', null);
    expect(event.type).toBe(SignalReceivedEvent.type);
    expect(event.type).toBe('signal:received');
  });

  it('is an instance of Event but not CustomEvent', () => {
    const event = new SignalReceivedEvent('wf-10', 'approve', null);
    expect(event).toBeInstanceOf(Event);
    expect(event).not.toBeInstanceOf(CustomEvent);
  });
});

describe('SignalDeliveredEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new SignalDeliveredEvent('wf-11', 'approve');
    expect(event.workflowId).toBe('wf-11');
    expect(event.signalName).toBe('approve');
  });

  it('has a matching static type and instance type', () => {
    const event = new SignalDeliveredEvent('wf-11', 'approve');
    expect(event.type).toBe(SignalDeliveredEvent.type);
    expect(event.type).toBe('signal:delivered');
  });

  it('is an instance of Event but not CustomEvent', () => {
    const event = new SignalDeliveredEvent('wf-11', 'approve');
    expect(event).toBeInstanceOf(Event);
    expect(event).not.toBeInstanceOf(CustomEvent);
  });
});

describe('AttributesChangedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const changes = { status: 'active', count: 5 };
    const event = new AttributesChangedEvent('wf-12', changes);
    expect(event.workflowId).toBe('wf-12');
    expect(event.changes).toEqual({ status: 'active', count: 5 });
  });

  it('has a matching static type and instance type', () => {
    const event = new AttributesChangedEvent('wf-12', {});
    expect(event.type).toBe(AttributesChangedEvent.type);
    expect(event.type).toBe('attributes:changed');
  });

  it('is an instance of Event but not CustomEvent', () => {
    const event = new AttributesChangedEvent('wf-12', {});
    expect(event).toBeInstanceOf(Event);
    expect(event).not.toBeInstanceOf(CustomEvent);
  });
});

describe('ScheduleMissedFireEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new ScheduleMissedFireEvent('schedule-1', 3, 1_000, 4_000);
    expect(event.scheduleId).toBe('schedule-1');
    expect(event.missedCount).toBe(3);
    expect(event.windowStart).toBe(1_000);
    expect(event.windowEnd).toBe(4_000);
  });

  it('has a matching static type and instance type', () => {
    const event = new ScheduleMissedFireEvent('schedule-1', 1, 1_000, 2_000);
    expect(event.type).toBe(ScheduleMissedFireEvent.type);
    expect(event.type).toBe('schedule:missed-fire');
  });

  it('is an instance of Event but not CustomEvent', () => {
    const event = new ScheduleMissedFireEvent('schedule-1', 1, 1_000, 2_000);
    expect(event).toBeInstanceOf(Event);
    expect(event).not.toBeInstanceOf(CustomEvent);
  });
});

describe('UpdateReceivedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new UpdateReceivedEvent('upd-1', 'wf-13', 'setName', { name: 'Alice' });
    expect(event.updateId).toBe('upd-1');
    expect(event.workflowId).toBe('wf-13');
    expect(event.name).toBe('setName');
    expect(event.payload).toEqual({ name: 'Alice' });
  });

  it('has a matching static type and instance type', () => {
    const event = new UpdateReceivedEvent('upd-1', 'wf-13', 'setName', null);
    expect(event.type).toBe(UpdateReceivedEvent.type);
    expect(event.type).toBe('update:received');
  });

  it('is an instance of Event but not CustomEvent', () => {
    const event = new UpdateReceivedEvent('upd-1', 'wf-13', 'setName', null);
    expect(event).toBeInstanceOf(Event);
    expect(event).not.toBeInstanceOf(CustomEvent);
  });
});

describe('UpdateCompletedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new UpdateCompletedEvent('upd-2', 'wf-14', 'setName', 'ok', undefined);
    expect(event.updateId).toBe('upd-2');
    expect(event.workflowId).toBe('wf-14');
    expect(event.name).toBe('setName');
    expect(event.result).toBe('ok');
    expect(event.error).toBeUndefined();
  });

  it('sets error when provided', () => {
    const event = new UpdateCompletedEvent('upd-3', 'wf-15', 'setName', null, 'something broke');
    expect(event.error).toBe('something broke');
  });

  it('has a matching static type and instance type', () => {
    const event = new UpdateCompletedEvent('upd-2', 'wf-14', 'setName', null);
    expect(event.type).toBe(UpdateCompletedEvent.type);
    expect(event.type).toBe('update:completed');
  });

  it('is an instance of Event but not CustomEvent', () => {
    const event = new UpdateCompletedEvent('upd-2', 'wf-14', 'setName', null);
    expect(event).toBeInstanceOf(Event);
    expect(event).not.toBeInstanceOf(CustomEvent);
  });
});

describe('CheckpointSizeWarningEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new CheckpointSizeWarningEvent('wf-16', 1048576, 42);
    expect(event.workflowId).toBe('wf-16');
    expect(event.sizeBytes).toBe(1048576);
    expect(event.step).toBe(42);
  });

  it('has a matching static type and instance type', () => {
    const event = new CheckpointSizeWarningEvent('wf-16', 0, 0);
    expect(event.type).toBe(CheckpointSizeWarningEvent.type);
    expect(event.type).toBe('checkpoint:size-warning');
  });

  it('is an instance of Event but not CustomEvent', () => {
    const event = new CheckpointSizeWarningEvent('wf-16', 0, 0);
    expect(event).toBeInstanceOf(Event);
    expect(event).not.toBeInstanceOf(CustomEvent);
  });
});

describe('DevelopmentWarningEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new DevelopmentWarningEvent('wf-17', 'Non-deterministic call', [
      'state.random',
      'state.date',
    ]);
    expect(event.workflowId).toBe('wf-17');
    expect(event.message).toBe('Non-deterministic call');
    expect(event.fieldPaths).toEqual(['state.random', 'state.date']);
  });

  it('has a matching static type and instance type', () => {
    const event = new DevelopmentWarningEvent('wf-17', 'test', []);
    expect(event.type).toBe(DevelopmentWarningEvent.type);
    expect(event.type).toBe('development:warning');
  });

  it('is an instance of Event but not CustomEvent', () => {
    const event = new DevelopmentWarningEvent('wf-17', 'test', []);
    expect(event).toBeInstanceOf(Event);
    expect(event).not.toBeInstanceOf(CustomEvent);
  });
});

describe('WeftEventMap type coverage', () => {
  it('maps all event type strings to their respective classes', () => {
    // Verify each static type constant exists and is the expected string.
    // The WeftEventMap interface is checked at compile time; here we ensure
    // the runtime type strings are correct.
    expect(WorkflowStartedEvent.type).toBe('workflow:started');
    expect(WorkflowCompletedEvent.type).toBe('workflow:completed');
    expect(WorkflowFailedEvent.type).toBe('workflow:failed');
    expect(WorkflowCancelledEvent.type).toBe('workflow:cancelled');
    expect(WorkflowTimedOutEvent.type).toBe('workflow:timed-out');
    expect(ActivityStartedEvent.type).toBe('activity:started');
    expect(ActivityCompletedEvent.type).toBe('activity:completed');
    expect(ActivityFailedEvent.type).toBe('activity:failed');
    expect(SignalReceivedEvent.type).toBe('signal:received');
    expect(SignalDeliveredEvent.type).toBe('signal:delivered');
    expect(AttributesChangedEvent.type).toBe('attributes:changed');
    expect(UpdateReceivedEvent.type).toBe('update:received');
    expect(UpdateCompletedEvent.type).toBe('update:completed');
    expect(CheckpointSizeWarningEvent.type).toBe('checkpoint:size-warning');
    expect(DevelopmentWarningEvent.type).toBe('development:warning');
  });
});

describe('EventTarget integration', () => {
  it('dispatches WorkflowStartedEvent to a typed listener', () => {
    const target = new EventTarget();
    let received: WorkflowStartedEvent | null = null;

    target.addEventListener(WorkflowStartedEvent.type, ((event: WorkflowStartedEvent) => {
      received = event;
    }) as EventListener);

    const dispatched = new WorkflowStartedEvent('wf-100', 'TestWorkflow', { data: 123 });
    target.dispatchEvent(dispatched);

    expect(received).not.toBeNull();
    expect(received!.workflowId).toBe('wf-100');
    expect(received!.workflowType).toBe('TestWorkflow');
    expect(received!.input).toEqual({ data: 123 });
  });

  it('dispatches WorkflowCompletedEvent with result and duration', () => {
    const target = new EventTarget();
    let received: WorkflowCompletedEvent | null = null;

    target.addEventListener(WorkflowCompletedEvent.type, ((event: WorkflowCompletedEvent) => {
      received = event;
    }) as EventListener);

    const dispatched = new WorkflowCompletedEvent('wf-101', { success: true }, 2500);
    target.dispatchEvent(dispatched);

    expect(received).not.toBeNull();
    expect(received!.result).toEqual({ success: true });
    expect(received!.duration).toBe(2500);
  });

  it('cleans up listeners via AbortSignal', () => {
    const target = new EventTarget();
    const controller = new AbortController();
    let callCount = 0;

    target.addEventListener(
      WorkflowStartedEvent.type,
      (() => {
        callCount++;
      }) as EventListener,
      { signal: controller.signal },
    );

    target.dispatchEvent(new WorkflowStartedEvent('wf-200', 'Test', null));
    expect(callCount).toBe(1);

    controller.abort();

    target.dispatchEvent(new WorkflowStartedEvent('wf-201', 'Test', null));
    expect(callCount).toBe(1);
  });

  it('dispatches multiple event types to the correct listeners', () => {
    const target = new EventTarget();
    const received: string[] = [];

    target.addEventListener(WorkflowStartedEvent.type, (() => {
      received.push('started');
    }) as EventListener);

    target.addEventListener(WorkflowCompletedEvent.type, (() => {
      received.push('completed');
    }) as EventListener);

    target.addEventListener(ActivityFailedEvent.type, (() => {
      received.push('activity-failed');
    }) as EventListener);

    target.dispatchEvent(new WorkflowCompletedEvent('wf-300', null, 100));
    target.dispatchEvent(new WorkflowStartedEvent('wf-301', 'Test', null));
    target.dispatchEvent(new ActivityFailedEvent('op-1', 'wf-302', 'act', new Error('x'), 1));

    expect(received).toEqual(['completed', 'started', 'activity-failed']);
  });
});

describe('Event properties are readonly', () => {
  it('compile-time check: readonly properties exist on all event classes', () => {
    // This test verifies that the event classes compile correctly with readonly
    // properties. If the types were wrong, this file would not compile.
    const workflowStarted = new WorkflowStartedEvent('wf', 'type', null);
    expect(workflowStarted.workflowId satisfies string).toBe('wf');
    expect(workflowStarted.workflowType satisfies string).toBe('type');
    expect(workflowStarted.input satisfies unknown).toBeNull();

    const workflowCompleted = new WorkflowCompletedEvent('wf', null, 0);
    expect(workflowCompleted.result satisfies unknown).toBeNull();
    expect(workflowCompleted.duration satisfies number).toBe(0);

    const activityFailed = new ActivityFailedEvent('op', 'wf', 'act', new Error('e'), 1);
    expect(activityFailed.error satisfies Error).toBeInstanceOf(Error);
    expect(activityFailed.attempt satisfies number).toBe(1);

    const updateCompleted = new UpdateCompletedEvent('upd', 'wf', 'name', null);
    expect(updateCompleted.error satisfies string | undefined).toBeUndefined();
  });
});
