## Description

**Size:** M
**Files:** plugins/plan/test/harness.ts, plugins/plan/src/commit.ts, plugins/plan/src/invocation.ts

### Approach

Eliminate real git from the plan store's persistence by introducing a fake
VCS facade the tests install — NOT an env-gated no-op committer (that hides
test behavior in production and loses the "exactly one commit" coverage).
The facade covers both the commit AND the dirty-path discovery, because
`buildPlanInvocation` shells `git status` first (`invocation.ts:187`)
before `autoCommitFromInvocation` (`commit.ts:243`) ever runs. Model:
`initRepo(root)` creates a `.git/` dir only (enough for `findGitRoot` /
integrity detection); maintain per-repo snapshots of the `.keeper/` tree;
`dirtyDataDirPaths(repo)` diffs the filesystem against the last snapshot;
`commit(msg,files)` appends `{sha,message,files}`, updates the snapshot, and
returns a deterministic fake sha. Re-point the harness git-assertion helpers
(`gitLogCount`/`gitHeadSha`/`gitHeadMessage`/`gitFilesInHead`) and
`gitBaseline()` to read the fake log — most existing "before + 1 commit"
assertions then stay unchanged. Inject the facade into `commit.ts` /
`invocation.ts` via a function-level seam defaulting to the real spawn, so
production is untouched.

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/commit.ts:70 (`runGit`), :243 (`autoCommitFromInvocation`) — the commit seam (port-twin of src/doc-commit.ts)
- plugins/plan/src/invocation.ts:180-187 — the `git status` dirty-path discovery that must also be faked
- plugins/plan/test/harness.ts:449 (`withGitRepo`), :469 (`withProject`), :500-523 (git assertion helpers), :555 (`gitBaseline`)
- plugins/plan/src/project.ts:40, integrity.ts:78 — what looks for `.git/` (so the fake repo needs a `.git` entry)

**Optional** (reference as needed):
- src/doc-commit.ts — keep the port-twin in sync if the seam shape changes

### Risks

- `commit()` must DIFF snapshots, not blindly record — or no-op/idempotency
  tests (zero-commit assertions) become meaningless.
- The seam must default to real git in production; only tests install the
  fake.

### Test notes

Preserve the "exactly one commit, message X, files Y" assertions by reading
the fake commit log. A faked non-zero commit still exercises `CommitFailed`.

## Acceptance

- [ ] A fake VCS facade records commits + computes dirty `.keeper/` paths; tests install it, production defaults to real git
- [ ] `buildPlanInvocation` dirty-path discovery and `autoCommitFromInvocation` both run against the fake — zero real git in default plan tests
- [ ] Harness assertion helpers + `gitBaseline` read the fake log; most call sites unchanged
- [ ] no-op / idempotency / "exactly one commit" coverage preserved via snapshot diffing

## Done summary

## Evidence
