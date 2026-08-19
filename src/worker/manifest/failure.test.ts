import { describe, expect, it } from 'bun:test';

import { manifestFailure } from './failure.ts';
import { utf8ByteLength, utf8Encode } from './utf8.ts';

describe('manifestFailure', () => {
  it('prefixes the message with the offending path', () => {
    const failure = manifestFailure(
      'invalid_field',
      'must be a non-empty string',
      'manifest.sdkVersion',
    );

    expect(failure.message).toBe('manifest.sdkVersion must be a non-empty string');
    expect(failure.path).toBe('manifest.sdkVersion');
  });

  it('omits the path property entirely when no path applies', () => {
    const failure = manifestFailure('not_an_object', 'manifest must be a JSON object');

    expect(failure.message).toBe('manifest must be a JSON object');
    expect('path' in failure).toBe(false);
  });

  it('always reports ok as false', () => {
    expect(manifestFailure('invalid_json', 'bad').ok).toBe(false);
  });
});

describe('utf8 helpers', () => {
  it('counts ASCII as one byte per character', () => {
    expect(utf8ByteLength('abc')).toBe(3);
  });

  it('counts an astral-plane character as four bytes', () => {
    expect(utf8ByteLength('🙂')).toBe(4);
    expect('🙂'.length).toBe(2);
  });

  it('encodes to the same bytes it measures', () => {
    expect(utf8Encode('🙂').byteLength).toBe(utf8ByteLength('🙂'));
  });
});
