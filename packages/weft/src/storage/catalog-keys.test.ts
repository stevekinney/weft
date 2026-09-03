import { describe, expect, it } from 'bun:test';

import { WORKFLOW_CATALOG_KEYS } from './catalog-keys.ts';

describe('WORKFLOW_CATALOG_KEYS', () => {
  it('encodes catalogEntry as catalog-entry:<name>:<revision>', () => {
    expect(WORKFLOW_CATALOG_KEYS.catalogEntry('checkout', 'sha256:abc')).toBe(
      'catalog-entry:checkout:sha256%3Aabc',
    );
  });

  it('encodes catalogEntryPrefix as the scan prefix for every revision of a name', () => {
    const prefix = WORKFLOW_CATALOG_KEYS.catalogEntryPrefix('checkout');
    expect(prefix).toBe('catalog-entry:checkout:');
    expect(WORKFLOW_CATALOG_KEYS.catalogEntry('checkout', 'sha256:abc').startsWith(prefix)).toBe(
      true,
    );
  });

  it('encodes catalogActive as catalog-active:<name>', () => {
    expect(WORKFLOW_CATALOG_KEYS.catalogActive('checkout')).toBe('catalog-active:checkout');
  });

  it('encodes names containing colons or reserved-looking segments safely', () => {
    expect(WORKFLOW_CATALOG_KEYS.catalogEntry('a:b', '__proto__')).toBe(
      'catalog-entry:a%3Ab:__proto__',
    );
    expect(WORKFLOW_CATALOG_KEYS.catalogActive('__proto__')).toBe('catalog-active:__proto__');
  });
});
