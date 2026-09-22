/**
 * Fixture for the "Turso's driver import is deferred, not just moved"
 * subprocess gate.
 *
 * Run under `bun --preload block-optional-storage-drivers.test-support.ts`.
 * Constructing `TursoStorage` must not need `@libsql/client`; only its first
 * real operation may. That distinguishes "the import moved to first use"
 * from "the import was removed" — a `TursoStorage` that never threw at all
 * here would just mean nobody proved it still calls the driver.
 *
 * @module storage/turso-driver-deferred-fixture
 */
import { TursoStorage } from './turso.ts';

// Construction alone must not require the optional driver.
const storage = new TursoStorage({ url: 'file::memory:' });

let rejectedWithMissingDriver = false;
try {
  await storage.get('anything');
} catch (error) {
  rejectedWithMissingDriver =
    error instanceof Error && /cannot find module|resolving package/i.test(error.message);
  if (!rejectedWithMissingDriver) throw error;
}

if (!rejectedWithMissingDriver) {
  throw new Error(
    'expected the first operation to reject once the optional @libsql/client driver is unresolvable',
  );
}

console.info('ok');
