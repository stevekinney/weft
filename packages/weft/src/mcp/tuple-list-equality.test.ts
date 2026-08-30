import { describe, expect, it } from 'bun:test';

import { tupleListsEqual } from './tuple-list-equality.ts';

type Entry = readonly [string, number];

const entryEqual = (left: Entry, right: Entry): boolean =>
  left[0] === right[0] && left[1] === right[1];

describe('tupleListsEqual', () => {
  it('treats empty lists as equal', () => {
    expect(tupleListsEqual<Entry>([], [], entryEqual)).toBe(true);
  });

  it('compares ordered tuple entries and preserves duplicate handling', () => {
    const first: Entry = ['first', 1];
    const second: Entry = ['second', 2];
    expect(tupleListsEqual([first, second, first], [first, second, first], entryEqual)).toBe(true);
    expect(tupleListsEqual([first, second, first], [first, first, second], entryEqual)).toBe(false);
  });

  it('rejects length and tuple-field mismatches', () => {
    const first: Entry = ['first', 1];
    expect(tupleListsEqual([first], [], entryEqual)).toBe(false);
    expect(tupleListsEqual([first], [['first', 2]], entryEqual)).toBe(false);
  });

  it('rejects sparse and explicit undefined entries', () => {
    const sparse: Entry[] = [];
    sparse.length = 1;
    const withUndefined: Entry[] = [['placeholder', 0]];
    Object.defineProperty(withUndefined, 0, { value: undefined });

    expect(tupleListsEqual(sparse, sparse, entryEqual)).toBe(false);
    expect(tupleListsEqual(withUndefined, withUndefined, entryEqual)).toBe(false);
  });
});
