## Overview

Hand-started harness sessions become tracked keeper jobs. Today every non-claude tracking mechanism keys on a jobs row that exists only if the `keeper agent` launcher minted a birth record — hand-started hermes/codex sessions are invisible. v1: the hermes shim self-seeds identity from the harness-native session id when KEEPER_JOB_ID is absent (claude's exact events-log path — full-featured, restore included). v2 (gated, default OFF): positive-evidence codex rollout adoption that preserves refuse-to-guess and mints coordless, adopted-marked jobs from main. pi adoption is deliberately not built (no persistent install by design, no durable artifact; revisit only if pi grows one).

## Quick commands

- `bun test test/hermes-shim.test.ts test/codex-resume.test.ts test/schema-version.test.ts test/restore-set.test.ts` — the touched fast suites
- `hermes` hand-started in a tmux pane → `keeper jobs` shows an adopted hermes row with live state and pane coords
- `keeper query autopilot_state` → the codex adoption knob present and OFF by default

## Acceptance

- [ ] A hand-started hermes session appears as a tracked, adopted-marked keeper job under its native session id — with live state, cwd, and full pane coordinates — and restores like a launched session
- [ ] With the knob ON, an originator-less codex rollout that is the sole unambiguous candidate for its cwd is adopted as a coordless, adopted-marked job timestamped from the rollout's own session-start; ambiguous or stale-originator rollouts are never adopted; with the knob OFF (default) nothing changes
- [ ] Adoption is idempotent and dedup-safe: native id is the job id, re-mints fold as resume without clobbering the adopted marker, and discovery never adopts a launcher-owned session
- [ ] Restore reports adopted-coordless skips as a surfaced count, never a silent drop
- [ ] One SCHEMA_VERSION bump covers the adopted column and the knob column, with the Python whitelist updated in the same commit

## Early proof point

Task that proves the approach: ordinal 1 (the adopted column + events plumbing — the cross-cutting primitive both modalities consume). If it fails: re-scope the marker to a jobs-only column derived at mint sites and re-plan the shim contract before tasks 2-4 start.

## References

- Push/pull adoption frame (panel-reviewed): hermes is push (its persistently-seeded shim already fires for hand-started sessions — identity is the only missing piece); codex is pull (rollout artifacts, no env, coordless-by-design); pi is neither — its extension is ephemeral-by-design per-launch and no durable artifact exists. Revisit pi only if that changes.
- The derived-adopted alternative (harness+id-equality signature instead of an explicit field) is rejected: launcher-started pi pins native id as both job_id and resume_target, so the signature false-positives on every launched pi job.
- Codex "not keeper-owned" predicate: originator strictly absent/empty. A present-but-unmatched originator is skipped (no stale-originator recovery in the dark v2).
- Epic-dep edges carried for same-file serialization: fn-1129 (identical SCHEMA_VERSION + api.py + reducer/types surface — the version counter is a hard serialize), fn-1122/fn-1123/fn-1125/fn-1127 (src/daemon.ts), fn-1130 (root docs).
- Consent posture: the hermes self-seed is on by default on the human's own machine, with a local opt-out env checked fail-open by the shim; the codex path is knob-gated OFF.

## Docs gaps

- **README.md**: consolidate the harness-tracking narrative sentence to cover hand-started hermes self-seed + gated codex adoption (revise, not append); one clause on pi deliberately not built
- **CLAUDE.md**: one-line refinement to the hermes-shim bullet (self-seeds under the native id only when KEEPER_JOB_ID is absent)
- **CONTEXT.md**: new glossary entries — Adopted job (and the originator ownership discriminator) in the session-surface section
- **docs/adr/**: new 0006 record for the coordless positive-evidence adoption model
- **docs/problem-codes.md**: only if the restore skip surfaces a new exit code (stdout-note-only needs no row)

## Best practices

- **Producer-id dedup at both layers:** the harness-native id rides the payload and the fold's ownership check plus the id-keyed conflict path enforce it — push and pull can race the same session [CockroachDB/Convoy idempotency guidance]
- **Untrusted-artifact boundary:** rollout files and shim payloads are user-writable — whitelist id charsets, canonicalize cwd on the raw value, emit one bounded JSON line [CAPEC-23, log-injection chains]
- **Pending-last-line discipline:** never mint from a half-written rollout record; unparseable records skip without failing the scan [log-tailer practice]
- **Throttled backfill with live kill-switch:** the knob-flip backlog is the perf cliff — per-tick cap + recency window, knob re-checked per tick [backfill throttling practice]
- **Event-time vs ingest-time:** only the immutable session-start timestamp enters the deterministic projection; never mtime or wall-clock at fold time [event-sourcing practice]
