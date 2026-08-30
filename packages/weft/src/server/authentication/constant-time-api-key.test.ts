import { describe, expect, it } from 'bun:test';

import {
  createConstantTimeApiKeyMatcher,
  findConstantTimeApiKeyMatch,
} from './constant-time-api-key.ts';

describe('constant-time API key matching', () => {
  it('accepts valid keys and rejects invalid keys without depending on raw key length', () => {
    const matcher = createConstantTimeApiKeyMatcher(['alpha-key', 'beta-key-longer']);

    expect(matcher.matches('alpha-key')).toBe(true);
    expect(matcher.matches('beta-key-longer')).toBe(true);
    expect(matcher.matches('a')).toBe(false);
    expect(matcher.matches('beta-key-longer-but-wrong')).toBe(false);
  });

  it('returns the matched entry after scanning fixed-length digests', () => {
    const registrations = [
      { key: 'first-key', value: { subject: 'first' } },
      { key: 'second-key', value: { subject: 'second' } },
      { key: 'third-key', value: { subject: 'third' } },
    ];
    const matcher = createConstantTimeApiKeyMatcher(registrations);

    expect(findConstantTimeApiKeyMatch('second-key', matcher.entries)?.value).toEqual({
      subject: 'second',
    });
    expect(findConstantTimeApiKeyMatch('missing-key', matcher.entries)).toBeNull();
  });
});
