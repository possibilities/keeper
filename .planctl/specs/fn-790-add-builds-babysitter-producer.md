## Overview

A new keeper babysitter (`builds`) that watches buildbot CI for failing
builds/steps across all registered builders and silently collects one
self-contained followup per failure onset under
`~/.local/state/babysitters/builds/followups/`. No findings notifications —
the human works the corpus via `/babysit-triage builds` (home already
scaffolded at `~/docs/babysitters/builds/`). Conforms to the fn-755
FINDINGS-LEDGER contract; modeled on the `performance` sitter.

## Quick commands

- `bun ~/code/keeper/babysitters/builds/watch.ts --json | jq '.findings'` — live scan against the real buildbot DB
- `ls ~/.local/state/babysitters/builds/followups/` — the collected corpus
- `bun test test/builds-watch.test.ts` — the sitter's suite

## Acceptance

- [ ] A failing `test`/`lint`/`typecheck` step on any registered builder lands exactly one followup file (frontmatter-canonical `key:`) per red onset; continuously-red steps do not re-write
- [ ] No botctl page on the findings path; watchdog dead-man page is the only notification
- [ ] Scanner opens buildbot's `state.sqlite` strictly read-only and degrades to empty findings (heartbeat still stamped) when the DB is missing/locked/schema-skewed
- [ ] `bun run test:full` green; import-pin covers the new entrypoints
- [ ] Triage home charter `## Sitter facts` matches the shipped key scheme and category list

## Early proof point

Task that proves the approach: ordinal 1 (the scanner against the live
buildbot DB). If reading `state.sqlite` proves brittle, fall back to the
buildbot REST API (`/api/v2/builds`) that fn-781's builds-worker already
polls — same data, network dependency accepted.

## References

- `babysitters/FINDINGS-LEDGER.md` — the key/ledger/resurface contract this producer feeds
- `babysitters/performance/watch.ts` + `babysitters/agents/performance.md` — the template pair
- `~/.local/state/buildbot/master/state.sqlite` — the surface (WAL mode; `builds`/`builders`/`steps` populated; `test_results` empty, so per-step is the finest grain that exists)
- `~/code/arthack/system/buildbot/notify.py` — `_failed_steps` + the FAILURE(2)+EXCEPTION(4) page predicate the detectors replicate (semantic reference only; in-memory, nothing to read at runtime)
- fn-781 (done) built keeper's `builds` projection — deliberately NOT the source here: one row per builder, no step names, no history
- fn-789 (open, tmux exec backend) — reviewed for overlap: write targets disjoint, no dep wired

## Docs gaps

- **README.md**: add a step-8-style install section for the `builds` plists; update the stale "future sitters — git-orphans, dead-letters" aside (~line 485)
- **~/docs/babysitters/builds/charter.md**: prune-and-replace `## Sitter facts` with the real category list and key scheme (task 2's deliverable)

## Best practices

- **Monotonic cursor, not timestamps:** track a per-builder completed-build high-water mark; build numbers are clock-skew immune and make scans O(new builds) [Buildbot REST docs]
- **Stable keys:** never a build number, job id, or raw message in the dedup key; build number is a cursor, the (builder, step) pair is the identity [Sentry/Atlassian]
- **Sanitize before keying:** step names contain `:` (`test:full`) — sanitize before embedding in the `:`-delimited key and in followup filenames [gap analysis]
- **Atomic state writes + versioned schema:** tmp+rename for seen-state/heartbeat; `version` field from day one, mismatch → rescan, never error [Node patterns]
