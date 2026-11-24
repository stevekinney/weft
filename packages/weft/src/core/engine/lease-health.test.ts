import { describe, expect, it, spyOn } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { waitUntil } from "../../../test-support/embedded/testing/src/wait-until.ts";
import { LeaseHealthChangedEvent } from '../events/fleet-state-events.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { handleDeposition } from './lease-deposition.ts';

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

describe('lease:health-changed', () => {
  function collectStatuses(engine: Engine): string[] {
    const statuses: string[] = [];
    engine.addEventListener(LeaseHealthChangedEvent.type, (event) => {
      statuses.push(event.status);
    });
    return statuses;
  }

  it('is never dispatched when lease ownership is not configured', async () => {
    await using engine = await Engine.create({ storage: new MemoryStorage(), recover: false });
    const statuses = collectStatuses(engine);

    await engine.recoverAll();

    expect(statuses).toEqual([]);
  });

  it('is dispatched once when acquisition moves the status from no-lease to healthy', async () => {
    await using engine = new Engine({ ownership: 'lease', storage: new MemoryStorage() });
    const statuses = collectStatuses(engine);

    await engine.recoverAll();
    await engine.recoverAll();

    expect(statuses).toEqual(['healthy']);
    expect(engine.getLeaseHealth().status).toBe('healthy');
  });

  it('is dispatched once on deposition and keeps the process warning, however often it is detected', async () => {
    const warning = spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      await using engine = new Engine({ ownership: 'lease', storage: new MemoryStorage() });
      await engine.recoverAll();
      const statuses = collectStatuses(engine);
      const internals = getInternals(engine);

      handleDeposition(internals);
      handleDeposition(internals);

      expect(statuses).toEqual(['contested']);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  it('is dispatched when a renewal settles after the lease expired while the renewal ran', async () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    let expireDuringNextCommit = false;
    const conditionalBatch = storage.conditionalBatch.bind(storage);
    storage.conditionalBatch = async (...parameters) => {
      if (expireDuringNextCommit) {
        expireDuringNextCommit = false;
        now += 1_000_000;
      }
      return conditionalBatch(...parameters);
    };
    await using engine = new Engine({
      ownership: 'lease',
      storage,
      getNow: () => now,
      leaseTtl: 10_000,
      leaseRenewInterval: 5,
    });
    const statuses = collectStatuses(engine);
    await engine.recoverAll();
    expireDuringNextCommit = true;

    await waitUntil(() => statuses.includes('contested'), {
      message: 'the settled renewal to announce the expired lease',
    });

    expect(statuses.slice(0, 2)).toEqual(['healthy', 'contested']);
  });
});
