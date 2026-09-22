import { resolveBenchmarkEnvironment } from './environment-configuration.ts';

export function isConstrainedCodexRunner(): boolean {
  return resolveBenchmarkEnvironment().codexCi;
}

export function isGitHubActionsRunner(): boolean {
  return resolveBenchmarkEnvironment().githubActions;
}
