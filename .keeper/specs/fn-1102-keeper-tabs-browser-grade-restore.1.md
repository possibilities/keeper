## Description

**Size:** M
**Files:** src/db.ts, keeper/api.py, src/restore-set.ts, test/restore-set.test.ts, test/schema-version.test.ts

### Approach

Replace the "single newest non-current generation within 256 rows"
selection with a bounded generation-summary walk. Migration (bump
SCHEMA_VERSION by one): add a VIRTUAL generated column on `events` —
`tmux_generation_id` defined as `CASE WHEN hook_event =
'TmuxTopologySnapshot' AND json_valid(data) THEN json_extract(data,
'$.generation_id') END` — plus a partial index on `(tmux_generation_id,
id)` `WHERE hook_event = 'TmuxTopologySnapshot'`. A generated column
indexed as a plain column removes SQLite's exact-expression-text
index-matching footgun; `json_valid` guards malformed rows. Version-guard
the ALTER + index for existing DBs and include them for fresh DBs (the
repo's two-run-site index pattern); add the new version to keeper/api.py
SUPPORTED_SCHEMA_VERSIONS in the same commit.

New deriver shape in restore-set.ts: (1) summarize generations index-only
— GROUP BY tmux_generation_id with MIN(id), MAX(id), COUNT, MIN(ts),
MAX(ts) — ordered by MAX(id) DESC. Event rowid is the recency key; never
compare pid values numerically, and key each summary by (generation_id,
first-seen id) so a reused OS pid never aliases two servers. (2) Bound
candidates to the newest K=5 dead generations (generation_id != G_now)
whose MAX(ts) falls within DEFAULT_IDLE_CUTOFF_SECS. (3) Mark a
generation degenerate when its observed max pane count <= 1 AND its
snapshot ts-span is under 30 minutes (AND, not OR — a long-lived
single-agent session is legitimate); degenerate generations are excluded
from default candidacy but stay listable. (4) For each candidate read its
newest ATTRIBUTED snapshot (at least one pane carries job_id), stepping
back within the generation past the unattributed half of the emission
pair; a generation with no attributed snapshot scores restorable=0. (5)
Restorable count = the post-filter candidate count computed on the exact
snapshot that would be restored (idempotence filters reused verbatim:
backend coords, plan_verb != 'work', not already live). (6) Auto-pick =
max restorable within the bound, recency tiebreak; when the auto-pick is
NOT also the newest non-degenerate candidate, flag the result ambiguous
so consumers escalate to a picker (TTY) or refuse (non-TTY). (7) Zero
restorable everywhere, or no candidate generations at all, degrades to
the existing labeled killed-cohort fallback (fallbackNote preserved).
Export the per-generation summary shape for `keeper tabs list`.
deriveLastGenerationSetFromTopology keeps its signature so existing
consumers keep working while gaining the new selection.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/restore-set.ts:695 — selectDyingGenerationSnapshot (logic being replaced); :180 DYING_GENERATION_SCAN_LIMIT; :611 deriveLastGenerationSetFromTopology + fallbackNote (:622)
- src/db.ts:49 — SCHEMA_VERSION; :660 — existing json_extract expression-index template; :4059 — version-guarded migration step pattern; :4035 — addColumnIfMissing; :2473 — unconditional idempotent index block
- keeper/api.py:414 — SUPPORTED_SCHEMA_VERSIONS frozenset (same-commit rule)
- test/restore-set.test.ts:80,126,156 — seedJob / seedBackendExecStart / seedTmuxTopologySnapshot helpers (explicit rowids — the window logic keys on events.id order)
- src/tmux-control-worker.ts:909-917 — snapshot emit site (payload shape, unattributed/attributed pairing)

**Optional** (reference as needed):
- src/restore-set.ts:333,469 — deriveRestoreSet / deriveLastGenerationSet (fallback model, shared filters at :352)

### Risks

- SQLite ALTER TABLE ADD COLUMN supports VIRTUAL generated columns only (never STORED) — verify bun:sqlite's bundled SQLite accepts the ALTER; the epic's early-proof fallback is a plain expression index + capless DESC distinct-accumulation walk.
- Fresh-DB and migrated-DB schemas must end identical (column + index present in both paths).
- The GROUP BY walk is index-only but linear in snapshot-index entries; acceptable at current scale — the EXPLAIN acceptance pins index usage so regressions surface.

### Test notes

Regression fixtures via the explicit-rowid seed helpers: (a) the recorded
incident — a rich attributed generation older than a 1-pane short-lived
skeleton, both dead, rich one selected; (b) pairing race — chosen
generation's newest snapshot unattributed, attributed sibling one rowid
lower gets used; (c) bound — a rich generation beyond K or past the idle
cutoff is never considered; (d) ambiguity — auto-pick differing from the
newest non-degenerate flags ambiguous; (e) all-degenerate and
zero-candidate boards reach the labeled fallback; (f) EXPLAIN QUERY PLAN
of the summary walk names the partial index. test/schema-version.test.ts
stays green via the same-commit api.py edit.

## Acceptance

- [ ] A dead generation richer in restorable agents is selected over a newer degenerate skeleton generation (recorded-incident fixture passes)
- [ ] The newest attributed snapshot within the chosen generation feeds the restore set even when that generation's newest snapshot carries zero job_ids
- [ ] Generation summaries come from an indexed walk (EXPLAIN QUERY PLAN names the new index, no full events SCAN) bounded to the newest five recent dead generations inside the idle cutoff
- [ ] The selection result carries an ambiguity flag whenever the max-restorable pick is not the newest non-degenerate generation
- [ ] Migrated and fresh databases share the same schema version, generated column, and index; the python API whitelist gains the new version in the same commit
- [ ] Zero-candidate and all-degenerate boards degrade to the labeled killed-cohort fallback with its visible note

## Done summary
Replaced the single-newest dying-generation restore selection with a bounded, richness-ranked walk over per-generation topology summaries: adds the v107 events.tmux_generation_id VIRTUAL generated column + partial covering index (index-only GROUP BY walk), bounds candidates to the newest K dead generations inside the idle cutoff, excludes short-lived single-pane skeletons, steps back to the newest attributed snapshot, and flags ambiguity when the richest pick is not the newest non-degenerate; exports the per-generation summary shape for keeper tabs list.
## Evidence
