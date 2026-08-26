import { describe, expect, it } from 'bun:test';

import { WorkflowClaimTakeoverCooldown } from './workflow-claim-cooldown.ts';

const WINDOW_MS = 5_000;

function makeCooldown(): WorkflowClaimTakeoverCooldown {
  return new WorkflowClaimTakeoverCooldown({ claimRenewIntervalMs: WINDOW_MS });
}

describe('WorkflowClaimTakeoverCooldown', () => {
  it('is inactive for an id that was never deposed', () => {
    const cooldown = makeCooldown();

    expect(cooldown.isActive('wf-1', 1_000_000)).toBe(false);
  });

  it('becomes active for the fixed window after a deposition', () => {
    const cooldown = makeCooldown();
    const now = 1_000_000;

    cooldown.recordDeposition('wf-1', now);

    expect(cooldown.isActive('wf-1', now)).toBe(true);
    expect(cooldown.isActive('wf-1', now + WINDOW_MS - 1)).toBe(true);
  });

  it('is no longer active once the window has strictly passed (exact-boundary tick excluded)', () => {
    const cooldown = makeCooldown();
    const now = 1_000_000;

    cooldown.recordDeposition('wf-1', now);

    expect(cooldown.isActive('wf-1', now + WINDOW_MS)).toBe(false);
    expect(cooldown.isActive('wf-1', now + WINDOW_MS + 1)).toBe(false);
  });

  it('a second deposition before the first has cleared restarts the same fixed window, not a longer one', () => {
    const cooldown = makeCooldown();
    const now = 1_000_000;

    cooldown.recordDeposition('wf-1', now);
    cooldown.recordDeposition('wf-1', now + 1);

    // Restarted at now+1, so the window ends at now+1+WINDOW_MS, not
    // now+WINDOW_MS from the first (overwritten) deposition.
    expect(cooldown.isActive('wf-1', now + WINDOW_MS)).toBe(true);
    expect(cooldown.isActive('wf-1', now + 1 + WINDOW_MS - 1)).toBe(true);
    expect(cooldown.isActive('wf-1', now + 1 + WINDOW_MS)).toBe(false);
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

  it('a deposition after clear() restarts at the fixed window', () => {
    const cooldown = makeCooldown();
    const now = 1_000_000;

    cooldown.recordDeposition('wf-1', now);
    cooldown.clear('wf-1');

    cooldown.recordDeposition('wf-1', now);

    expect(cooldown.isActive('wf-1', now + WINDOW_MS - 1)).toBe(true);
    expect(cooldown.isActive('wf-1', now + WINDOW_MS)).toBe(false);
  });

  it('tracks cooldowns independently per workflow id', () => {
    const cooldown = makeCooldown();
    const now = 1_000_000;

    cooldown.recordDeposition('wf-1', now);

    expect(cooldown.isActive('wf-1', now)).toBe(true);
    expect(cooldown.isActive('wf-2', now)).toBe(false);
  });
});
