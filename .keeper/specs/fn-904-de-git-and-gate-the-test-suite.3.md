## Description

**Size:** M
**Files:** src/commit-work/git-exec.ts, src/commit-work/attribution.ts, src/doc-commit.ts, plugins/keeper/plugin/hooks/docs-pusher.ts, plugins/keeper/plugin/hooks/sidecar-writer.ts, test/commit-work.test.ts, test/doc-commit.test.ts, test/docs-pusher.test.ts, test/sidecar-writer.test.ts

### Approach

Test the commit/push DECISIONS with a faked git runner so no real commits
or pushes happen. Inject a function-level seam (a `runGit`-shaped param,
defaulting to the real inline spawn) at each boundary: `gitExec` for the
commit-work family, `runGit` (`doc-commit.ts:66`) for the dep-free
committer, and the inline `Bun.spawnSync` in the two `~/docs` hooks. Tests
assert WHAT keeper would do — the pathspec, the `docs: …` subject, the
push skip/log decision, and especially the hook fail-open / exit-0 contract
when the faked runner returns a non-zero — not git's effect. Capture the
`classifyPushError` stderr substrings (non-fast-forward / auth) from real
git ONCE as goldens so the classifier branch stays covered. The hooks MUST
stay dep-free (node:fs/os/path + Bun.spawnSync + dep-free src/ helpers; NO
bun:sqlite/src/db.ts, NO plan import) — the seam must be a plain param or a
test-only module export, not a DI framework, and must not grow the
cold-start import set. Keep `src/doc-commit.ts` and its port-twin
`plugins/plan/src/commit.ts` in sync.

### Investigation targets

**Required** (read before coding):
- src/commit-work/git-exec.ts — `gitExec(args,{cwd,stdin,env})`, the single commit-work seam
- src/doc-commit.ts:66 (`runGit`), :260 (`commitDocsPaths`) — the dep-free committer + its entry
- plugins/keeper/plugin/hooks/docs-pusher.ts — `pushDocs` inline spawn + `classifyPushError`; sidecar-writer.ts:336 calls `commitDocsPaths`
- CLAUDE.md "Hook rules" — the dep-free + exit-0 contracts these tests must preserve

**Optional** (reference as needed):
- test/docs-pusher.test.ts — the bare-`origin` push-decision tests to convert (non-ff, held-lock cases)

### Risks

- Over-seaming a hook could drag an import and blow the cold-start budget —
  keep the default the existing inline spawn; the seam is test-only.
- Faking push loses real non-ff detection — mitigate with captured stderr
  goldens feeding `classifyPushError`.

### Test notes

The thing under test for the hooks is the exit-0 / fail-open behavior on a
git failure — assert the hook does not throw and logs, with the faked
runner returning non-zero.

## Acceptance

- [ ] commit-work / doc-commit / docs-pusher / sidecar-writer tests run with zero real git via an injected runner
- [ ] Decisions asserted (pathspec, subject, push skip/log, exit-0 fail-open) — not git side effects
- [ ] Hooks remain dep-free; cold-start import set unchanged; doc-commit.ts ↔ plan commit.ts kept in sync
- [ ] `classifyPushError` branches covered by captured-from-real-git stderr goldens

## Done summary

## Evidence
