/**
 * Production CSS integrity gate for Cinder's automatic component styles.
 * Component JavaScript entrypoints own these selectors; the console must
 * not restore a parallel per-component style ledger to make this pass.
 */
import { join } from 'node:path';

const ASSETS_DIRECTORY = join(import.meta.dir, '..', 'dist', 'assets');

const REQUIRED_COMPONENT_RULES = [
  '.cinder-sidebar{',
  '.cinder-feed{',
  '.cinder-run-step-timeline{',
  '.cinder-schedule-builder{',
  '.cinder-meter{',
  '.cinder-segmented-control{',
  '.cinder-payload-inspector{',
  '.cinder-tree{',
  '.cinder-badge{',
  '.cinder-popover{',
] as const;

const stylesheetPaths = await Array.fromAsync(
  new Bun.Glob('*.css').scan({ cwd: ASSETS_DIRECTORY, absolute: true }),
);

if (stylesheetPaths.length === 0) {
  throw new Error(
    'check-cinder-styles: no production stylesheets found; run `bun run build` first',
  );
}

const stylesheetContents = await Promise.all(
  stylesheetPaths.map((stylesheetPath) => Bun.file(stylesheetPath).text()),
);
const productionCss = stylesheetContents.join('\n');

const missingComponentRules = REQUIRED_COMPONENT_RULES.filter(
  (requiredComponentRule) => !productionCss.includes(requiredComponentRule),
);

if (missingComponentRules.length > 0) {
  throw new Error(
    `check-cinder-styles: missing Cinder component rules from production CSS: ${missingComponentRules.join(', ')}`,
  );
}

console.log(
  `Cinder production CSS contains all ${REQUIRED_COMPONENT_RULES.length} representative component rules.`,
);
