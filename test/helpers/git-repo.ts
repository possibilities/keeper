/**
 * Shared real-git fixture helper. The byte-identical init sequence
 * (`git init -q -b main` + `config user.email/name` + `config commit.gpgsign
 * false`) is repeated across every fixture; centralize it here.
 *
 * Real git runs ONLY in the slow/integration tier (fn-904) — the de-gitted
 * default tiers test keeper's git-boundary DECISIONS with synthetic
 * porcelain/snapshot fixtures and a faked runner instead. The remaining real-git
 * fixtures (the `Task:`-trailer parsing and the fn-629 HEAD gate) depend on real
 * plumbing and live in files enumerated in `scripts/test-real-git-allowlist.txt`;
 * `bun run test:hygiene` fails if a non-allowlisted test reintroduces real git.
 * The `commit.gpgsign false` config is load-bearing — a host with global
 * `commit.gpgsign true` would otherwise wedge the non-interactive `git commit`
 * in fixtures.
 *
 * PATH STANCE: `initRepo` runs against `dir` verbatim and does NOT realpath it.
 * macOS resolves `tmpdir()` (`/var/...`) to `/private/var/...`; tests that
 * assert path-equality against the repo's resolved path (e.g. vs a reducer's
 * `project_dir`) MUST wrap `dir` in `realpathSync(...)` THEMSELVES before
 * passing it in — same as the inline fixtures did. Callers that don't compare
 * paths can pass the raw mkdtemp path.
 */

/** Run a git subcommand in `dir` synchronously; throw on a non-zero exit. */
function git(dir: string, ...args: string[]): string {
  const res = Bun.spawnSync(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${res.stderr.toString().trim()}`,
    );
  }
  return res.stdout.toString();
}

/**
 * Initialize `dir` as a git repo on `main` with a test identity and gpgsign
 * disabled. Does NOT create a commit — the caller adds one if it needs HEAD to
 * resolve. `dir` must already exist.
 */
export function initRepo(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
}
