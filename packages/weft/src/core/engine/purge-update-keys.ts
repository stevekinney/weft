import { type Storage as WeftStorage, storageKeys } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';

async function collectKeys(storage: WeftStorage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of storageKeys(storage, prefix)) keys.push(key);
  return keys;
}

/**
 * Every update key a purge removes for `workflowId`, added to `deleteKeys`:
 *
 * - the requests still pending (`upd:`) and the responses they could already have (`upr:`);
 * - the update history (`uph:`, COR-1463) and the answered responses it names that the five-minute
 *   sweep has not yet removed. A request still pending is found by its `upd:` key; an answered
 *   one only by its history entry.
 *
 * Terminal cleanup touches none of these, so a finished run keeps its history until it is purged.
 */
export async function addUpdateDeleteKeys(
  storage: WeftStorage,
  deleteKeys: Set<string>,
  workflowId: string,
): Promise<void> {
  const requestPrefix = KEYS.updatePrefix(workflowId);
  for (const key of await collectKeys(storage, requestPrefix)) {
    deleteKeys.add(key);
    addResponseKey(deleteKeys, key.slice(requestPrefix.length));
  }

  for (const key of await collectKeys(storage, KEYS.updateHistoryPrefix(workflowId))) {
    deleteKeys.add(key);
    // `<receivedAt>:<updateId>`: an update id is a UUID, so it holds no colon.
    addResponseKey(deleteKeys, key.slice(key.lastIndexOf(':') + 1));
  }
}

function addResponseKey(deleteKeys: Set<string>, updateId: string): void {
  if (updateId.length > 0) deleteKeys.add(KEYS.updateResponse(updateId));
}
