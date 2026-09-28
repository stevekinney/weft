import { describe, expect, it } from 'bun:test';

import {
  RealmLifecycle,
  RealmLifecycleTransitionError,
  type RealmLifecycleState,
  type RealmLifecycleTransition,
} from './realm-lifecycle.ts';

function realm(
  overrides: Partial<{ isReferenced: () => boolean; maxRestarts: number }> = {},
): RealmLifecycle {
  return new RealmLifecycle({
    isReferenced: overrides.isReferenced ?? (() => true),
    maxRestarts: overrides.maxRestarts ?? 3,
  });
}

describe('RealmLifecycle', () => {
  it('starts Warming', () => {
    expect(realm().state).toBe('warming');
  });

  describe('legal transitions', () => {
    it('Warming -> Ready on a successful ready handshake', () => {
      const lifecycle = realm();
      lifecycle.markReady({ ok: true });
      expect(lifecycle.state).toBe('ready');
    });

    it('Warming -> Crashed on a rejected ready handshake', () => {
      const lifecycle = realm();
      lifecycle.markReady({ ok: false });
      expect(lifecycle.state).toBe('crashed');
    });

    it('Ready -> Active -> Draining -> Terminated', () => {
      const lifecycle = realm();
      lifecycle.markReady({ ok: true });
      lifecycle.activate();
      expect(lifecycle.state).toBe('active');
      lifecycle.beginDrain();
      expect(lifecycle.state).toBe('draining');
      lifecycle.terminate();
      expect(lifecycle.state).toBe('terminated');
    });

    it('crashes from Ready, Active, or Draining', () => {
      for (const reach of [
        (lifecycle: RealmLifecycle) => lifecycle.markReady({ ok: true }),
        (lifecycle: RealmLifecycle) => {
          lifecycle.markReady({ ok: true });
          lifecycle.activate();
        },
        (lifecycle: RealmLifecycle) => {
          lifecycle.markReady({ ok: true });
          lifecycle.activate();
          lifecycle.beginDrain();
        },
      ]) {
        const lifecycle = realm();
        reach(lifecycle);
        lifecycle.crash();
        expect(lifecycle.state).toBe('crashed');
      }
    });

    it('restarts Crashed -> Warming when referenced and within budget', () => {
      const lifecycle = realm({ isReferenced: () => true, maxRestarts: 1 });
      lifecycle.markReady({ ok: false });
      expect(lifecycle.state).toBe('crashed');

      const outcome = lifecycle.restart();
      expect(outcome).toEqual({ ok: true });
      expect(lifecycle.state).toBe('warming');
      expect(lifecycle.restartCount).toBe(1);
    });
  });

  describe('illegal transitions throw', () => {
    const illegalCases: ReadonlyArray<{
      name: string;
      reach: (lifecycle: RealmLifecycle) => void;
      attempt: (lifecycle: RealmLifecycle) => void;
      from: RealmLifecycleState;
    }> = [
      {
        name: 'Draining -> Active via activate()',
        reach: (lifecycle) => {
          lifecycle.markReady({ ok: true });
          lifecycle.activate();
          lifecycle.beginDrain();
        },
        attempt: (lifecycle) => lifecycle.activate(),
        from: 'draining',
      },
      {
        name: 'Active -> Ready via markReady()',
        reach: (lifecycle) => {
          lifecycle.markReady({ ok: true });
          lifecycle.activate();
        },
        attempt: (lifecycle) => lifecycle.markReady({ ok: true }),
        from: 'active',
      },
      {
        name: 'Warming -> Draining via beginDrain()',
        reach: () => {
          /* stay in Warming */
        },
        attempt: (lifecycle) => lifecycle.beginDrain(),
        from: 'warming',
      },
      {
        name: 'Ready -> Terminated via terminate()',
        reach: (lifecycle) => lifecycle.markReady({ ok: true }),
        attempt: (lifecycle) => lifecycle.terminate(),
        from: 'ready',
      },
      {
        name: 'Terminated -> Crashed via crash()',
        reach: (lifecycle) => {
          lifecycle.markReady({ ok: true });
          lifecycle.activate();
          lifecycle.beginDrain();
          lifecycle.terminate();
        },
        attempt: (lifecycle) => lifecycle.crash(),
        from: 'terminated',
      },
      {
        name: 'Warming -> Warming via restart()',
        reach: () => {
          /* stay in Warming */
        },
        attempt: (lifecycle) => lifecycle.restart(),
        from: 'warming',
      },
    ];

    for (const testCase of illegalCases) {
      it(`rejects ${testCase.name}`, () => {
        const lifecycle = realm();
        testCase.reach(lifecycle);
        expect(lifecycle.state).toBe(testCase.from);
        expect(() => testCase.attempt(lifecycle)).toThrow(RealmLifecycleTransitionError);
        // The illegal attempt must not have mutated state.
        expect(lifecycle.state).toBe(testCase.from);
      });
    }
  });

  describe('bounded restart', () => {
    it('refuses restart when nothing references the revision, without changing state', () => {
      const lifecycle = realm({ isReferenced: () => false });
      lifecycle.markReady({ ok: false });

      const outcome = lifecycle.restart();

      expect(outcome).toEqual({ ok: false, reason: 'unreferenced' });
      expect(lifecycle.state).toBe('crashed');
      expect(lifecycle.restartCount).toBe(0);
    });

    it('refuses restart once the restart budget is exhausted', () => {
      const lifecycle = realm({ isReferenced: () => true, maxRestarts: 1 });
      lifecycle.markReady({ ok: false });
      expect(lifecycle.restart()).toEqual({ ok: true });
      expect(lifecycle.state).toBe('warming');

      // Fail the second Warming's ready handshake and try a second restart
      // against the same budget.
      lifecycle.markReady({ ok: false });
      const secondOutcome = lifecycle.restart();

      expect(secondOutcome).toEqual({ ok: false, reason: 'restart-budget-exceeded' });
      expect(lifecycle.state).toBe('crashed');
      expect(lifecycle.restartCount).toBe(1);
    });

    it('restart() from a non-Crashed state throws rather than returning a refusal', () => {
      const lifecycle = realm();
      expect(() => lifecycle.restart()).toThrow(RealmLifecycleTransitionError);
    });
  });

  describe('onTransition', () => {
    it('emits every transition synchronously, in order', () => {
      const lifecycle = realm();
      const observed: RealmLifecycleTransition[] = [];
      lifecycle.onTransition((transition) => observed.push(transition));

      lifecycle.markReady({ ok: true });
      lifecycle.activate();
      lifecycle.beginDrain();

      expect(observed).toEqual([
        { from: 'warming', to: 'ready' },
        { from: 'ready', to: 'active' },
        { from: 'active', to: 'draining' },
      ]);
    });

    it('stops notifying an unsubscribed listener', () => {
      const lifecycle = realm();
      const observed: RealmLifecycleTransition[] = [];
      const unsubscribe = lifecycle.onTransition((transition) => observed.push(transition));

      lifecycle.markReady({ ok: true });
      unsubscribe();
      lifecycle.activate();

      expect(observed).toEqual([{ from: 'warming', to: 'ready' }]);
    });
  });
});
