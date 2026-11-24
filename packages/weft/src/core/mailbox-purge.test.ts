/**
 * `Mailbox.purge` (COR-1934): a host that retires a resource must be able to forget what was sent
 * to it, payloads included, without waiting for terminal retention, and without touching another
 * mailbox of the same storage.
 */

import { describe, expect, it } from 'bun:test';

import { KEYS } from '../storage/keys.ts';
import { collectKeys } from '../testing/storage-backends.test-support.ts';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { rejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { MailboxContentionError } from './mailbox-internals.ts';
import { ApplicationCommandValidationError } from './mailbox-validation.ts';
import { admitOne, claimOne, commandInput, createMailboxFixture } from './mailbox.test-support.ts';

const SECRET = 'PAYLOAD-SENTINEL-42';
/** The header key of the fixture's mailbox, which a purge seals rather than deletes. */
const header = (resourceId = 'agent-7') => KEYS.applicationMailbox('bureau', resourceId);

async function everythingStored(storage: MemoryStorage): Promise<string> {
  const parts: string[] = [];
  for (const key of await collectKeys(storage, '')) {
    parts.push(key, Buffer.from((await storage.get(key)) ?? new Uint8Array()).toString('latin1'));
  }
  return parts.join('\n');
}

describe('Mailbox.purge', () => {
  it('removes every key family of a mailbox with open, claimed and terminal commands, payloads included', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    const payload = { form: 'inline', value: { text: SECRET } } as const;
    await admitOne(mailbox, { payload, idempotencyKey: 'first' });
    await admitOne(mailbox, { payload, idempotencyKey: 'second' });
    await admitOne(mailbox, { payload, idempotencyKey: 'third' });
    // One command settles, one stays claimed, one stays open.
    const settled = await claimOne(mailbox);
    await mailbox.acknowledge({ commandId: settled.commandId, attemptToken: settled.attemptToken });
    await claimOne(mailbox);
    expect(await everythingStored(storage)).toContain(SECRET);
    const stored = await collectKeys(storage, '');
    const families = new Set(stored.map((key) => key.split(':')[0]));
    expect([...families]).toEqual(
      expect.arrayContaining(['appcmd', 'appidem', 'appmbx', 'appready', 'appseq', 'appterm']),
    );

    const deleted = await mailbox.purge();

    expect(deleted).toBeGreaterThan(0);
    // Only the sealed header is left, and it holds no payload.
    expect(await collectKeys(storage, '')).toEqual([header()]);
    expect(await everythingStored(storage)).not.toContain(SECRET);
    mailbox.dispose();
  });

  it('leaves another mailbox of the same storage, and one whose resource id extends this one, alone', async () => {
    const storage = new MemoryStorage();
    const purged = createMailboxFixture({ storage, resourceId: 'session-1' });
    const neighbour = createMailboxFixture({ storage, resourceId: 'session-10' });
    const other = createMailboxFixture({ storage, resourceId: 'session-2' });
    for (const { mailbox } of [purged, neighbour, other]) {
      await admitOne(mailbox, { payload: { form: 'inline', value: { text: SECRET } } });
    }
    const allKeys = await collectKeys(storage, '');
    const neighbourKeys = allKeys.filter((key) => key.includes('session-10'));
    expect(neighbourKeys.length).toBeGreaterThan(0);

    await purged.mailbox.purge();

    const left = await collectKeys(storage, '');
    // Only the purged mailbox's sealed header is left under its resource id.
    expect(left.filter((key) => key.includes('session-1:') || key.endsWith(':session-1'))).toEqual([
      header('session-1'),
    ]);
    expect(left.filter((key) => key.includes('session-10'))).toEqual(neighbourKeys);
    expect(left.filter((key) => key.includes('session-2')).length).toBeGreaterThan(0);
    for (const { mailbox } of [purged, neighbour, other]) mailbox.dispose();
  });

  it('answers 0 for a mailbox that holds nothing and when repeated, and refuses every later admission', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    await admitOne(mailbox);
    expect(await mailbox.purge()).toBeGreaterThan(0);
    expect(await mailbox.purge()).toBe(0);
    const refused = await mailbox.admit(commandInput({ idempotencyKey: 'after-purge' }));
    expect(refused).toMatchObject({ status: 'rejected', reason: 'purged' });
    expect(await mailbox.list()).toEqual([]);
    expect(await everythingStored(storage)).not.toContain('after-purge');
    mailbox.dispose();
  });

  it('seals a mailbox that was never admitted to, so a first admission racing the purge is refused', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    expect(await mailbox.purge()).toBe(0);
    expect(await mailbox.admit(commandInput())).toMatchObject({
      status: 'rejected',
      reason: 'purged',
    });
    mailbox.dispose();
  });

  it('refuses an admission that read the header the purge replaced', async () => {
    // The admission reads the header, then the purge seals it, then the admission commits: its
    // compare-and-swap on the header it read fails, and its retry reads the seal.
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    await admitOne(mailbox);
    const originalGet = storage.get.bind(storage);
    let purgedDuringAdmission: Promise<number> | undefined;
    storage.get = async (key: string) => {
      const bytes = await originalGet(key);
      // The first read of the header by the racing admission: purge now, before it commits.
      if (key === header() && purgedDuringAdmission === undefined) {
        storage.get = originalGet;
        purgedDuringAdmission = mailbox.purge();
        await purgedDuringAdmission;
      }
      return bytes;
    };
    const admission = await mailbox.admit(commandInput({ idempotencyKey: 'raced' }));
    expect(admission).toMatchObject({ status: 'rejected', reason: 'purged' });
    expect(await everythingStored(storage)).not.toContain('raced');
    mailbox.dispose();
  });

  it('refuses a disposed handle', async () => {
    const { mailbox } = createMailboxFixture();
    mailbox.dispose();
    expect(await rejectionOf(mailbox.purge())).toBeInstanceOf(ApplicationCommandValidationError);
  });

  it('reports contention when the seal keeps losing its compare-and-swap, and deletes nothing', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    await admitOne(mailbox, { payload: { form: 'inline', value: { text: SECRET } } });
    // Every seal attempt finds the header moved under it: an admission that always wins the race.
    const originalBatch = storage.conditionalBatch.bind(storage);
    storage.conditionalBatch = async (conditions, operations) =>
      conditions.some((condition) => condition.key === header())
        ? false
        : originalBatch(conditions, operations);
    expect(await rejectionOf(mailbox.purge())).toBeInstanceOf(MailboxContentionError);
    expect(await everythingStored(storage)).toContain(SECRET);
    mailbox.dispose();
  });
});
