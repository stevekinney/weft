import { $, Glob } from 'bun';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '..');
const isolatedDoctestsDirectory = resolve(repositoryRoot, 'tmp/doctests-isolated');
const isolatedConfigurationsDirectory = resolve(isolatedDoctestsDirectory, '__configs__');

await $`bun run scripts/extract-doctests.ts`;
await $`bunx tsc --noEmit -p tmp/doctests`;

const isolatedFiles: string[] = [];
for await (const file of new Glob('**/*.ts').scan({
  cwd: isolatedDoctestsDirectory,
  onlyFiles: true,
})) {
  if (!file.startsWith('__configs__/')) isolatedFiles.push(file.replaceAll('\\', '/'));
}

isolatedFiles.sort();

if (isolatedFiles.length > 0) {
  mkdirSync(isolatedConfigurationsDirectory, { recursive: true });

  for (const [index, file] of isolatedFiles.entries()) {
    const configurationPath = resolve(
      isolatedConfigurationsDirectory,
      `${index.toString().padStart(4, '0')}.json`,
    );
    writeFileSync(
      configurationPath,
      `${JSON.stringify({ extends: '../tsconfig.json', files: [`../${file}`] }, null, 2)}\n`,
      'utf8',
    );
    await $`bunx tsc --noEmit -p ${configurationPath}`;
  }
}

console.log(
  `Compiled ${isolatedFiles.length} isolated JSDoc doctest ${
    isolatedFiles.length === 1 ? 'file' : 'files'
  }.`,
);
