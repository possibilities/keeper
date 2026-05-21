## Overview

Make keeper's `jobs.title` correct as early as SessionStart by seeding it from the session's spawn name (the `--name`/`-n` flag on the parent claude process argv, scraped via `ps` in the hook), and introduce a title-provenance/precedence model so a later transcript-reading epic slots in as a higher-priority writer with no reducer rewrite. This is **Tier 1**; Tier 0 (folding payload `session_title` from `UserPromptSubmit`) already exists in the reducer. Tier 1's sole job is to close the `[SessionStart, first UserPromptSubmit)` window — currently the only window where a job row reads `title=NULL` despite the session having a name. End state: a subscriber paging `jobs` sees a non-NULL `title` (and a `title_source` of `'spawn'` then `'payload'`) from the very first SessionStart, updating live as higher-priority sources arrive.

## Quick commands

- `bun test --isolate` — full suite, including new `nameFromArgs` unit, db v3→v4 migration, reducer precedence (seed/promotion/monotonicity/re-fold), and hook spawn_name cases.
- `sqlite3 "file:$HOME/.local/state/keeper/keeper.db?mode=ro" "SELECT job_id, title, title_source, state FROM jobs WHERE title IS NOT NULL LIMIT 5;"` — eyeball seeded titles + provenance on a live DB (read-only URI; bun:sqlite `{readonly}` fails SQLITE_CANTOPEN on WAL DBs).

## Acceptance

- [ ] `events.spawn_name TEXT` + `jobs.title_source TEXT` added (both nullable); `SCHEMA_VERSION` is 4 and an already-v3 DB migrates cleanly + idempotently with existing rows preserved.
- [ ] On SessionStart only, the hook scrapes `--name`/`-n` from the parent argv via `ps` into `spawn_name`, never throws, still always exits 0, adds no new imports; non-SessionStart rows leave `spawn_name` NULL.
- [ ] The reducer seeds `title`/`title_source='spawn'` at SessionStart and folds titles by precedence (`{spawn:1, payload:2}`, write iff `p > pp OR (p == pp AND value changed)`), comparing persisted state in-txn, inside the one `BEGIN IMMEDIATE`, re-folding idempotently; a lower-priority source never overwrites a higher one.
- [ ] `title_source` served on the jobs read surface; `Event`/`Job` types updated; CLAUDE.md DO-NOT fence narrowed + state-machine/README docs updated; Tier 0 still works unchanged.

## Early proof point

Task that proves the approach: `fn-545-seed-job-titles-from-spawn-name.1` — it is the whole feature in one coherent slice (schema + hook capture + reducer precedence + read surface + docs + tests). If it fails: the most likely fault line is the precedence write (wrong `pp`-default for a NULL `title_source`, or comparing an accumulator instead of the persisted tuple — breaking re-fold determinism), or an events-INSERT/SELECT site left out of sync so `spawn_name` reads NULL at the reducer — both are isolated by dedicated tests, so a failure points at one seam, not the whole design.

## References

- Probe evidence (`~/code/keeper-probe`, 23 keeper sessions): spawn name is absent from every hook payload until first `UserPromptSubmit` (SessionStart payload carries only cwd/model/session_id/source/transcript_path); it lives only on the parent argv. At first UPS, payload `session_title` == spawn name in 17/18 named sessions, so Tier 0 already seeds at first prompt — Tier 1 is the permanent floor for the pre-first-prompt window, not redundant with the future transcript epic.
- `~/.local/bin/arthack-claude.py` (~:2524) — the launcher injects `--name <session_name>` into the claude argv; confirms the flag's presence and the single-token format `nameFromArgs` parses.
- `fn-6-jobs-title-and-history` (done) — predecessor that introduced `jobs.title` and the `UserPromptSubmit` title fold (Tier 0); this epic extends that same reducer branch and `jobs` column.
- `fn-1-keeper-reducer-v1` (done) — established the `events`/`jobs` schema + the `SCHEMA_VERSION` migrate-slot pattern (3→4 follows it).
- `fn-4-namespace-subscribe-protocol-by` (done) — established `CollectionDescriptor`; this epic adds `title_source` to the jobs descriptor's served columns.
- **Planned reverse-dependency (not yet created):** a future "transcript-supplement" epic where keeperd (the daemon, NOT the hook) reads the transcript `custom-title` on its data_version/poll cadence as a priority-3 source — to catch live `/rename`s and the ~13% of sessions where the final transcript title never reaches the payload. That epic depends on the `title_source` provenance seam this epic introduces; when created it should declare a `blockedBy` on `fn-545`. Do not create it now.

## Docs gaps

- **CLAUDE.md (DO NOT, ~:183-185)**: narrow the blanket "name scraping" prohibition to ALLOW spawn-name-at-SessionStart, in-hook, frozen-to-event ONLY — still forbidding multi-session lineage and general/ongoing name scraping. (Load-bearing: this fence currently forbids the whole feature. AGENTS.md is a symlink — editing CLAUDE.md suffices.)
- **CLAUDE.md (State machine, ~:107-114)**: SessionStart now seeds `title` from `spawn_name` + sets `title_source='spawn'`; the `UserPromptSubmit` title bullet changes from "last-write-wins" to precedence-ordered (`{spawn:1, payload:2}`).
- **CLAUDE.md (Event-sourcing invariants, ~:132)**: the "defaults match the zero-event projection" note — a SessionStart row now reads `title=<spawn_name or NULL>` / `title_source='spawn' or NULL`, not unconditionally `title=NULL`.
- **CLAUDE.md (~:120-122 schema-v3 retirement note + Directory layout db.ts/collections.ts/events-writer.ts entries)**: add the v4 columns and the hook's SessionStart scrape behavior.
- **README.md ("What keeper is NOT", ~:51 "No name scraping")**: narrow to reflect scoped spawn-name capture is now in scope (hook, SessionStart, `ps` argv only); general name scraping + transcript tailing remain out.
- **README.md (jobs enumeration ~:10, Inspect SQL ~:172-174)**: note title is seeded at session start with `title_source` provenance; add `title_source` to the example query.
- **src/types.ts**: `Job` JSDoc that says "last-write-wins" must describe precedence-ordered provenance.

## Best practices

- **`Bun.spawnSync` THROWS on a missing executable** (ENOENT), it does not return a failed result — so a bare `if (!result.success)` is insufficient; wrap the whole spawn+parse in try/catch returning null to hold the exit-0 contract. [verified on darwin/Bun 1.3.14]
- **`ps -o args=` space-joins argv and drops shell quoting** — `--name "a b"` is indistinguishable from `--name a b trailing-arg`. Capture a single whitespace-delimited token (locked decision); document that multi-word names truncate. Anchor the regex to a flag boundary so `--rename`/`--username` can't false-match. [verified]
- **Pass an explicit `timeout` to `spawnSync`** (e.g. 500ms) and prefer `ps -ww` so a wedged or width-truncating `ps` can never threaten the hook budget; the scrape runs only on SessionStart, not on the 1.5s-capped SessionEnd. [verified on darwin; -ww matters on Linux procps]
- **Never store the raw `args=` blob** — process command lines routinely carry secrets (`--token=...`); extract only the name into its dedicated column and discard the remainder. [security]
- **Precedence write must be a pure function of persisted state** read in-txn (NULL `title_source` → priority 0); an accumulator breaks rebuild-from-scratch idempotency — the same discipline as the existing Tier 0 fold. [event-sourcing idempotency]
