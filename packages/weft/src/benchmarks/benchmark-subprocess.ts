type BenchmarkValidator<TMeasurement> = (value: unknown) => value is TMeasurement;

const BENCHMARK_ENVIRONMENT_KEYS = [
  'HOME',
  'NODE_V8_COVERAGE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WEFT_COVERAGE_MODE',
] as const;

function createBenchmarkEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const key of BENCHMARK_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string') {
      environment[key] = value;
    }
  }

  return environment;
}

function decodeBuffer(buffer: Uint8Array): string {
  return new TextDecoder().decode(buffer);
}

export function runBenchmarkSubprocess<TMeasurement>({
  benchmarkName,
  runnerArguments = [],
  runnerPath,
  validateMeasurement,
}: {
  benchmarkName: string;
  runnerArguments?: string[];
  runnerPath: string;
  validateMeasurement: BenchmarkValidator<TMeasurement>;
}): TMeasurement {
  const result = Bun.spawnSync([process.execPath, 'run', runnerPath, ...runnerArguments], {
    cwd: process.cwd(),
    env: createBenchmarkEnvironment(),
    stderr: 'pipe',
    stdout: 'pipe',
  });

  if (result.exitCode !== 0) {
    const errorOutput = decodeBuffer(result.stderr).trim();
    throw new Error(`${benchmarkName} subprocess failed: ${errorOutput}`);
  }

  const outputLines = decodeBuffer(result.stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastOutputLine = outputLines.at(-1);
  if (lastOutputLine === undefined) {
    throw new Error(`${benchmarkName} subprocess produced no measurement output`);
  }

  const parsed = JSON.parse(lastOutputLine) as unknown;
  if (!validateMeasurement(parsed)) {
    throw new Error(`${benchmarkName} subprocess returned an invalid measurement payload`);
  }

  return parsed;
}
