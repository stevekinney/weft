export type WorkerSpawnMeasurement = {
  warmupSamples: number;
  measuredSamples: number;
  samples: number[];
  medianMilliseconds: number;
};

const workerUrl = new URL('../workers/test-worker.ts', import.meta.url);
const DEFAULT_WARMUP_SAMPLES = 5;
const DEFAULT_MEASURED_SAMPLES = 20;

function median(values: number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middleIndex = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middleIndex - 1]! + sorted[middleIndex]!) / 2;
  }

  return sorted[middleIndex]!;
}

async function measureWorkerSpawnRoundTrip(): Promise<number> {
  const start = performance.now();
  const worker = new Worker(workerUrl);

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Worker spawn benchmark timed out')),
        1_000,
      );

      const handleMessage = (): void => {
        clearTimeout(timeout);
        resolve();
      };

      const handleError = (): void => {
        clearTimeout(timeout);
        reject(new Error('Worker spawn benchmark worker error'));
      };

      worker.addEventListener('message', handleMessage, { once: true });
      worker.addEventListener('error', handleError, { once: true });
      worker.postMessage('ready');
    });

    return performance.now() - start;
  } finally {
    worker.terminate();
  }
}

export async function measureWorkerSpawn(
  warmupSamples = DEFAULT_WARMUP_SAMPLES,
  measuredSamples = DEFAULT_MEASURED_SAMPLES,
): Promise<WorkerSpawnMeasurement> {
  for (let sample = 0; sample < warmupSamples; sample += 1) {
    await measureWorkerSpawnRoundTrip();
  }

  const samples: number[] = [];
  for (let sample = 0; sample < measuredSamples; sample += 1) {
    samples.push(await measureWorkerSpawnRoundTrip());
  }

  return {
    warmupSamples,
    measuredSamples,
    samples,
    medianMilliseconds: median(samples),
  };
}

if (import.meta.main) {
  const warmupSamplesArgument = Bun.argv[2];
  const measuredSamplesArgument = Bun.argv[3];
  const warmupSamples =
    warmupSamplesArgument !== undefined ? Number(warmupSamplesArgument) : DEFAULT_WARMUP_SAMPLES;
  const measuredSamples =
    measuredSamplesArgument !== undefined
      ? Number(measuredSamplesArgument)
      : DEFAULT_MEASURED_SAMPLES;

  if (
    !Number.isInteger(warmupSamples) ||
    warmupSamples < 0 ||
    !Number.isInteger(measuredSamples) ||
    measuredSamples <= 0
  ) {
    console.error(
      'Expected a non-negative warmup sample count and a positive measured sample count.',
    );
    process.exit(1);
  }

  const measurement = await measureWorkerSpawn(warmupSamples, measuredSamples);
  console.log(JSON.stringify(measurement));
}
