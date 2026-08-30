import { runPullRequestTitleCli } from './pull-request-title.ts';

export * from './pull-request-title.ts';

if (import.meta.main) {
  const result = runPullRequestTitleCli(process.argv.slice(2));
  for (const line of result.stdout) {
    console.log(line);
  }
  for (const line of result.stderr) {
    console.error(line);
  }
  process.exit(result.exitCode);
}
