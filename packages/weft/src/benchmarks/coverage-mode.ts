export function isCoverageInstrumentationEnabled(): boolean {
  if (Bun.env['WEFT_COVERAGE_MODE'] === '1') {
    return true;
  }

  if (process.execArgv.includes('--coverage')) {
    return true;
  }

  const coverageDirectory = Bun.env['NODE_V8_COVERAGE'];
  return typeof coverageDirectory === 'string' && coverageDirectory.length > 0;
}
