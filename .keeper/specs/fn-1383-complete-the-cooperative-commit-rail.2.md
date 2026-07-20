## Description

**Size:** S
**Files:** cli/session.ts, src/commit-work/surface.ts

### Approach

Two truth gaps in the cooperative-release rail. (1) `keeper session release` derives
the worktree from the INVOKING cwd's git toplevel (cli/session.ts:349) with no
claim-existence check — a cross-repo release canonicalizes the path inside the wrong
repo and reports ok:true while the real claim stays live (live cost: mike's greenlit
dotfiles commit blocked ~50 min). Validate that a named path actually carries a claim
under the derived worktree, accept an explicit `--worktree` and refuse a mismatch,
and keep the success envelope naming the bound worktree. (2) commit-work's
`multi_ambiguous` refusal suppresses the `request_release` pointer — it is built only
in the `ownership_conflict` arms (src/commit-work/surface.ts:2483-2486,2519-2522,
never at :2570) — leaving blocked peers with no named claimant exactly when the rail
would work. Attach the pointer (with each claim's worktree) to `multi_ambiguous`.

### Investigation targets

*Verify before relying — the repo moves.*

**Required** (read before coding):
- cli/session.ts:349,406 — worktree derivation and the success envelope
- src/commit-work/surface.ts:2483-2486,2519-2522,2570 — where request_release is built and where it is missing
- ~/docs/keeper-phase2-backlog.md #67 and #62 (residual paragraph) — the live specimens

### Risks

- Release must stay claimant-self-proof-gated — this task adds validation, never widens who may release
- The pointer on multi_ambiguous must name claimants truthfully (the #62 primary fix landed lifecycle-tail terminal proof — reuse it, don't re-derive)

### Test notes

Release: wrong-repo invocation refuses with the mismatch named; right-repo releases; envelope
carries worktree. Surface: multi_ambiguous envelope carries request_release with worktree. Named gates.

## Acceptance

- [ ] A release naming a path with no claim in the bound worktree refuses loudly (no ok-reporting no-op); `--worktree` mismatch refuses
- [ ] `multi_ambiguous` refusals carry request_release with each claim's worktree
- [ ] Suites green via named gates

## Done summary

## Evidence
