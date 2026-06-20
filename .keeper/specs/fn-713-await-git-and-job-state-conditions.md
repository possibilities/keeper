## Overview

Expand keeper's `await` skill + CLI from planctl-board-only waits
(`complete`/`unblocked` against an `fn-N` id) to also cover **git state**
(`git-clean`) and **job state** (`agents-idle`), and let conditions be
**AND-combined** in one persistent process. The end state: a human (or
agent) can say "wait until the project is clean and the other agents are
done, then commit" and a single `keeper await git-clean and agents-idle`
invocation blocks until all conditions hold, emitting the existing
Monitor-shaped terminal line. The skill is renamed `keeper-await` →
`await` so it surfaces as `/keeper:await` and bare `/await` and
auto-triggers on git/job phrasings, not just planctl ids.

## Quick commands

- `bun cli/keeper.ts await git-clean` — block until cwd's repo is clean
- `bun cli/keeper.ts await agents-idle` — block until no other agent works in cwd's repo
- `bun cli/keeper.ts await git-clean and agents-idle` — both, ANDed
- `bun cli/keeper.ts await complete fn-647-keeper-await-and-plugin-promotion.1` — legacy form, byte-identical output
- `bun test test/await.test.ts test/await-conditions.test.ts` — full await suite

## Acceptance

- [ ] `keeper await git-clean` blocks until the cwd's git root has `dirty_count==0 AND orphaned_count==0`, treating "no `git_status` row for my root" as already-clean (MET).
- [ ] `keeper await agents-idle` blocks until no OTHER job (`job_id != CLAUDE_CODE_SESSION_ID`) with `state="working"` has a cwd inside the cwd's git root; zero such jobs is MET.
- [ ] `keeper await <c1> and <c2> [and <c3>]` opens only the subscriptions its conditions need and emits the single terminal `met` only when ALL conditions hold simultaneously (glitch-free, level-triggered).
- [ ] A single `complete`/`unblocked` invocation emits byte-identical `armed`/`met`/`failed` lines and exit codes to today.
- [ ] Any planctl sub-condition in an AND going `not-found`/`deleted`/`stuck`(under `--fail-on-stuck`) short-circuits the whole process with that reason; `--timeout`/SIGTERM apply to the aggregate.
- [ ] `src/await-conditions.ts` stays pure (no I/O, no `Date.now()`); all socket subscription, cwd→git-root resolution, and `CLAUDE_CODE_SESSION_ID` reads live in `cli/await.ts`.
- [ ] The skill is renamed to `skills/await/SKILL.md` with `name: await`; SKILL.md, the CLI `HELP` text, and README reflect the new conditions + grammar.
- [ ] No DB schema bump, no reducer change, no `keeper/api.py` change — verified.

## Early proof point

Task that proves the approach: `.1` (the pure predicates + multi-collection
runner). If the glitch-free AND gate or the first-paint composition can't be
made deterministic in the test harness, fall back to evaluating each
condition off a single `subscribeReadiness` snapshot (it already folds git +
jobs) before reaching for separate `subscribeCollection` streams.

## References

- `cli/await.ts` — the runner + parser + `HELP` being extended (DI-runner / thin-`main` split preserved).
- `src/await-conditions.ts` — pure predicate module; widen `AwaitTarget`/`AwaitState` to a condition union.
- `src/readiness-client.ts:1123` `subscribeCollection`, `:1240` `subscribeReadiness`, `:435` `projectGitStatusByProjectDir` (orphan-math reference).
- `src/collections.ts:374` `GIT_DESCRIPTOR` (dirty_count/orphaned_count), `:87` `JOBS_DESCRIPTOR` (cwd filter is exact-match on the wire; `defaultFilter` hides ended/killed).
- `src/reducer.ts:1854` cwd containment SQL; `:18`/`:7062` job state machine — confirms `state="working"` is held for the whole turn+subagent window, so `agents-idle` needs NO between-turn debounce.
- `src/git-worker.ts:635` `resolveGitToplevel` (module-private — do NOT import; do a local one-shot `git rev-parse --show-toplevel` in the CLI).
- Decision log: orphan metric = strict `orphaned_count` (not `unattributed_to_live_count`); subscribe only the streams used; no-row→MET; aggregate short-circuits on any planctl terminal failure.

## Snippet context

No snippets/bundles attached: the repo-scout's `promptctl find-snippets`
sweep for await/subscribe/atomic-write topics returned no hits — these
conventions are carried in-code (the files in References), not in the
snippet substrate.
