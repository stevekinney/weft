import { toPublic } from '@lostgradient/environmentalist';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  readEnvironmentVariable,
  resolveCliEnvironment,
  resolveEngineEnvironment,
} from './environment-configuration.ts';

const names = [
  'WEFT_DEV_WARNINGS',
  'NODE_ENV',
  'WEFT_TOKEN',
  'WEFT_ADDR',
  'ci.Token_with__underscores',
] as const;
const saved = Object.fromEntries(names.map((name) => [name, Bun.env[name]]));

afterEach(() => {
  for (const name of names) {
    const value = saved[name];
    if (value === undefined) delete Bun.env[name];
    else Bun.env[name] = value;
  }
});

describe('environment configuration', () => {
  it('resolves current values on every call with the existing flag semantics', () => {
    Bun.env['WEFT_DEV_WARNINGS'] = '1';
    expect(resolveEngineEnvironment().weftDevWarnings).toBe(true);
    Bun.env['WEFT_DEV_WARNINGS'] = '0';
    expect(resolveEngineEnvironment().weftDevWarnings).toBe(false);
  });

  it('reads exact dynamic names without normalizing underscores or casing', () => {
    Bun.env['ci.Token_with__underscores'] = 'exact-value';
    expect(readEnvironmentVariable('ci.Token_with__underscores')).toBe('exact-value');
    Bun.env['ci.Token_with__underscores'] = '';
    expect(readEnvironmentVariable('ci.Token_with__underscores')).toBe('');
    delete Bun.env['ci.Token_with__underscores'];
    expect(readEnvironmentVariable('ci.Token_with__underscores')).toBeUndefined();
  });

  it('redacts configured credentials in the public environment projection', () => {
    Bun.env['WEFT_TOKEN'] = 'secret-value';
    const environment = resolveCliEnvironment();
    expect(toPublic(environment)).not.toHaveProperty('weftToken');
  });
});
