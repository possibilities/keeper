## Overview

Commit b39fab28 was made from the shared checkout while its index/worktree trailed landed
history: alongside its one intended file it swept ~96 paths (~12.9k lines) back to stale
content, and green suites could not catch it because the tests reverted in the same sweep.
The daemon's `shared-checkout-dirty` / `shared-checkout-desync` stickies had been visible but
advisory for 3+ hours, and the damage also propagated through an auto-merge that chose the
poisoned side. A 35-incident analysis of historical merge conflicts in keeper.db found
base-drift the plurality cause at 66% (23/35) vs file-overlap at 29%. This epic makes the
incident class structurally impossible: commit-work gains an index-purity gate, a
pathspec-limited commit, repo-state refusals, and a mass-reversion tripwire; the two
shared-checkout stickies are promoted from advisory to paging operator jams; and a dead
repair session's SHARED_BASE_BROKEN sticky becomes operator-recoverable over the retry wire.

## Quick commands

- `bun test test/commit-work.test.ts test/await-conditions.test.ts test/dispatch-command.test.ts test/daemon.test.ts`
- `keeper commit-work --preview-files` — smoke the discovery path
- `keeper query dispatch_failures` — inspect live jam rows (dirty/desync ids are `shared-checkout-{dirty,desync}:<hash>`)
- `bun run test:full && bun run typecheck && bun run lint` — the full gate

## Acceptance

- [ ] A commit made through `keeper commit-work` cannot include staged content outside the
  session-attributed set: the stale-carryover gate fails loudly by default and the commit
  itself is pathspec-limited, so a poisoned index cannot leak even when the gate is overridden.
- [ ] `shared-checkout-dirty` / `shared-checkout-desync` rows count as operator jams, page the
  human exactly once per row instance, and gate commit-work (overridable) while live for the repo.
- [ ] A repo mid-merge/cherry-pick/revert/rebase/bisect, or a staged set mass-matching ancestor
  blobs, aborts commit-work with a structured envelope.
- [ ] `keeper autopilot retry repair::<token>` re-arms a stranded SHARED_BASE_BROKEN repair row.
- [ ] docs/problem-codes.md, the new ADR, CLAUDE.md, and the keeper skill enumerations tell one
  consistent recovery story; all suites green.

## Early proof point

Task that proves the approach: ordinal 1 (purity gate + pathspec commit). If git's `--only`
semantics break a legitimate worker flow: keep the loud gate, flag-gate the pathspec commit
behind a default-on flag while the interaction is investigated.

## References

- Incident: `b39fab28` (mass reversion from a desynced shared checkout); recovery `41dd09d5` +
  `25fa65c3`; sibling `8f0f356a` re-did the intended feature while the reversions persisted.
- ADRs: 0008 (plumbing base-default merge), 0011 (operator-jam class), 0016 (stale-aware
  shared-checkout catch-up — the desync origin), 0017 (trunk-repair escalation; its
  repair-retry exclusion is partially superseded by this epic's ADR), 0039 (merge-conflict
  escalation re-arm), 0048 (in-text partial-supersession idiom).
- Overlap, deliberately NOT a dep edge: `docs/problem-codes.md` is also appended by paused
  fn-1252.2/.3 and fn-1255.5 (distinct rows; they rebase when resumed). fn-1252.6 writes
  src/reducer.ts + src/db.ts with a schema step: this epic's ordinal 2 adds only a fold arm
  (no schema change) and ordinal 4 stays read-only there, so no ladder collision.
- Considered, not built: a HEAD-behind-landed-ref ancestry guard — the trailing-index shape is
  caught by the purity gate, the trailing-HEAD shape by the existing push_non_fast_forward
  refusal.

## Docs gaps

- **plugins/prompt corpus `engineering/commit-via-keeper-default` + `engineering/commit-hygiene-flags`**:
  fold the new envelopes, flags, and escape-hatch story into the snippets via the
  arthack-upstream vendor flow (`scripts/vendor-corpus.ts --sync`, bake re-render, oracle
  re-capture) — deliberately outside task scope: the authoring home is the arthack repo and a
  lane worker cannot write that checkout.
- **plugins/plan/skills/repair/SKILL.md**: verify the page-once wording still holds once repair
  rows are retry-re-armable.

## Best practices

- **Pathspec injection defense:** `GIT_LITERAL_PATHSPECS=1` plus `--` before every pathspec —
  poisoned-index paths are attacker-influenced; this defeats leading-dash options and pathspec magic.
- **Set derivation:** always `-z` (NUL-safe against newline-in-path smuggling) and
  `--no-renames` (renames split into both halves; `--name-only` with rename detection reports
  only the new path).
- **Blob probing:** one buffered `git cat-file --batch-check` process, never per-path forks;
  a missing-object line echoes the INPUT plus ` missing` — parse the trailing token; exclude
  mode-160000 gitlinks (`%(objectmode)` is not a batch-check atom — get modes from `ls-files -s`).
- **In-progress probes:** `git rev-parse --git-path <name>` (linked-worktree portable — `.git`
  is a file in lanes), mirroring git's own `wt_status_get_state` set.
- **Reversion thresholds:** count AND fraction, with a generated/lockfile exclude-globset —
  intentional reverts, lockfile oscillation, and formatting round-trips are the false-positive
  profile.
