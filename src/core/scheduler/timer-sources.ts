import type { Storage } from '../../storage/interface.ts';
import { tryDecodeStorageKeyComponent } from '../../storage/interface.ts';
import { decode } from '../codec.ts';
import type { TimerEntry } from '../types.ts';
import { isTimerEntry } from './timer-batch.ts';

export type ScannedTimerEntry = {
  key: string;
  entry: TimerEntry;
};

export type TimerSource = {
  iterator: AsyncIterator<[string, Uint8Array]>;
  next: ScannedTimerEntry | null;
  readNext: (
    iterator: AsyncIterator<[string, Uint8Array]>,
    storage: Storage,
  ) => Promise<ScannedTimerEntry | null>;
};

export function compareScannedTimerEntries(
  left: ScannedTimerEntry,
  right: ScannedTimerEntry,
): number {
  if (left.entry.fireAt !== right.entry.fireAt) {
    return left.entry.fireAt - right.entry.fireAt;
  }

  return left.key.localeCompare(right.key);
}

export async function readNextScannedTimerEntry(
  iterator: AsyncIterator<[string, Uint8Array]>,
  storage: Storage,
): Promise<ScannedTimerEntry | null> {
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      return null;
    }

    const [key, value] = next.value;
    const decoded = decode(value);
    if (!isTimerEntry(decoded)) {
      console.error(`Corrupted timer entry at ${key}: removing`);
      await storage.delete(key);
      continue;
    }

    return { key, entry: decoded };
  }
}

async function readNextWorkflowTimerEntry(
  iterator: AsyncIterator<[string, Uint8Array]>,
  storage: Storage,
  kind: 'terminal-cleanup' | 'teardown',
): Promise<ScannedTimerEntry | null> {
  const { diagnosticName, prefix } =
    kind === 'terminal-cleanup'
      ? { diagnosticName: 'terminal cleanup', prefix: 'wf-cleanup:' }
      : { diagnosticName: 'teardown timer', prefix: 'wf-teardown:' };

  while (true) {
    const next = await iterator.next();
    if (next.done) {
      return null;
    }

    const [key, value] = next.value;
    const separatorIndex = key.indexOf(':', prefix.length);
    const fireAtValue =
      separatorIndex === -1 ? Number.NaN : Number(key.slice(prefix.length, separatorIndex));
    const timerId =
      separatorIndex === -1 ? null : tryDecodeStorageKeyComponent(key.slice(separatorIndex + 1));
    const decodedWorkflowId = decode(value);

    if (
      !Number.isSafeInteger(fireAtValue) ||
      fireAtValue < 0 ||
      timerId === null ||
      typeof decodedWorkflowId !== 'string'
    ) {
      console.error(`Corrupted ${diagnosticName} entry at ${key}: removing`);
      await storage.delete(key);
      continue;
    }

    return {
      key,
      entry: {
        id: timerId,
        workflowId: decodedWorkflowId,
        fireAt: fireAtValue,
        kind,
      },
    };
  }
}

export async function readNextTerminalCleanupTimerEntry(
  iterator: AsyncIterator<[string, Uint8Array]>,
  storage: Storage,
): Promise<ScannedTimerEntry | null> {
  return readNextWorkflowTimerEntry(iterator, storage, 'terminal-cleanup');
}

export async function readNextTeardownTimerEntry(
  iterator: AsyncIterator<[string, Uint8Array]>,
  storage: Storage,
): Promise<ScannedTimerEntry | null> {
  return readNextWorkflowTimerEntry(iterator, storage, 'teardown');
}

export async function advanceTimerSource(
  timerSource: TimerSource,
  storage: Storage,
): Promise<void> {
  timerSource.next = await timerSource.readNext(timerSource.iterator, storage);
}

export function selectNextTimerSource(timerSources: TimerSource[]): TimerSource | undefined {
  let selectedSource: TimerSource | undefined;

  for (const timerSource of timerSources) {
    if (timerSource.next === null) {
      continue;
    }

    if (
      selectedSource === undefined ||
      compareScannedTimerEntries(timerSource.next, selectedSource.next!) < 0
    ) {
      selectedSource = timerSource;
    }
  }

  return selectedSource;
}

/**
 * `true` for a timer kind whose `timer-idx:` reverse-index entry is safe to
 * delete unconditionally on fire, with no read-and-compare first.
 * `'terminal-cleanup'`/`'teardown'` get no reverse index at all (never
 * cancelled out-of-band). `'schedule'`/`'sleep'`/`'wait-condition'` are
 * EXCLUDED even though this function's signature still accepts them —
 * `scheduler-class.ts`'s `#buildTimerIndexDeleteOperation` checks those three
 * kinds and routes them through the lookup-and-compare path BEFORE ever
 * calling this function, because each can have its deterministic id re-armed
 * by a legitimate successor (schedule's own re-arm-on-every-tick; a
 * `start-new` replacement reusing a sleep/wait-condition id) while the
 * original fire is still being cleaned up.
 */
export function shouldDeleteTimerIndexWithoutLookup(entry: TimerEntry): boolean {
  return (
    entry.kind !== 'schedule' &&
    entry.kind !== 'terminal-cleanup' &&
    entry.kind !== 'teardown' &&
    entry.kind !== 'sleep' &&
    entry.kind !== 'wait-condition'
  );
}
