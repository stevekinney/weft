import type { Environment } from '@lostgradient/environmentalist';
import { environmentalist, secret } from '@lostgradient/environmentalist';
import type { Source } from '@lostgradient/environmentalist/types';
import { z } from 'zod';

// `process.env` is the environment on Bun and Node alike; a browser or edge isolate has no
// `process`, so it reads as empty.
function rawRuntimeEnvironment(): Record<string, string | undefined> {
  return typeof process === 'undefined' ? {} : process.env;
}

function selectedEnvironment(mapping: Readonly<Record<string, string>>): Record<string, string> {
  const raw = rawRuntimeEnvironment();
  return Object.fromEntries(
    Object.entries(mapping)
      .map(([canonical, variable]) => [
        canonical,
        Object.hasOwn(raw, variable) ? raw[variable] : undefined,
      ])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function createEnvironmentSource(mapping: Readonly<Record<string, string>>): Source {
  return {
    id: 'weft-runtime-environment',
    kind: 'string',
    load: () => ({ values: selectedEnvironment(mapping), location: 'runtime environment' }),
    loadSync: () => ({ values: selectedEnvironment(mapping), location: 'runtime environment' }),
  };
}

const engineSchema = z.object({
  weftDevWarnings: z
    .string()
    .optional()
    .transform((value) => value === '1')
    .meta({ env: 'WEFT_DEV_WARNINGS' }),
  nodeEnv: z.string().optional().meta({ env: 'NODE_ENV' }),
});
export type EngineEnvironment = Environment<typeof engineSchema>;
export function resolveEngineEnvironment(): EngineEnvironment {
  return environmentalist.sync({
    name: 'weft-engine',
    schema: engineSchema,
    sources: [
      createEnvironmentSource({
        weftDevWarnings: 'WEFT_DEV_WARNINGS',
        nodeEnv: 'NODE_ENV',
      }),
      'defaults',
    ],
    argv: [],
    coerce: false,
  });
}

const cliSchema = z.object({
  weftToken: secret(z.string().optional()).meta({ env: 'WEFT_TOKEN' }),
  weftAddr: z.string().optional().meta({ env: 'WEFT_ADDR' }),
  weftProfile: z.string().optional().meta({ env: 'WEFT_PROFILE' }),
  weftHome: z.string().optional().meta({ env: 'WEFT_HOME' }),
  home: z.string().optional().meta({ env: 'HOME' }),
  noColor: z.string().optional().meta({ env: 'NO_COLOR' }),
  forceColor: z.string().optional().meta({ env: 'FORCE_COLOR' }),
  path: z.string().optional().meta({ env: 'PATH' }),
  tmpdir: z.string().optional().meta({ env: 'TMPDIR' }),
  temp: z.string().optional().meta({ env: 'TEMP' }),
  tmp: z.string().optional().meta({ env: 'TMP' }),
  tz: z.string().optional().meta({ env: 'TZ' }),
  nodeEnv: z.string().optional().meta({ env: 'NODE_ENV' }),
});
export type CliEnvironment = Environment<typeof cliSchema>;
export function resolveCliEnvironment(): CliEnvironment {
  return environmentalist.sync({
    name: 'weft-cli',
    schema: cliSchema,
    sources: [
      createEnvironmentSource({
        weftToken: 'WEFT_TOKEN',
        weftAddr: 'WEFT_ADDR',
        weftProfile: 'WEFT_PROFILE',
        weftHome: 'WEFT_HOME',
        home: 'HOME',
        noColor: 'NO_COLOR',
        forceColor: 'FORCE_COLOR',
        path: 'PATH',
        tmpdir: 'TMPDIR',
        temp: 'TEMP',
        tmp: 'TMP',
        tz: 'TZ',
        nodeEnv: 'NODE_ENV',
      }),
      'defaults',
    ],
    argv: [],
    coerce: false,
  });
}

const serverSchema = z.object({
  weftServerAuthenticationRequired: z
    .string()
    .optional()
    .meta({ env: 'WEFT_SERVER_AUTHENTICATION_REQUIRED' }),
  nodeEnv: z.string().optional().meta({ env: 'NODE_ENV' }),
  weftAllowUntrustedApiCatalogOrigin: z
    .string()
    .optional()
    .transform((value) => value === '1')
    .meta({ env: 'WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN' }),
  weftStrictFaults: z
    .string()
    .optional()
    .transform((value) => value === '1')
    .meta({ env: 'WEFT_STRICT_FAULTS' }),
});
export type ServerEnvironment = Environment<typeof serverSchema>;
export function resolveServerEnvironment(): ServerEnvironment {
  return environmentalist.sync({
    name: 'weft-server',
    schema: serverSchema,
    sources: [
      createEnvironmentSource({
        weftServerAuthenticationRequired: 'WEFT_SERVER_AUTHENTICATION_REQUIRED',
        nodeEnv: 'NODE_ENV',
        weftAllowUntrustedApiCatalogOrigin: 'WEFT_ALLOW_UNTRUSTED_API_CATALOG_ORIGIN',
        weftStrictFaults: 'WEFT_STRICT_FAULTS',
      }),
      'defaults',
    ],
    argv: [],
    coerce: false,
  });
}

/** Read one exact environment variable name for dynamic credential lookup. */
export function readEnvironmentVariable(name: string): string | undefined {
  // One reader serves both entry points, so the asynchronous `load` cannot drift from the
  // synchronous `loadSync` that `environmentalist.sync` actually calls.
  const readExactVariable = () => {
    const environment = rawRuntimeEnvironment();
    const value = Object.hasOwn(environment, name) ? environment[name] : undefined;
    return value === undefined
      ? undefined
      : { values: { value }, location: `runtime environment:${name}` };
  };
  const exactSource: Source = {
    id: 'weft-runtime-environment',
    kind: 'string',
    load: readExactVariable,
    loadSync: readExactVariable,
  };
  return environmentalist.sync({
    name: 'weft-dynamic-secret',
    schema: z.object({ value: secret(z.string().optional()) }),
    sources: [exactSource, 'defaults'],
    argv: [],
    coerce: false,
  }).value;
}
