import { VERSION } from '../version.ts';

import type { CommandOutput } from './types.ts';

/**
 * Print the installed Weft version. Backs `weft --version`, `weft -v`, and the
 * bare `weft version` subcommand. The output is the bare {@link VERSION} string
 * so scripts can capture it without parsing decoration.
 */
export function executeVersion(): CommandOutput {
  return { stdout: VERSION, exitCode: 0 };
}
