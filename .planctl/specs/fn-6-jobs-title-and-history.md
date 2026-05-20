## Overview

Give the keeper `jobs` projection a human-readable `title` plus a `title_history` log, mined from the `session_title` field Claude Code carries in `UserPromptSubmit` hook payloads (already stored in the events `data` blob). The reducer folds the title into a new `jobs.title` column and appends to a `jobs.title_history` JSON-array column on every real change (natural chronological order, repeats allowed across reverts, current title is the tail); both columns are served live over the UDS subscribe surface, with `title_history` decoded to a real array at the read boundary. End state: a subscriber paging `jobs` sees `{ ..., title: "fix-osc-reset", title_history: ["keeper-009", "fix-osc-reset"] }`, updating live. Transcript-sourced titles (jobctl's `TitleHandler` approach) are a deferred future phase — they need transcript tailing, currently forbidden by CLAUDE.md.

## Quick commands

- `bun test --isolate` — full suite, including new reducer (append/revert/unchanged/malformed/re-fold), db (schema_version=2, v1→v2 migration), and server round-trip (array shape) cases.
- `sqlite3 ~/.local/state/keeper/keeper.db "SELECT job_id, title, title_history FROM jobs WHERE title IS NOT NULL LIMIT 5;"` — eyeball folded titles + history on a live DB.

## Acceptance

- [ ] `jobs` carries `title TEXT` (nullable) + `title_history TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(title_history))`; `SCHEMA_VERSION` is 2 and an already-v1 DB migrates cleanly (existing rows read `title_history=[]`).
- [ ] The reducer folds `session_title` into `title`/`title_history` (append-on-change, no dedup, reverts re-append), skips the write when unchanged, stays inside the one `BEGIN IMMEDIATE`, and re-folds idempotently; a malformed blob skips-and-logs without wedging the cursor.
- [ ] `title` + `title_history` are served on `result` and `patch` frames, `title_history` decoded to a real array at BOTH read seams; a title-less job reads `[]`.
- [ ] `Job` type + README + CLAUDE.md reflect the new attribute.

## Early proof point

Task that proves the approach: `fn-6-jobs-title-and-history.1` — it is the whole feature in one coherent slice (schema + reducer fold + read-boundary decode + serve + docs + tests). If it fails: the most likely fault line is read-decode parity (page SELECT vs selectByIds diverging on `title_history` shape) or re-fold determinism (append comparing against an accumulator instead of the persisted tail) — both are isolated by dedicated tests, so a failure points at one seam, not the whole design.

## References

- `/Users/mike/docs/jobctl-and-hooks-tracker-primer.md` §5 — how jobctl mines `name` from transcript `custom-title` lines (`TitleHandler`, `_read_title_from_transcript`); the model for the deferred transcript phase.
- `~/code/arthack/apps/jobctl/jobctl/run_run_server.py` — `TitleHandler` (~:6126) and the `job_name_history` shape keeper's `title_history` parallels (keeper diverges: natural-order log, no UNIQUE).
- Epic deps: none — `epic-scout` found all repo epics (fn-1..fn-5) `done`, no open epics to wire.

## Docs gaps

- **README.md**: line 10 jobs-projection enumeration (add `title`); line 174 inspection SQL `SELECT job_id, state, mode, last_event_id FROM jobs` (add `title`).
- **CLAUDE.md**: state-machine `UserPromptSubmit` bullet (add the title read-modify-write sentence); `src/collections.ts` descriptor field inventory (add `jsonColumns`); the "defaults match the zero-event projection" invariant (name `title=NULL` / `title_history='[]'`).

## Best practices

- **Append-vs-tail is what makes the fold re-foldable:** compare the incoming title against the persisted `title` (read in-transaction) and append only on difference. Unconditional append double-counts on a rebuild-from-scratch. [event-sourcing idempotency]
- **JSON-array TEXT column, not a side table:** `title_history` is appended-whole / read-whole / bounded and never filtered per-element — the profile where a JSON column beats normalization; a side table would add a second write target inside the per-event txn for no query benefit. [SQLite json1]
- **`ADD COLUMN` with `NOT NULL` needs a literal default** (`DEFAULT '[]'`) — SQLite rejects a NOT-NULL add with a NULL default; the literal default also backfills existing rows without a table rewrite, matching the zero-event projection. [sqlite lang_altertable]
- **Decode the JSON array once at the read boundary** (app-side `JSON.parse` of the whole cell), not via `json_each`/`json_extract` — faster for whole-array reads and keeps the `meta`/COUNT path (which never needs the array) untouched. [sqlite forum benchmark]

## Snippet context

Bundles inherited or curated for this epic:
- `sketch/keeper-jobs-title-attribute` — the `/arthack:sketch` handoff that seeded this plan (no snippets attached; carried forward for provenance).
