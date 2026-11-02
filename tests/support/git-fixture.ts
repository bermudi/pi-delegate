import { execSync } from "node:child_process";

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

/**
 * A minimal repository with an identity and one empty commit.
 *
 * An initial commit is required: isolated baselines are built on HEAD, and
 * scratch workspaces copy the committed tree. Always scrubbed — a leaf that
 * forgets `gitFixtureEnv()` fails with "fatal: this operation must be run in
 * a work tree" the moment a contributor or CI image exports `GIT_DIR`.
 */
export function gitInit(dir: string): void {
  execSync(
    "git init -q && git config user.email t@t && git config user.name t && git commit -qm init --allow-empty",
    { cwd: dir, env: gitFixtureEnv() },
  );
}

/**
 * A repository with an identity but no commit yet.
 *
 * For cases that build their own history, or that assert on the unborn-HEAD
 * path (`rev-parse HEAD` failing, the "at least one commit" guidance).
 */
export function gitInitEmpty(dir: string): void {
  execSync("git init -q && git config user.email t@t && git config user.name t", {
    cwd: dir,
    env: gitFixtureEnv(),
  });
}
