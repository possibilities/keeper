## Overview

keeperd's `syncPlanLinks` fold re-derives the entire `epics.job_links`
reverse-index from scratch on every plan-touching event — O(touched_epics ×
swept_sessions × invocations), 0.75–3.0s/event. On a cursor-rewinding
migration this replays all history into a ~15-min socket-down catch-up with a
3–4 GB WAL. This epic replaces the per-epic full session-sweep with an
idempotent per-session replace-by-key merge (the same pattern the production
sibling `syncJobLinksOnJobWrite` already runs), making per-event cost
independent of plan history and board size while preserving byte-identical
re-fold determinism. Ships in two steps: the fold change lands first (no
rewind, no storm — new logic is byte-identical to the old per event), then a
version-guarded rewind-and-redrain migration converges and self-validates the
projection under the new fast logic.

## Quick commands

- `bun run test:full`
- `bun test test/refold-equivalence.test.ts`
- `bun test test/reducer-links.test.ts`
- `grep -E 'ptufold-breakdown|commitfold-breakdown' ~/.local/state/keeper/server.stderr | tail`  # post-deploy: plan folds should drop from 750–3000ms to single-digit ms

## Acceptance

- [ ] `syncPlanLinks` per-event cost is constant/bounded — independent of sessions-per-epic and board size
- [ ] byte-identical re-fold determinism preserved (refold-equivalence gate + static enrichment-freshness guard)
- [ ] cold re-fold after the migration completes in ~1–2 min (was ~15 min), no multi-GB WAL storm
- [ ] all existing reducer-links / refold-equivalence / schema-version tests green; `bun run test:full` green

## Early proof point

Task that proves the approach: `.1` — the refold-equivalence byte-identity
pass over the new per-session merge, including the stale-other-session
scenario (the keystone enrichment-freshness claim). If it fails: the
enrichment-freshness invariant does not hold as assumed — fall back to also
re-enriching preserved entries (still cheaper than the full sweep, loses one
win), or escalate to the durable `plan_link_edges` edge-table alternative.

## References

- Investigation: `SLOW_FOLD_INVESTIGATION.md` (live evidence: 98.7% CPU, socket-down 21 min, WAL 4.18 GB, `commit_trailer_facts`=1928).
- Sibling precedent: `src/reducer.ts:5197-5273` (`syncJobLinksOnJobWrite` — the idempotent drop-and-re-add already in production; re-stamps the OLD entry's `kind` and uses a bare shell-insert, so the shared helper is the job_links MERGE ONLY).
- Migration template: `src/db.ts:4264-4295` (v80 rewind-and-redrain — RAISE the git floor, do NOT wipe `commit_trailer_facts`).
- License for slicing by session: `src/plan-classifier.ts:346` — the dedup key is `(kind, job_id)` where `job_id` IS the session id, so distinct sessions never cross-suppress; an epic's `job_links` is the deterministic union of independent per-session slices.
- Rejected alternative: a normalized `plan_link_edges` projection (durable `(session_id, epic_id, kind)` edge table) — sidesteps the orphan/enrichment risks structurally but costs a new deterministic-replayed projection + migration + taxonomy registration; unwarranted unless orphan-edge churn proves real.
- Determinism gate: `test/refold-equivalence.test.ts`; CLAUDE.md "re-fold determinism is sacred" + the per-event-cost "time-bomb" invariant.

## Docs gaps

- **README.md `## Architecture`**: revise the `syncPlanLinks` narrative (~2368-2390), the cross-session-sweep index justification (~88-100), the `[commitfold-breakdown]` "swept sessions" counter (~572-573); add a v81 schema-history block (~2283-2313 pattern).
- **CLAUDE.md / AGENTS.md**: extend the "fold whose per-event cost grows with history is a re-fold time-bomb" bullet (lines 88-91) to also name the O(board-size)/O(projection-size)-per-event axis.
- **keeper/api.py**: the `SUPPORTED_SCHEMA_VERSIONS` comment block gains v81.

## Best practices

- **One shared apply() for live + rebuild paths:** the per-session merge must be the same code the redrain runs — forking live vs rebuild logic is the top source of projection divergence. [martendb.io]
- **Replace-by-key, never additive append:** drop the session's entries before splicing — additive append doubles on re-fold. [event-driven.io]
- **Lock JSON key order + total-order sort with a unique tiebreaker:** `JSON.stringify` is not canonical across V8 versions; `enrichJobLink`'s locked key order + `sortJobLinks`' `(kind, job_id)` tuple are the byte contract. [RFC 8785]
- **Property-based equivalence test (fast-check):** random valid event sequence + random split point, assert full-rebuild == incremental — highest-confidence verification. [verraes.net]
