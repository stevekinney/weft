import { describe, expect, it } from 'bun:test';

import { assertReadOnlyQuery } from './read-only-query';

describe('assertReadOnlyQuery', () => {
  it('rejects empty queries after normalization', () => {
    expect(() => assertReadOnlyQuery('   ;;;   ')).toThrow('Storage query must not be empty.');
  });

  it('allows SELECT statements with non-space word boundaries', () => {
    expect(() => assertReadOnlyQuery('SELECT\nkey FROM kv')).not.toThrow();
    expect(() => assertReadOnlyQuery('SELECT\tkey FROM kv')).not.toThrow();
  });

  it('allows bare PRAGMA statements with non-space word boundaries', () => {
    expect(() => assertReadOnlyQuery('PRAGMA\njournal_mode')).not.toThrow();
    expect(() => assertReadOnlyQuery('PRAGMA\tmain.journal_mode')).not.toThrow();
  });

  it('rejects write PRAGMA statements that use equals syntax', () => {
    expect(() => assertReadOnlyQuery('PRAGMA journal_mode = WAL')).toThrow(
      'Storage query only supports read-only SELECT and PRAGMA statements.',
    );
  });

  it('rejects write PRAGMA statements that use parenthesized syntax', () => {
    expect(() => assertReadOnlyQuery('PRAGMA journal_mode(WAL)')).toThrow(
      'Storage query only supports read-only SELECT and PRAGMA statements.',
    );
    expect(() => assertReadOnlyQuery('PRAGMA synchronous(OFF)')).toThrow(
      'Storage query only supports read-only SELECT and PRAGMA statements.',
    );
  });
});
