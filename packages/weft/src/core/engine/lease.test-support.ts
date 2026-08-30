import { KEYS, type Storage } from '../../storage/interface.ts';

type GatePhase = 'beforeCommit' | 'afterCommit';

type GatedLeaseHolderWriteStorageOptions = {
  gateOnHolderPut: number;
  phase: GatePhase;
};

type GatedLeaseHolderWriteStorage = {
  readonly storage: Storage;
  readonly reached: Promise<void>;
  readonly holderPutCount: () => number;
  release(): void;
};

export function createGatedLeaseHolderWriteStorage(
  baseStorage: Storage,
  options: GatedLeaseHolderWriteStorageOptions,
): GatedLeaseHolderWriteStorage {
  let holderPuts = 0;
  let releaseGate!: () => void;
  let signalReached!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    signalReached = resolve;
  });

  return {
    holderPutCount: () => holderPuts,
    reached,
    release: releaseGate,
    storage: {
      capabilities: () => baseStorage.capabilities(),
      get: (key) => baseStorage.get(key),
      put: (key, value) => baseStorage.put(key, value),
      delete: (key) => baseStorage.delete(key),
      scan: (prefix, scanOptions) => baseStorage.scan(prefix, scanOptions),
      batch: (operations) => baseStorage.batch(operations),
      conditionalBatch: async (conditions, operations) => {
        if (baseStorage.conditionalBatch === undefined) {
          throw new Error('Lease holder write gate requires conditionalBatch support.');
        }
        const isHolderPut = operations.some(
          (operation) => operation.type === 'put' && operation.key === KEYS.leaseHolder(),
        );
        if (isHolderPut) holderPuts += 1;
        const shouldGate = isHolderPut && holderPuts === options.gateOnHolderPut;
        if (shouldGate && options.phase === 'beforeCommit') {
          signalReached();
          await gate;
        }
        const committed = await baseStorage.conditionalBatch(conditions, operations);
        if (shouldGate && options.phase === 'afterCommit') {
          signalReached();
          await gate;
        }
        return committed;
      },
      [Symbol.dispose]: () => baseStorage[Symbol.dispose](),
    },
  };
}

type LeaseHolderReadProbeStorage = {
  readonly parked: Promise<void>;
  readonly storage: Storage;
};

export function createLeaseHolderReadProbeStorage(
  baseStorage: Storage,
  readsUntilParked = 2,
): LeaseHolderReadProbeStorage {
  let holderReads = 0;
  let signalParked!: () => void;
  const parked = new Promise<void>((resolve) => {
    signalParked = resolve;
  });

  return {
    parked,
    storage: {
      capabilities: () => baseStorage.capabilities(),
      get: (key) => {
        if (key === KEYS.leaseHolder()) {
          holderReads += 1;
          if (holderReads >= readsUntilParked) signalParked();
        }
        return baseStorage.get(key);
      },
      put: (key, value) => baseStorage.put(key, value),
      delete: (key) => baseStorage.delete(key),
      scan: (prefix, scanOptions) => baseStorage.scan(prefix, scanOptions),
      batch: (operations) => baseStorage.batch(operations),
      conditionalBatch: (conditions, operations) => {
        if (baseStorage.conditionalBatch === undefined) {
          throw new Error('Lease holder read probe requires conditionalBatch support.');
        }
        return baseStorage.conditionalBatch(conditions, operations);
      },
      [Symbol.dispose]: () => baseStorage[Symbol.dispose](),
    },
  };
}
