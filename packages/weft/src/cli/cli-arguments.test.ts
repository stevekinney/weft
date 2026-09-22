import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { KEYS, encode } from '../index.ts';
import {
  CONFORMANCE_HELP_TEXT,
  DOCTOR_HELP_TEXT,
  HELP_TEXT,
  SCHEDULE_HELP_TEXT,
  TIMELINE_HELP_TEXT,
  VALIDATE_HELP_TEXT,
  VERSION_CHECK_HELP_TEXT,
  createStorage,
  executeDoctor,
  executeVersionCheck,
  splitGlobPattern,
} from './index.ts';

function createTemporaryTypeScriptPath(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), `${prefix}-`)), 'module.ts');
}

function removeTemporaryTypeScriptPath(filePath: string): void {
  rmSync(dirname(filePath), { force: true, recursive: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getOrderHandler(value: unknown): Function {
  if (
    !isRecord(value) ||
    !isRecord(value['order']) ||
    typeof value['order']['handler'] !== 'function'
  ) {
    throw new TypeError('order workflow registration is invalid');
  }
  return value['order']['handler'];
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, unknown, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'next' in value &&
    typeof value.next === 'function' &&
    'return' in value &&
    typeof value.return === 'function' &&
    'throw' in value &&
    typeof value.throw === 'function' &&
    Symbol.asyncIterator in value
  );
}

describe('splitGlobPattern', () => {
  it('returns the original path when no glob characters are present', () => {
    expect(splitGlobPattern('examples/hello-world.ts')).toEqual({
      scanRoot: '.',
      pattern: 'examples/hello-world.ts',
    });
  });

  it('keeps the current directory as the scan root for top-level globs', () => {
    expect(splitGlobPattern('*.ts')).toEqual({
      scanRoot: '.',
      pattern: '*.ts',
    });
  });

  it('splits Windows-style absolute glob patterns into scan root and pattern', () => {
    expect(splitGlobPattern(String.raw`C:\work\examples\**\*.ts`)).toEqual({
      scanRoot: 'C:/work/examples',
      pattern: '**/*.ts',
    });
  });
});

describe('help text', () => {
  it('HELP_TEXT contains doctor subcommand', () => {
    expect(HELP_TEXT).toContain('doctor');
  });

  it('HELP_TEXT contains version:check subcommand', () => {
    expect(HELP_TEXT).toContain('version:check');
  });

  it('HELP_TEXT contains timeline subcommand', () => {
    expect(HELP_TEXT).toContain('timeline');
  });

  it('HELP_TEXT contains schedule subcommand', () => {
    expect(HELP_TEXT).toContain('schedule');
  });

  it('HELP_TEXT contains validate subcommand', () => {
    expect(HELP_TEXT).toContain('validate');
  });

  it('HELP_TEXT contains conformance subcommand', () => {
    expect(HELP_TEXT).toContain('conformance');
  });

  it('HELP_TEXT contains serve subcommand', () => {
    expect(HELP_TEXT).toContain('serve');
  });

  it('HELP_TEXT documents the version command and its leading-token forms', () => {
    expect(HELP_TEXT).toContain('version ');
    expect(HELP_TEXT).toContain('weft --version');
    expect(HELP_TEXT).toContain('weft -v');
    expect(HELP_TEXT).toContain('leading token only');
  });

  it('VALIDATE_HELP_TEXT contains exit codes section', () => {
    expect(VALIDATE_HELP_TEXT).toContain('Exit codes');
    expect(VALIDATE_HELP_TEXT).toContain('0');
    expect(VALIDATE_HELP_TEXT).toContain('1');
    expect(VALIDATE_HELP_TEXT).toContain('2');
  });

  it('VALIDATE_HELP_TEXT contains checks section', () => {
    expect(VALIDATE_HELP_TEXT).toContain('unbounded-retry');
    expect(VALIDATE_HELP_TEXT).toContain('stateful-without-compensator');
  });

  it('VALIDATE_HELP_TEXT contains --json and --help flags', () => {
    expect(VALIDATE_HELP_TEXT).toContain('--json');
    expect(VALIDATE_HELP_TEXT).toContain('--help');
  });

  it('VALIDATE_HELP_TEXT documents JSON output shape and load-error precedence', () => {
    expect(VALIDATE_HELP_TEXT).toContain('{ entries, valid, hasLoadErrors, hasValidationErrors }');
    expect(VALIDATE_HELP_TEXT).toContain('takes precedence over validation errors');
  });

  it('DOCTOR_HELP_TEXT contains --database flag', () => {
    expect(DOCTOR_HELP_TEXT).toContain('--database');
  });

  it('DOCTOR_HELP_TEXT contains --json flag', () => {
    expect(DOCTOR_HELP_TEXT).toContain('--json');
  });

  it('DOCTOR_HELP_TEXT contains --help flag', () => {
    expect(DOCTOR_HELP_TEXT).toContain('--help');
  });

  it('VERSION_CHECK_HELP_TEXT contains --database flag', () => {
    expect(VERSION_CHECK_HELP_TEXT).toContain('--database');
  });

  it('VERSION_CHECK_HELP_TEXT contains --workflows flag', () => {
    expect(VERSION_CHECK_HELP_TEXT).toContain('--workflows');
  });

  it('VERSION_CHECK_HELP_TEXT contains --json flag', () => {
    expect(VERSION_CHECK_HELP_TEXT).toContain('--json');
  });

  it('VERSION_CHECK_HELP_TEXT contains --help flag', () => {
    expect(VERSION_CHECK_HELP_TEXT).toContain('--help');
  });

  it('CONFORMANCE_HELP_TEXT contains command, timeout, and worker environment details', () => {
    expect(CONFORMANCE_HELP_TEXT).toContain('weft conformance');
    expect(CONFORMANCE_HELP_TEXT).toContain('--timeout');
    expect(CONFORMANCE_HELP_TEXT).toContain('WEFT_WORKER_PROTOCOL_VERSION');
  });

  it('TIMELINE_HELP_TEXT contains --step and --diff flags', () => {
    expect(TIMELINE_HELP_TEXT).toContain('--step');
    expect(TIMELINE_HELP_TEXT).toContain('--diff');
    expect(TIMELINE_HELP_TEXT).toContain('--database');
  });

  it('SCHEDULE_HELP_TEXT contains list, create, pause, resume, and cancel', () => {
    expect(SCHEDULE_HELP_TEXT).toContain('schedule list');
    expect(SCHEDULE_HELP_TEXT).toContain('schedule create');
    expect(SCHEDULE_HELP_TEXT).toContain('schedule pause');
    expect(SCHEDULE_HELP_TEXT).toContain('schedule resume');
    expect(SCHEDULE_HELP_TEXT).toContain('schedule cancel');
    expect(SCHEDULE_HELP_TEXT).toContain('--storage');
    expect(SCHEDULE_HELP_TEXT).toContain('sqlite, lmdb');
    expect(SCHEDULE_HELP_TEXT).not.toContain('sqlite, lmdb, memory');
    expect(SCHEDULE_HELP_TEXT).toContain('--workflows');
    expect(SCHEDULE_HELP_TEXT).toContain('--jitter');
  });

  it('HELP_TEXT documents --storage flag', () => {
    expect(HELP_TEXT).toContain('--storage');
  });

  it('HELP_TEXT does not document removed dashboard flags', () => {
    expect(HELP_TEXT).not.toContain('--no-ui');
  });

  it('HELP_TEXT lists all storage backends', () => {
    expect(HELP_TEXT).toContain('sqlite');
    expect(HELP_TEXT).toContain('lmdb');
    expect(HELP_TEXT).toContain('memory');
  });
});

describe('executeDoctor', () => {
  it('returns a formatted report for an in-memory database', async () => {
    const result = await executeDoctor({ database: ':memory:', json: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Database:');
    expect(result.stdout).toContain('Workflows:');
    expect(result.stdout).toContain('Activities:');
    expect(result.stdout).toContain('Recommendations:');
  });

  it('returns JSON when json option is true', async () => {
    const result = await executeDoctor({ database: ':memory:', json: true });
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toHaveProperty('database');
    expect(report).toHaveProperty('workflows');
    expect(report).toHaveProperty('queues');
    expect(report).toHaveProperty('recommendations');
  });
});

describe('executeVersionCheck', () => {
  it('returns an error when workflows path is empty', async () => {
    const result = await executeVersionCheck({
      database: ':memory:',
      workflows: '',
      json: false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--workflows');
  });

  it('returns a JSON report for a valid workflows module', async () => {
    const database = join(tmpdir(), `weft-version-check-${crypto.randomUUID()}.db`);
    const workflows = createTemporaryTypeScriptPath('weft-workflows');
    const storage = await createStorage('sqlite', database);

    try {
      await storage.put(
        KEYS.workflow('wf-version-check'),
        encode({
          id: 'wf-version-check',
          type: 'order',

          status: 'running',
          input: null,
          version: '1.0.0',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );

      await Bun.write(
        workflows,
        [
          'export default {',
          '  order: {',
          '    name: "order",',
          '    version: "1.0.0",',
          '    handler: async function* () {',
          '      return null;',
          '    },',
          '  },',
          '};',
        ].join('\n'),
      );

      const workflowModule = await import(workflows);
      const handler = getOrderHandler(workflowModule.default);
      const generatorResult: unknown = Reflect.apply(handler, undefined, []);
      if (!isAsyncGenerator(generatorResult)) {
        throw new TypeError('order workflow handler did not return an async iterator');
      }
      const generator = generatorResult;
      await generator.next();

      const result = await executeVersionCheck({
        database,
        workflows,
        json: true,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBeUndefined();
      expect(JSON.parse(result.stdout)).toMatchObject({
        overallVerdict: 'safe',
        workflowTypes: [
          {
            type: 'order',
            storedVersion: '1.0.0',
            registeredVersion: '1.0.0',
          },
        ],
      });
    } finally {
      storage[Symbol.dispose]();
      removeTemporaryTypeScriptPath(workflows);
      rmSync(database, { force: true });
    }
  });
});
