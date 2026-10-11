/**
 * Environment for fixture `execSync`/`execFileSync` git calls in tests:
 * process.env minus every `GIT_*` variable, so inherited index/object-dir/
 * worktree redirects cannot corrupt throwaway repositories. Mirrors the
 * scrub production `gitEnv` performs, without importing it — tests must
 * not reach into implementation helpers.
 */
export function gitFixtureEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
}
