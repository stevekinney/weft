import { describe, expect, it } from 'bun:test';

import { findNearestCandidate, formatUnknownCommandError } from './command-suggestions.ts';

// Fixtures use same-length strings differing only by single-character
// substitutions, so each pair's Levenshtein distance equals the number of
// differing positions — easy to verify by reading the strings.

describe('findNearestCandidate', () => {
  it('picks the closest candidate (distance 1 beats distance 4)', () => {
    // 'aaaaaa' -> 'aaaaab' is distance 1; 'aaaaaa' -> 'aabbbb' is distance 4.
    const nearest = findNearestCandidate('aaaaaa', ['aabbbb', 'aaaaab'], 6);
    expect(nearest).toBe('aaaaab');
  });

  it('returns the first candidate when two candidates are equidistant', () => {
    // 'abcd' -> 'xbcd' (distance 1) and 'abcd' -> 'abcx' (distance 1) are tied.
    // The inner comparison is strict `<`, so the first candidate in iteration
    // order wins. This pins the tie-break against an accidental switch to `<=`.
    const nearest = findNearestCandidate('abcd', ['xbcd', 'abcx'], 6);
    expect(nearest).toBe('xbcd');
  });

  it('accepts a candidate at exactly maxDistance (distance 6, maxDistance 6)', () => {
    // 'aaaaaa' -> 'bbbbbb' substitutes all six positions: distance 6.
    const nearest = findNearestCandidate('aaaaaa', ['bbbbbb'], 6);
    expect(nearest).toBe('bbbbbb');
  });

  it('rejects a candidate just past maxDistance (distance 7, maxDistance 6)', () => {
    // 'aaaaaaa' -> 'bbbbbbb' substitutes all seven positions: distance 7.
    const nearest = findNearestCandidate('aaaaaaa', ['bbbbbbb'], 6);
    expect(nearest).toBeUndefined();
  });

  it('honors a caller-supplied threshold of 2: accepts a distance-2 candidate', () => {
    // 'aa' -> 'bb' substitutes both positions: distance 2.
    const nearest = findNearestCandidate('aa', ['bb'], 2);
    expect(nearest).toBe('bb');
  });

  it('honors a caller-supplied threshold of 2: rejects a distance-6 candidate', () => {
    // Same distance-6 pair the operation surface (maxDistance 6) would accept
    // is rejected under the subcommand surface's stricter threshold of 2.
    const nearest = findNearestCandidate('aaaaaa', ['bbbbbb'], 2);
    expect(nearest).toBeUndefined();
  });

  it('returns undefined when given no candidates', () => {
    expect(findNearestCandidate('anything', [], 6)).toBeUndefined();
  });
});

describe('formatUnknownCommandError', () => {
  it('suggests the nearest subcommand within the distance-2 threshold', () => {
    // 'studio' -> 'studi' is distance 1, within the threshold of 2.
    const message = formatUnknownCommandError('studi', ['studio', 'server']);
    expect(message).toBe("Unknown command 'studi'. Did you mean 'studio'?");
  });

  it('omits a suggestion when the nearest subcommand exceeds the threshold', () => {
    // 'xyzzy' is distance 6 from 'studio' and distance 6 from 'server',
    // both far past the threshold of 2.
    const message = formatUnknownCommandError('xyzzy', ['studio', 'server']);
    expect(message).toBe("Unknown command 'xyzzy'");
  });
});
