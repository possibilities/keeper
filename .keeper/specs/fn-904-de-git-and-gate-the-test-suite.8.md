## Description

**Size:** S
**Files:** scripts/lint-no-real-git.ts (new), scripts/test-real-git-allowlist.txt (new), package.json, CLAUDE.md, README.md, test/helpers/git-repo.ts

### Approach

Lock in the win with a regression guard + doc updates, landing last so the
allowlist reflects the de-gitted reality. Add `scripts/lint-no-real-git.ts`
(mirror `scripts/assert-comment-only.ts`'s structure) that scans the
designated hot test files for real-git signatures — `Bun.spawnSync(["git"`,
`initRepo`/`gitInit` imports, `mkdtemp`+`git init` — and fails on a match
unless the file is in `scripts/test-real-git-allowlist.txt` (the
slow/integration tier that legitimately keeps real git, mirroring
`scripts/frozen-allowlist.txt`). Wire it as a `test:hygiene` package.json
script. Docs: add a bold `**No real git in the default tiers.**` rule to
CLAUDE.md "Test isolation" (before the closing "Poll, don't sleep." rule),
describe the gate so agents don't bypass it with raw `bun test`, and name
the lint; update the README test-helper paragraph (helper count + the gate);
narrow `test/helpers/git-repo.ts`'s "real git is NEVER mocked" header to
"real git only in the slow/integration tier."

### Investigation targets

**Required** (read before coding):
- scripts/assert-comment-only.ts — TS lint structure (file args, scoreboard, exit) to mirror
- scripts/lint-retired-name.sh + scripts/frozen-allowlist.txt — the allowlist-file convention
- CLAUDE.md "## Test isolation" — where the new rule lands (before "Poll, don't sleep.")
- test/helpers/git-repo.ts:2-6 — the header that contradicts the new convention

**Optional** (reference as needed):
- README.md ~560-569 — the test-helper paragraph + CLAUDE.md cross-ref

### Risks

- OVERLAP with fn-889 on CLAUDE.md — the epic dep sequences this after
  fn-889; rebase the doc edit.
- An over-broad lint pattern could false-positive on comments/strings —
  scope to the hot-file list + allowlist.

### Test notes

Run the lint against the post-de-git tree (it must pass) and against a
deliberately reverted file (it must fail) to prove the guard bites.

## Acceptance

- [ ] `scripts/lint-no-real-git.ts` + allowlist exist and are wired as `bun run test:hygiene`; the lint passes on the de-gitted tree and fails on a reintroduced real-git call
- [ ] CLAUDE.md "Test isolation" carries the no-real-git rule + gate description + lint name
- [ ] README test-helper paragraph and `test/helpers/git-repo.ts` header updated to match the new reality

## Done summary

## Evidence
