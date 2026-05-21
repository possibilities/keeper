## Overview

Add the **priority-3 title source** to keeper: the session transcript's
`custom-title`, read live by keeperd (NOT the hook). This is the merged
fn-545's designed-for followup — fn-545 built the `title_source` precedence
column + precedence write (`{spawn:1, payload:2}`, NULL=0) specifically so a
higher-priority source could drop in with no reducer rewrite. This epic adds
`transcript: 3` plus the producer that feeds it.

It closes two gaps the lower tiers can't: (1) **live `/rename`s** appear within
a watch interval instead of waiting for the next prompt, and (2) the ~13% of
sessions whose final title never reaches a hook payload (a rename not followed
by a prompt) finally get the right title.

A new keeperd **Worker thread** (`src/transcript-worker.ts`) uses
`@parcel/watcher` to recursively watch `~/.claude/projects`, ports jobctl's
deterministic forward-tail JSONL line-stream (byte-offset map + partial-line
buffer + read-to-EOF + truncation guard + malformed-skip + change-only emit +
restart-seed), and posts `{kind:"transcript-title", sessionId, title}` to main.
**Main stays the sole writer**: it inserts a synthetic `events` row
(`hook_event="TranscriptTitle"`, title carried in `data.session_title`) via its
existing writable connection + `insertEvent` stmt, then `pumpWakes()`. The
reducer folds it at priority 3 — re-fold-deterministic because the title lives
in the event log, never written straight to `jobs`.

**Two deliberate shifts, both called out for reviewers:** (a) keeper gains its
**first runtime dependency** (`@parcel/watcher`, a native FSEvents-backed
addon — spiked PASS under Bun this session); (b) **keeperd becomes an event
*producer*** for the first time (V1/V2 the hook was the sole producer). The
"no kernel file watchers" / "no transcript tailing" DO-NOT fences are
**narrowed, not removed** — scoped to keeper's own SQLite DB (where
`data_version` polling stays mandatory); native watching of *external*
transcript files in the daemon is now permitted (still forbidden in the hook).

## Quick commands

- `bun test --isolate` — full suite (reducer 3-source precedence, v4→v5 migration, worker lifecycle, e2e)
- `bun add @parcel/watcher` then `bun -e 'import w from "@parcel/watcher"; const s=await w.subscribe(process.env.HOME+"/.claude/projects",(e,ev)=>console.log(ev)); '` — confirm the addon loads + fires under Bun
- Append a `custom-title` line to a transcript under `~/.claude/projects` and watch `jobs.title` flip: `sqlite3 ~/.local/state/keeper/keeper.db "SELECT job_id,title,title_source FROM jobs"`

## Acceptance

- [ ] A live `custom-title` write (or `/rename`) to a watched transcript updates that session's `jobs.title` within a watch interval, with `title_source='transcript'`
- [ ] Transcript titles fold at priority 3: they beat `payload`(2)/`spawn`(1), and a later/stale `payload` event never clobbers a transcript title
- [ ] Re-fold from scratch (rewind cursor, `DELETE FROM jobs`, re-drain) reproduces identical `(title, title_source)` — synthetic events are in the log and replay deterministically
- [ ] `@parcel/watcher` loads and fires under `bun test` (smoke test); a missing `~/.claude/projects`, per-file read error, or torn/malformed line skips-and-logs without crashing the worker
- [ ] Main remains the sole `jobs`-writer and the sole in-process writable connection; the worker is read-only and only posts messages
- [ ] SCHEMA_VERSION is 5; `jobs.transcript_path` exists, backfills NULL on old rows, migration idempotent across re-opens

## Early proof point

Task that proves the approach: `.1`. It lands the schema + reducer side and
proves — with hand-inserted `TranscriptTitle` synthetic events in unit tests —
that the priority-3 fold, the no-clobber guarantee, and re-fold determinism all
hold *before any watcher exists*. If it fails: the precedence generalization is
wrong; fall back to a dedicated `transcript_title` data key + a parallel
extractor rather than reusing `session_title`.

## References

- `~/docs/2026-05-21-keeper-transcript-title-supplement-handoff.md` — the design handoff (decided architecture, change list, open questions)
- `~/docs/jobctl-and-hooks-tracker-primer.md` §5 — the jobctl transcript-reading model this ports
- `~/code/arthack/apps/jobctl/jobctl/run_run_server.py` — `TranscriptLineStream` (~6605, forward-tail core to port) + `_read_title_from_transcript` (~5616, restart-seed reader)
- `fn-545-seed-job-titles-from-spawn-name` (**done/merged**) — the precedence foundation this builds on. The handoff's `blockedBy` edge is **already satisfied** (fn-545 shipped at 5516c56); no live dep edge to wire.
- `@parcel/watcher` v2.5.6 — native FSEvents-backed watcher; coalesces to one event per file ("go look", not the data); `getEventsSince`/`writeSnapshot` catch-up; spiked PASS under Bun 1.3.14 this session. Fallback if it ever fights CI: chokidar v5 (pure JS) or `Bun.watch()`.
- Transcript line shape (verified against real transcripts): `{"type":"custom-title","customTitle":"<title>","sessionId":"<uuid>"}` — `customTitle` camelCase; the line carries `sessionId`, so the worker routes by it directly.

## Docs gaps

- **CLAUDE.md (= AGENTS.md symlink)**: narrow the "No kernel file watchers" + "no transcript tailing" DO-NOT bullets (carve-out scoped to external transcript files in the daemon, distinct from the SQLite `data_version` mandate); add the worker to Directory layout + Module entry points; State machine gains the `TranscriptTitle` synthetic event + a `title_source` priority-3 row + a "V3: keeperd is now a producer" note; Event-sourcing invariants amend "hook is the sole events writer" → main may insert synthetic `TranscriptTitle` events (ordering/idempotency vs. the drain loop); Worker contract gains a producer-archetype note; bump the `src/db.ts` `SCHEMA_VERSION` mention to 5 + `jobs.transcript_path`; `src/types.ts` `Job` gains `transcript_path`
- **README.md**: "zero third-party runtime dependencies" is now FALSE — update + explain `@parcel/watcher`; Architecture two→three workers; narrow the non-goals (transcript tailing / kernel watchers); Inspect `SELECT` comment adds `'transcript'` to the `title_source` value list
- **plist/arthack.keeperd.plist**: note the native addon needs `bun install` (and a resolvable `node_modules`) in the deploy environment before first run

## Best practices

- **Treat watcher events as "something changed, go look", never as the data:** `@parcel/watcher` coalesces to one notification per file (create+delete can yield NO event) — always `fstat` + tail from the stored offset, never trust the event payload to say what changed
- **Decode with a per-file `StringDecoder('utf8')`, not `chunk.toString()` per read:** a multi-byte char (emoji/CJK in a title) split across a read-chunk boundary silently decodes to `U+FFFD` — a real corruption bug (undici #5035), not theoretical
- **Key offsets by path, not inode:** a session fork is a new file with a new session-id filename; Claude Code does not rotate/rename transcripts in place. New path = offset 0
- **Smoke-test the native addon under the test runner + pin `@parcel/watcher@2.5.6`:** N-API load failure under Bun is a hard `dyld` crash, not a catch-able error — assert `subscribe` fires in CI
- **Security:** the `customTitle` is attacker-influenceable text that flows to `jobs.title` and out the UDS — keep it SQL-param-bound (keeper already does), never interpolated; resolve+validate watched paths under the canonical root (symlink hardening); skip-and-log oversized/malformed titles
