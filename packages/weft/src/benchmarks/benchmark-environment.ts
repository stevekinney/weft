export function isConstrainedCodexRunner(): boolean {
  return process.env['CODEX_CI'] === '1';
}

export function isGitHubActionsRunner(): boolean {
  return process.env['GITHUB_ACTIONS'] === 'true';
}
