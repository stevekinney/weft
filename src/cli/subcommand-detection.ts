export const CLI_FLAG_VALUE_OPTIONS = new Set([
  '-p',
  '-d',
  '-s',
  '-w',
  '-o',
  '--port',
  '--database',
  '--storage',
  '--workflows',
  '--timeout',
  '--server',
  '--from',
  '--token',
  '--out',
  '--input',
  '--input-file',
  '--describe',
  '--profile',
]);

export function findCliSubcommandName(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg.startsWith('-')) {
      if (CLI_FLAG_VALUE_OPTIONS.has(arg) && !arg.includes('=')) index++;
      continue;
    }
    return arg;
  }

  return undefined;
}
