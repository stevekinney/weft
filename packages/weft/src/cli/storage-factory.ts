import type { Storage } from '../storage/interface.ts';
import type { StorageBackend } from './types.ts';

/**
 * Creates a storage instance based on the selected backend and database path.
 *
 * Uses dynamic imports so that native addons are only loaded when requested.
 */
export async function createStorage(backend: StorageBackend, database: string): Promise<Storage> {
  switch (backend) {
    case 'sqlite': {
      const { BunSQLiteStorage } = await import('../storage/bun-sql.ts');
      return new BunSQLiteStorage(database);
    }
    case 'lmdb': {
      const { LMDBStorage } = await import('../storage/lmdb.ts');
      return new LMDBStorage(database);
    }
    case 'memory':
      return createMemoryStorage();
  }
}

async function createMemoryStorage(): Promise<Storage> {
  const { MemoryStorage } = await import('../storage/memory.ts');
  return new MemoryStorage();
}
