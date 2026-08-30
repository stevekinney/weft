import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';

describe('Engine.getLeaseHealth', () => {
  it('reports disabled when lease ownership is not configured', () => {
    using engine = new Engine({ storage: new MemoryStorage() });

    expect(engine.getLeaseHealth()).toEqual({
      mode: 'none',
      status: 'disabled',
      holdsLease: false,
    });
  });

  it('reports no lease before a lease-mode engine acquires ownership', () => {
    using engine = new Engine({ ownership: 'lease', storage: new MemoryStorage() });

    expect(engine.getLeaseHealth()).toEqual({
      mode: 'lease',
      status: 'no-lease',
      holdsLease: false,
    });
  });

  it('reports the healthy acquired lease from a deterministic clock', async () => {
    await using engine = await Engine.create({
      ownership: 'lease',
      storage: new MemoryStorage(),
      getNow: () => 12_345,
      recover: false,
    });

    expect(engine.getLeaseHealth()).toEqual({
      mode: 'lease',
      status: 'healthy',
      holdsLease: true,
      holderId: expect.any(String),
      heldSince: 12_345,
      expiresAt: 42_345,
      lastRenewedAt: 12_345,
      fencingEpoch: 1,
    });
  });

  it('preserves a confirmed deposition after the lease manager detaches', () => {
    using engine = new Engine({ ownership: 'lease', storage: new MemoryStorage() });
    const internals = getInternals(engine);
    internals.deposed = true;
    internals.leaseManager = null;

    expect(engine.getLeaseHealth()).toEqual({
      mode: 'lease',
      status: 'contested',
      holdsLease: false,
      lossReason: 'deposed',
    });
  });

  it('preserves last-known lease evidence before a deposed manager detaches', async () => {
    await using engine = await Engine.create({
      ownership: 'lease',
      storage: new MemoryStorage(),
      getNow: () => 12_345,
      recover: false,
    });
    getInternals(engine).deposed = true;

    expect(engine.getLeaseHealth()).toEqual({
      mode: 'lease',
      status: 'contested',
      holdsLease: false,
      lossReason: 'deposed',
      holderId: expect.any(String),
      heldSince: 12_345,
      expiresAt: 42_345,
      lastRenewedAt: 12_345,
      fencingEpoch: 1,
    });
  });
});
