import { describe, expect, it } from 'bun:test';

import { WorkflowClaimTakeoverCooldown } from './workflow-claim-cooldown.ts';

const BASE_MS = 5_000;
const CAP_MS = 30_000; // < baseMs * 8, so the cap is reachable within a few doublings

function makeCooldown(): WorkflowClaimTakeoverCooldown {
  return new WorkflowClaimTakeoverCooldown({
    claimRenewIntervalMs: BASE_MS,
    claimTtlMs: CAP_MS / 4,
  });
}

describe('WorkflowClaimTakeoverCooldown', () => {
  it('is inactive for an id that was never deposed', () => {
    const cooldown = makeCooldown();

    expect(cooldown.isActive('wf-1', 1_000_000)).toBe(false);
  });

  it('becomes active at baseMs after the first deposition', () => {
    const cooldown = makeCooldown();
    const now = 1_000_000;

    cooldown.recordDeposition('wf-1', now);

    expect(cooldown.isActive('wf-1', now)).toBe(true);
    expect(cooldown.isActive('wf-1', now + BASE_MS - 1)).toBe(true);
  });

  it('is no longer active once the window has strictly passed (exact-boundary tick excluded)', () => {
    const cooldown = makeCooldown();
    const now = 1_000_000;

    cooldown.recordDeposition('wf-1', now);

    expect(cooldown.isActive('wf-1', now + BASE_MS)).toBe(false);
    expect(cooldown.isActive('wf-1', now + BASE_MS + 1)).toBe(false);
  });

  it('doubles the window on a second deposition before the first has cleared', () => {
    const cooldown = makeCooldown();
    const now = 1_000_000;

    cooldown.recordDeposition('wf-1', now);
    cooldown.recordDeposition('wf-1', now); // second deposition, same instant — forces doubling

    // Window is now 2 * BASE_MS, so it is still active just past the original window.
    expect(cooldown.isActive('wf-1', now + BASE_MS + 1)).toBe(true);
    expect(cooldown.isActive('wf-1', now + 2 * BASE_MS)).toBe(false);
  });

  it('caps the doubled window at capMs', () => {
    const cooldown = makeCooldown();
    const now = 1_000_000;

    // BASE_MS=5000, CAP_MS=30000: 5000 -> 10000 -> 20000 -> 40000(capped to 30000).
    cooldown.recordDeposition('wf-1', now);
    cooldown.recordDeposition('wf-1', now);
    cooldown.recordDeposition('wf-1', now);
    cooldown.recordDeposition('wf-1', now);

    expect(cooldown.isActive('wf-1', now + CAP_MS - 1)).toBe(true);
    expect(cooldown.isActive('wf-1', now + CAP_MS)).toBe(false);
  });

  it('clear() ends an active cooldown immediately', () => {
    const cooldown = makeCooldown();
    const now = 1_000_000;

    cooldown.recordDeposition('wf-1', now);
    expect(cooldown.isActive('wf-1', now)).toBe(true);

    cooldown.clear('wf-1');

    expect(cooldown.isActive('wf-1', now)).toBe(false);
  });

  it('clear() on an id with no tracked cooldown is a no-op', () => {
    const cooldown = makeCooldown();

    expect(() => cooldown.clear('never-deposed')).not.toThrow();
  });

  it('a deposition after clear() restarts at baseMs rather than continuing to double', () => {
    const cooldown = makeCooldown();
    const now = 1_000_000;

    cooldown.recordDeposition('wf-1', now);
    cooldown.recordDeposition('wf-1', now); // window would now be 2 * BASE_MS
    cooldown.clear('wf-1');

    cooldown.recordDeposition('wf-1', now);

    expect(cooldown.isActive('wf-1', now + BASE_MS - 1)).toBe(true);
    expect(cooldown.isActive('wf-1', now + BASE_MS)).toBe(false);
  });

  it('tracks cooldowns independently per workflow id', () => {
    const cooldown = makeCooldown();
    const now = 1_000_000;

    cooldown.recordDeposition('wf-1', now);

    expect(cooldown.isActive('wf-1', now)).toBe(true);
    expect(cooldown.isActive('wf-2', now)).toBe(false);
  });
});
