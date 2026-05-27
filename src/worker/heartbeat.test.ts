import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  restoreRealTimers,
  sleepForTesting,
  useFakeTimers,
} from '../testing/fake-timers.test-support.ts';
import { HeartbeatManager } from './heartbeat.ts';

describe('HeartbeatManager', () => {
  let sendHeartbeat: ReturnType<typeof mock>;
  let manager: HeartbeatManager;

  beforeEach(() => {
    useFakeTimers();

    sendHeartbeat = mock(() => {});
    manager = new HeartbeatManager(sendHeartbeat, 50);
  });

  afterEach(() => {
    manager.stop();
    restoreRealTimers();
  });

  it('beat calls sendHeartbeat with details', () => {
    const details = { progress: 42 };
    manager.beat(details);

    expect(sendHeartbeat).toHaveBeenCalledTimes(1);
    expect(sendHeartbeat).toHaveBeenCalledWith(details);
  });

  it('beat calls sendHeartbeat without details', () => {
    manager.beat();

    expect(sendHeartbeat).toHaveBeenCalledTimes(1);
    expect(sendHeartbeat).toHaveBeenCalledWith(undefined);
  });

  it('start begins periodic heartbeats', async () => {
    manager.start();

    // Wait for several intervals to fire. The window is generous because
    // setInterval drift under CI parallel load can stretch the first fire.
    await sleepForTesting(250);

    // At least 2 heartbeats should have fired in ~250ms with 50ms interval
    expect(sendHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('stop stops heartbeats', async () => {
    manager.start();
    await sleepForTesting(60);

    manager.stop();
    const countAfterStop = sendHeartbeat.mock.calls.length;

    await sleepForTesting(100);

    // No additional heartbeats after stop
    expect(sendHeartbeat).toHaveBeenCalledTimes(countAfterStop);
  });

  it('isRunning reflects state', () => {
    expect(manager.isRunning).toBe(false);

    manager.start();
    expect(manager.isRunning).toBe(true);

    manager.stop();
    expect(manager.isRunning).toBe(false);
  });

  it('start is idempotent when already running', () => {
    manager.start();
    manager.start(); // should not create a second interval

    expect(manager.isRunning).toBe(true);
  });

  it('stop is safe to call when not running', () => {
    expect(() => manager.stop()).not.toThrow();
  });

  it('uses default interval when none provided', () => {
    const defaultManager = new HeartbeatManager(sendHeartbeat);
    expect(defaultManager.isRunning).toBe(false);
    defaultManager.stop();
  });
});
