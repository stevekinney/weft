import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { DashboardAssets, DashboardRouteTarget } from '../server/index.ts';

const CONSOLE_PACKAGE_NAME = '@lostgradient/weft-console';

interface ConsoleModule {
  weftConsole?: (options?: unknown) => unknown;
}

export interface ConsoleMount {
  dashboard: DashboardRouteTarget;
  dashboardAssets: DashboardAssets;
}

export interface ConsoleModuleLoaderOptions {
  cwd?: string;
  resolveModule?: (specifier: string, cwd: string) => string;
  importModule?: (url: string) => Promise<unknown>;
}

function defaultImportModule(url: string): Promise<unknown> {
  return import(url);
}

function isDashboardRouteTarget(value: unknown): value is DashboardRouteTarget {
  return typeof value === 'function' || typeof value === 'string' || value instanceof Response;
}

function isConsoleModule(value: unknown): value is ConsoleModule {
  return typeof value === 'object' && value !== null;
}

function consoleError(message: string): Error {
  return new Error(`--console ${message}`);
}

function resolveConsoleEntry(
  cwd: string,
  resolveModule: (specifier: string, cwd: string) => string,
): string {
  try {
    return resolveModule(CONSOLE_PACKAGE_NAME, cwd);
  } catch {
    throw consoleError(
      `requires ${CONSOLE_PACKAGE_NAME}. Install it in the CLI project: bun add ${CONSOLE_PACKAGE_NAME}`,
    );
  }
}

async function importConsoleModule(
  resolvedEntry: string,
  importModule: (url: string) => Promise<unknown>,
): Promise<ConsoleModule> {
  try {
    const loaded = await importModule(pathToFileURL(resolvedEntry).href);
    if (!isConsoleModule(loaded)) throw new Error('module is not an object');
    return loaded;
  } catch {
    throw consoleError(
      `could not load ${CONSOLE_PACKAGE_NAME}; reinstall or update it, then retry, or remove --console`,
    );
  }
}

function loadDashboard(module: ConsoleModule): DashboardRouteTarget {
  if (typeof module.weftConsole !== 'function') {
    throw consoleError(
      `${CONSOLE_PACKAGE_NAME} must export a weftConsole() function; update the package or remove --console`,
    );
  }

  try {
    const dashboard = module.weftConsole();
    if (!isDashboardRouteTarget(dashboard)) throw new Error('invalid dashboard route target');
    return dashboard;
  } catch {
    throw consoleError(
      `${CONSOLE_PACKAGE_NAME} weftConsole() failed; reinstall or update it, then retry, or remove --console`,
    );
  }
}

function resolveConsoleAssets(resolvedEntry: string): DashboardAssets {
  const directory = join(dirname(fileURLToPath(pathToFileURL(resolvedEntry))), 'assets');
  try {
    if (!statSync(directory).isDirectory()) throw new Error('not a directory');
  } catch {
    throw consoleError(
      `${CONSOLE_PACKAGE_NAME} is missing its built assets; reinstall or update it, then retry, or remove --console`,
    );
  }
  return { prefix: '/assets', directory };
}

/** Resolve and load the optional console from the CLI user's environment. */
export async function loadConsoleMount(
  options: ConsoleModuleLoaderOptions = {},
): Promise<ConsoleMount> {
  const cwd = options.cwd ?? process.cwd();
  const resolveModule = options.resolveModule ?? Bun.resolveSync;
  const importModule = options.importModule ?? defaultImportModule;
  const resolvedEntry = resolveConsoleEntry(cwd, resolveModule);
  const module = await importConsoleModule(resolvedEntry, importModule);

  return {
    dashboard: loadDashboard(module),
    dashboardAssets: resolveConsoleAssets(resolvedEntry),
  };
}
