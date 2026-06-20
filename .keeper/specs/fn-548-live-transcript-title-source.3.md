## Description

**Size:** S
**Files:** CLAUDE.md (AGENTS.md is a symlink — edit CLAUDE.md), README.md, plist/arthack.keeperd.plist

Document the two shipped shifts (first runtime dep; keeperd as producer) and
**narrow — not remove** — the DO-NOT fences the way fn-545 narrowed name-scraping.

### Approach

- **CLAUDE.md DO-NOT fence:** rewrite the "No kernel file watchers
  (`fs.watch`, FSEvents, kqueue, chokidar)" bullet to scope its prohibition to
  keeper's OWN SQLite DB (where `data_version` polling stays mandatory) and add
  an explicit carve-out: native watching of EXTERNAL transcript files in keeperd
  via `@parcel/watcher` is permitted. Narrow the "no transcript tailing" bullet:
  allowed in the daemon, on a watch, producing events — still forbidden in the hook.
- **CLAUDE.md sections:** add `src/transcript-worker.ts` to Directory layout +
  the Module entry points table; State machine gains the `TranscriptTitle`
  synthetic event + a `title_source` priority-3 row + a "V3: keeperd is now also a
  producer" note (V1/V2 the hook was the sole producer); Event-sourcing invariants
  amend "the hook is the sole `events` writer" → main may insert synthetic
  `TranscriptTitle` events, with the ordering/idempotency note (synthetic event id
  > the session's SessionStart id in practice; folds at priority 3; re-fold
  deterministic); Worker contract gains a producer-archetype note; bump the
  `src/db.ts` `SCHEMA_VERSION` mention to 5 + note `jobs.transcript_path`;
  `src/types.ts` `Job` gains `transcript_path`.
- **README.md:** correct "zero third-party runtime dependencies" → first dep is
  `@parcel/watcher` (+ one line on why: external-process file writes need a native
  watcher; `data_version` only covers keeper's own DB); Architecture two→three
  workers; narrow the non-goals (transcript tailing / kernel watchers); Inspect
  `SELECT` comment adds `'transcript'` to the `title_source` value list.
- **plist/arthack.keeperd.plist:** note the native addon needs `bun install` + a
  resolvable `node_modules` in the deploy environment before first run.

### Investigation targets

**Required** (read before coding):
- CLAUDE.md — DO NOT fence, Directory layout, Module entry points, State machine, Event-sourcing invariants, Worker contract sections
- README.md — "What keeper is" opening (zero-deps claim), "What keeper is NOT" non-goals, Architecture, Inspect
- plist/arthack.keeperd.plist — the inline dependency-posture comment

**Optional** (reference as needed):
- git show 5516c56 — how fn-545 narrowed the name-scraping fence (the precedent for "narrow, don't remove")

### Risks

- AGENTS.md is a symlink to CLAUDE.md — edit CLAUDE.md only; confirm the symlink is intact (`ls -l AGENTS.md`), don't create a divergent copy.
- The carve-out wording is load-bearing: a future reader must NOT copy the watcher pattern onto keeper's own DB. Keep the surviving prohibition explicit alongside the carve-out.

### Test notes

Docs-only; no automated tests. Verify the fence carve-out reads unambiguously and that every doc claim matches the shipped tasks .1/.2 (SCHEMA_VERSION 5, three workers, `transcript` title source, `@parcel/watcher` dep).

## Acceptance

- [ ] CLAUDE.md "No kernel file watchers" + "no transcript tailing" bullets narrowed with an explicit external-transcript carve-out (prohibition on the SQLite DB preserved)
- [ ] CLAUDE.md Directory layout, Module entry points, State machine (TranscriptTitle + priority-3 + producer note), Event-sourcing invariants (main-inserts-synthetic-events), Worker contract (producer archetype), and `src/db.ts`/`src/types.ts` descriptions updated
- [ ] README zero-deps claim corrected (+ rationale); Architecture says three workers; non-goals narrowed; Inspect `title_source` list includes `'transcript'`
- [ ] plist comment notes the `bun install` / `node_modules` requirement
- [ ] AGENTS.md still resolves to CLAUDE.md (symlink intact)

## Done summary
Documented the transcript title source (priority 3) across CLAUDE.md, README.md, and the plist: narrowed the kernel-watcher and transcript-tailing DO-NOT fences with an external-transcript carve-out (SQLite-DB prohibition preserved), documented the @parcel/watcher first runtime dep, the transcript-worker producer archetype + synthetic TranscriptTitle event, SCHEMA_VERSION 5 + jobs.transcript_path, and the deploy-env node_modules requirement.
## Evidence
