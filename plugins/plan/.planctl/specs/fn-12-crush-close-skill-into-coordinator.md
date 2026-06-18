## Overview

Rebuild `/plan:close` as a content-blind coordinator, completing the fn-5/fn-6
crush pattern for the close phase. All pipeline artifacts (audit brief, audit
report, verdict, follow-up plan) persist as files under gitignored
`.planctl/state/audits/<epic_id>/`, validated at emission by new submit verbs;
a `close-finalize` verb encodes the saga (reversible scaffold before
irreversible close) in Python derived purely from observable state. The
quality-auditor goes content-blind, a new close-planner agent absorbs the
classifier + the closer's inline vet/cull/merge + follow-up authoring, and
skills/close/SKILL.md shrinks from 28KB of prose logic to a ~7KB typed-envelope
switch. End state: the closer's context holds only envelopes and one-line agent
summaries; every parser, validator, and saga rule has pytest coverage.

## Quick commands

- `uv run pytest tests/ -q` — full suite green
- `planctl close-finalize --help && planctl audit submit --help && planctl verdict submit --help && planctl followup submit --help` — verbs registered
- `grep -rn "claude-opus-4-5\|claude-sonnet-4-6" skills/close/ agents/quality-auditor.md agents/close-planner.md ; echo "exit=$?"` — exit 1 (no version-pinned model ids)
- `test ! -e agents/classifier.md && test ! -d skills/close/classifier && echo gone` — classifier fully deleted

## Acceptance

- [ ] `close-preflight` writes `audits/<epic_id>/brief.json` (commit-free, atomic) and its envelope carries `{brief_ref, commit_set_hash, primary_repo}` with NO prose fields; `all_done:false` is a typed `TASKS_NOT_DONE` error; task-id input names the parent epic
- [ ] `audit submit` / `verdict submit` / `followup submit` validate at emission with typed reject envelopes and persist commit-free under `audits/<epic_id>/`; the old 8-field Finding schema + tier arrays + `skills/close/classifier/` are retired
- [ ] `close-finalize` is idempotent from observable state, refuses on `commit_set_hash` mismatch (`STALE_ARTIFACTS`), ports the partial-followup completeness invariant, and `epic followup-of` is retired
- [ ] quality-auditor is content-blind (reads BRIEF_REF, persists via `audit submit`, one-line return contract); close-planner exists with verdict/followup submission, escape-hatch ladder, and `QUESTION:` protocol; classifier is deleted; no version-pinned model ids
- [ ] skills/close/SKILL.md is the thin coordinator (single error pattern, no cd, warm/cold QUESTION resume, typed-outcome switch) with a close-skill consistency test
- [ ] Docs sweep done: CLAUDE.md, README, commit-at-mutation-boundary.md, workflow mermaid — present-tense, stale hookctl pointer gone

## Early proof point

Task that proves the approach: `.1` (audit-artifacts module + preflight rewrite). It establishes the artifact paths, the commit_set_hash canonicalization, the commit-free atomic writer, and the brief contract every later task consumes. If it fails (hash non-determinism or a commit fires from a state write): stop and fix the artifact module before any submit verb is built on it.

## References

- fn-5 (content-blind orchestrator) and fn-6 (reconcile verdict verb) — the crush pattern this completes for close; `planctl/brief.py` and `planctl/run_reconcile.py` are the templates.
- `planctl/commit_lookup.py:find_commit_groups` — sole source for commit_groups and the hash input; first-seen order preserved for display, sorted independently for hashing.
- Design provenance: /hack session 2026-06-09 — settled: agents pipe payloads to submit verbs (verbs own paths); finalize derives saga position from observable state (no saga-state file); stale hash refuses, never deletes; auditor return-line contract `report_ref=… risk=… findings=N` with unparseable→spawn-planner fail-safe; expected-cluster count derives from verdict.json and is cross-checked at `followup submit`.
- `fn-768` (keeper) — overlap: both edit this repo's CLAUDE.md (Removed-verbs list vs /plan:close bullet); dep edge wired so whichever lands second rebases cleanly.

## Docs gaps

- **CLAUDE.md**: /plan:close bullet (saga verbs + close-planner, drop classifier/<VERDICT_JSON>), auditor parenthetical (now persists a report), Removed-verbs list absorbs `classifier` + `epic followup-of`
- **README.md**: Planning-Skills /plan:close row + Command Map (five verbs in, `epic followup-of` out; `reconcile` entry at README.md:66 is the model)
- **docs/reference/commit-at-mutation-boundary.md**: §3 verb-classification rows (preflight + submits = runtime-state-only like `claim`; close-finalize documented incl. envelope ownership), §13 testing-patterns rows
- **docs/diagrams/planctl-workflow.mermaid.md**: Close-Skill subgraph → saga flow (drop spawn_classifier/parse_verdict nodes)

## Best practices

- **Validate-at-emission reject UX:** machine-readable error list (loc/type/msg), top-3 errors + minimal schema fragment for the offending path — never the full schema in a retry prompt [practice-scout: pydantic-ai/instructor reask]
- **Canonical hash:** sort SHAs lexicographically into sorted-key JSON, SHA-256 the UTF-8 bytes, include artifact schema version, exclude timestamps; never hash a set [practice-scout]
- **Saga pivot:** stale-detection and all reversible work BEFORE the irreversible close; never compensate after the pivot [practice-scout: Azure saga]
- **Path handoff:** agents pass/receive artifact paths, never contents; one-line summaries only [practice-scout: Anthropic multi-agent]
- **yaml.safe_load + stdin byte caps** on every submit verb (1 MiB, matching scaffold) [practice-scout]
