## Overview

A Claude Code session created via `claude --fork-session` gets a NEW session
id that never emits a `SessionStart` hook event — the SessionStart fires under
the PARENT id, then every subsequent event carries the fork's new id. keeper's
jobs fold (`projectJobsRow`) mints a `jobs` row ONLY from `SessionStart`; every
other arm is `UPDATE … WHERE job_id = ?`, a silent no-op when the row is
absent. Net: a forked session gets NO job row and is invisible to the jobs
projection, the board, and `restore.json` (so it can't be restored after a
crash). This epic makes a forked session a normal STANDALONE job by minting a
minimal row on its first pid-bearing `UserPromptSubmit`. Forward-only: no
SCHEMA_VERSION bump, no migration, no re-fold of existing events; no parent->fork
lineage.

## Quick commands

- `bun test test/reducer-lifecycle.test.ts` — fast reducer-fold coverage (the shard this lands in)
- `bun run test:full` — MANDATORY before landing (reducer/fold path)
- Live smoke after deploy: start `claude --fork-session` from an existing session, submit one prompt, then `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT state,title FROM jobs WHERE job_id='<fork-session-id>'"` returns a working row

## Acceptance

- [ ] A fork-shaped event stream (a `UserPromptSubmit` carrying a pid, with no preceding `SessionStart`) mints a `jobs` row; the session appears live on the board and in `restore.json`.
- [ ] The mint is reaper-safe (the `pid != null` guard keeps it out of the pidless-reap), re-fold deterministic, and does not regress any existing reducer test.
- [ ] The now-stale "SessionStart is the only mint" invariant prose is corrected in code comments and docs in the same change.

## Early proof point

Task that proves the approach: `.1` (the whole change is one task). The
re-fold determinism byte-compare test over a fork-shaped (UPS-only) stream is
the keystone assertion — if a from-scratch re-fold does not reproduce the
minted row byte-identically, the fold edit is wrong. If it fails: the seed is
reading something outside the event (it must use only `event.session_id`,
`event.ts`, `event.cwd`, `event.pid`, `event.id`).

## References

- Design reviewed read-only by codex (pairctl chat_id `f43a2a82`): confirmed Shape A over a broad top-of-function "mint on first sight" (Shape B), the `pid != null` guard, and the `INSERT OR IGNORE`/`ON CONFLICT DO NOTHING` seed shape.
- Root-cause evidence: forked session `779c444d` had 0 `SessionStart` events and 0 `jobs` rows but a full `UserPromptSubmit`/`Stop`/`TranscriptTitle` event stream.
- `src/reducer.ts:6104` — the canonical `SessionStart` `INSERT … ON CONFLICT(job_id)` mint (column + conflict-target template for the seed).

## Docs gaps

- **src/reducer.ts:6757-6758**: the comment "An UPDATE against a missing jobs row is a no-op (SessionStart, the only mint, fires first per session)" is now false — revise in place to state SessionStart OR the first pid-bearing UserPromptSubmit mints.
- **CLAUDE.md** (~line 44 "Scraping is scoped"; ~line 142 "Out of scope"): tighten so it does not imply SessionStart is required for a jobs row; confirm the "multi-session lineage" out-of-scope line still reads correctly (this is attribution, not lineage).
- **docs/exec-backend.md:161-180**: the launch->SessionStart "blind window" / "only durable spawn signal" prose now describes two mint paths (autopilot dispatch via SessionStart; fork via UserPromptSubmit) — revise in place.
- **README.md** (~:2538 inspect SQL comment; scattered SessionStart-creates-jobs-row prose ~276-278, 1560, 1976, 2232): correct any claim implying "no SessionStart -> no jobs row".

## Best practices

- **Prefer `INSERT … ON CONFLICT(job_id) DO NOTHING` over `INSERT OR IGNORE`:** OR IGNORE silently swallows NOT NULL / CHECK / UNIQUE violations and can drop rows undetected; the targeted conflict clause skips only the PK conflict and still surfaces real violations. Matches the SessionStart arm's `ON CONFLICT(job_id)` idiom. [practice-scout: hoelz.ro 2024; sqlite.org/lang_conflict]
- **Self-contained upsert, no pre-SELECT:** do not read projection state to decide whether to insert — the conflict clause is replay-safe and avoids a TOCTOU/re-fold hazard. [practice-scout]
- **Determinism fixture must include a fork-shaped stream:** a clean SessionStart-first fixture never exercises the mint path. [practice-scout: event-driven.io]
