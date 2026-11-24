import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import {
  createRefusingStorage,
  putsKey,
  REFUSED_WRITE_MESSAGE,
} from './storage-write-refusal.test-support.ts';

const BYTES = new Uint8Array([7]);

describe('createRefusingStorage', () => {
  it('records and refuses a single put and a single delete as the writes they are', async () => {
    const refusing = createRefusingStorage(new MemoryStorage());
    refusing.refuse({ matches: putsKey('refused') });
    refusing.refuse({
      matches: (operations) => operations.some(({ type, key }) => type === 'delete' && key === 'x'),
    });
    refusing.arm();

    expect(await rejectionOf(refusing.storage.put('refused', BYTES))).toEqual(
      new Error(REFUSED_WRITE_MESSAGE),
    );
    await refusing.storage.put('allowed', BYTES);
    expect(await rejectionOf(refusing.storage.delete('x'))).toEqual(
      new Error(REFUSED_WRITE_MESSAGE),
    );

    expect(refusing.attempts.map(({ method, outcome }) => [method, outcome])).toEqual([
      ['put', 'refused'],
      ['put', 'passed'],
      ['delete', 'refused'],
    ]);
    expect(await refusing.base.get('refused')).toBeNull();
    expect(await refusing.base.get('allowed')).toEqual(BYTES);
  });

  it('resolves a wait for attempts at once when enough have already been seen', async () => {
    const refusing = createRefusingStorage(new MemoryStorage());
    refusing.arm();
    await refusing.storage.put('seen', BYTES);

    await refusing.whenAttempts(1, putsKey('seen'));

    expect(refusing.attemptsMatching(putsKey('seen'))).toHaveLength(1);
  });
});
