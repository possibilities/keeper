# planctl strip — handoff & exploration doc

**What this is:** a priming document for a fresh agent (smart, like the one who
wrote this) to pick up the *full* retirement of the `planctl` name from keeper
and drive it to completion in collaboration with the human. It captures what we
learned investigating the problem, the obstacles, the proven precedents, and the
open decisions — so you start from this conversation's high-water mark instead of
rediscovering it.

**This is a planning artifact, not a behavior doc.** It deliberately narrates an
intended future change (unlike the repo's forward-facing code-comment rule). Treat
it as a living spec: update it as decisions land and phases ship.

**The end goal:** `planctl` exists *nowhere* in keeper except genuinely immutable
historical artifacts — i.e. `.keeper/specs/` plan history and already-written git
commit messages. Everything else — DB columns, the event envelope, the source
badge (already done), commit trailers (emit side), code symbols, the vendored
subtree, and every dual-path transition scaffold — becomes `plan`. The human's
framing: **drop backward-facing support so the dual paths collapse and most of the
grime goes away** — accepting that the DB needs real, one-time heavy lifting to get
there without breaking re-fold determinism.

---

## 1. Where the rename already is (it's ~half-flipped)

This is round-N of a long migration. A lot is already `plan`:

| Surface | State |
|---|---|
| The command | `planctl` is **retired** (not on PATH). `keeper plan <verb>` is the live in-process alias (`cli/plan.ts:22` → `plugins/plan/src/cli.ts`). The hot path / skills call `keeper plan`. |
| The data dir | `.planctl` → `.keeper` migration **complete** everywhere (no `.planctl` dir exists in `~/code` or `~/src` except the vendored subtree's own). plan-worker is `.keeper`-only (`src/plan-worker.ts:386`). |
| The event envelope | Reader prefers `plan_invocation`, falls back to legacy `planctl_invocation` (`src/derivers.ts:485`, `src/reducer.ts:5234,5245`) — **dual-read**. |
| The commit-changed wire kind | `plan-commit-changed` exists alongside legacy `planctl-commit-changed`; the daemon handler accepts **both** (`src/daemon.ts:2484-2486`). |
| The `file_attributions.source` badge | **Already fully renamed** `'planctl'` → `'plan'` by fn-831 (v74→v75) with a data-rewrite migration (`src/db.ts:3720-3736`). CHECK currently allows both (`src/db.ts:1071`). **This is your template — see §4.** |
| commit-work attribution exclude | Already name-tolerant: `[".keeper/", ".planctl/"]` (`src/commit-work/attribution.ts:44`). |
| git-worker watch/ingest gate | **Still `.planctl`-keyed** — being flipped to `.keeper` by epic **fn-855** (the forward-facing slice; see §8). |

**What still says `planctl` (the strip's worklist):** DB columns `planctl_*`, the
legacy `planctl_invocation` envelope key, commit trailers `Planctl-Op:` /
`Planctl-Target:` / `Planctl-Prev-Op:`, all the code symbols
(`extractPlanctlInvocation`, `syncPlanctlLinks`, `normalizePlanctlOp`,
`mintPlanctlFileAttributions`, `isPlanctlChangedPath`, `discoverPlanctlDirs`,
`scanPlanctlDir`, `PlanctlCommitChangedMessage`, …), the dual-path transition
scaffolds, and the `plugins/plan/` git subtree.

---

## 2. The scope contract — what *intentionally* stayed (and is now your worklist)

Two prior sweeps documented exactly what they left behind, and why. Read these
commit messages first — they are the canonical inventory of the residue:

- `git show -s 398b0183` ("refactor(plan): sweep residual planctl refs") — lists
  "intentional residue left intact": `planctl_invocation` reader, schema
  column/trailer/envelope identifiers, vendored `plugins/plan/.planctl` prune,
  `.planctl`-keyed git-worker watch code.
- `git show -s 57ce45a5` ("docs sweep") — "Schema column names (`planctl_op`,
  `idx_events_planctl_*`), the `'planctl'` source-badge value, and `Planctl-Op`
  commit trailers are live wire/schema identifiers and stay unchanged."

The strip is the deliberate decision to now go after that residue. Everything on
those "stays" lists is in scope for the strip — *except* genuinely immutable
artifacts (see §3).

---

## 3. The hard constraints (the obstacles — read before designing)

Two of these genuinely resist "make it all go away." Surface them to the human
early; they shape the whole approach.

### 3a. Re-fold determinism is sacred — and historical events carry the old name

A from-scratch re-fold must reproduce **byte-identical** projection rows
(`CLAUDE.md` "Event-sourcing invariants"). The live DB currently holds (measured):

- **~9,513 events** with a `planctl_invocation` envelope in their `data` payload.
- **~4,535 events** with `planctl_op` non-null (the sparse columns).

If you simply *delete* the legacy read path (`planctl_invocation`, `planctl_*`
columns), re-folding those historical events produces different rows → determinism
breaks and plan attributions vanish. **The only way the legacy read path truly
goes away is to rewrite the historical event data itself** (the `events.data`
envelopes + the `planctl_*` column values → `plan_*`), so that after migration no
event carries the old name and the steady-state fold code can be single-path.
After the rewrite, re-fold (from the rewritten events) stays byte-identical. This
is the "heavy lifting" the human anticipated. Precedent exists and is proven —
see §4.

This byte-identical determinism is scoped to the **deterministic-replayed**
projection class. The git surface (`git_status`/`file_attributions`/the three
`jobs` git-counters) is now a **live-only** projection (fn-868, v79): it is
boot-seeded + kept current above a skip-floor, never replayed from history, and
DELIBERATELY excluded from the byte-identical charter via the central
`LIVE_ONLY_PROJECTIONS` registry. So the cursor-rewind-and-redrain this rewrite
demands (§3c) no longer drags the catastrophic O(history)-per-event git replay
(the ~6-day fn-856 incident) — a rewind RESETS the git floor + re-seeds rather
than replaying the surface. The rewind cost is now bounded by the deterministic
projections alone.

### 3b. Commit trailers live in immutable git history — the reader can't fully drop them

The git-worker scrapes `Planctl-Op:` / `Planctl-Target:` from **live `git log`**
via `%(trailers:key=Planctl-Op,…)` (`src/git-worker.ts:962-963`) across every
watched repo. Those commit messages are already written and pushed; rewriting them
means rehashing history (impossible across the subtree and every other repo).

So: the **emit** side renames freely (`plugins/plan/src/commit.ts:201-202` →
`Plan-Op:` / `Plan-Target:`; passthrough regex at `cli/commit-work.ts:72`), but
the **reader** must keep parsing the old spelling forever, or you lose every
historical commit-trailer attribution (data loss + another re-fold break). This is
the single place where backward-facing support cannot die — a cheap, permanent,
justified dual-parse (read both `Plan-Op` and `Planctl-Op`; emit only `Plan-Op`).

### 3c. The events table is canonical but not immutable

`events` is the canonical fold source. Rewriting it is serious — but there's
precedent that it's allowed for migrations: the steady-state retention pass already
NULLs shed-class bodies (`src/compaction.ts`), and fn-831 already rewrote stored
`source` values. The rewrite migration must be version-guarded, idempotent on
re-run, and pair with a **cursor rewind + redrain** so projections re-attribute
from the rewritten events (the established pattern — `src/db.ts:3070` for the
fn-666 `.planctl` orphan re-attribute, and fn-831 below).

---

## 4. The proven precedent — fn-831 is your migration template

**You have already done a planctl→plan data rewrite once, successfully.** fn-831
(schema v74→v75) renamed the `file_attributions.source` badge `'planctl'` → `'plan'`:

```
src/db.ts:3720-3736   // v74→v75 (fn-831 .1): rewrite stored source='planctl' → 'plan'
                      // version-guarded; idempotent (re-run finds no 'planctl' rows);
                      // CHECK already widened to allow both; cursor rewind to re-attribute.
src/db.ts:1071        // current CHECK: source IN ('tool','bash','inferred','planctl','plan')
```

The column/envelope rewrite (§5 Problem A) is the same shape at larger scale:
1. Bump `SCHEMA_VERSION` (currently **76** at `src/db.ts:50`) → 77, and add 77 to
   `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` **in the same commit**
   (`test/schema-version.test.ts` enforces this).
2. Version-guarded migration step: `ALTER TABLE … RENAME COLUMN planctl_x TO plan_x`
   (SQLite supports it) or table rebuild; rename the partial indexes
   `idx_events_planctl_*` → `idx_events_plan_*`; rewrite `events.data` payloads
   `planctl_invocation` → `plan_invocation` (and any nested op/target/files keys).
3. Idempotent + cursor-rewind + redrain so projections re-fold from the rewritten
   events and stay byte-identical.
4. Flip all readers/writers to single-path `plan_*` and `plan_invocation`; rename
   the symbols; delete the legacy fallback.

---

## 5. The hard problems (each its own epic)

### Problem A — DB columns + envelope + event-log rewrite (the keystone)

**Surfaces:** columns `planctl_op`, `planctl_target`, `planctl_epic_id`,
`planctl_task_id`, `planctl_subject_present`, `planctl_queue_jump`, `planctl_files`
(in `events`, and check for any de-blobbed commit table — README references a
`commit_events`-style read path carrying `planctl_op`/`planctl_target`); indexes
`idx_events_planctl_session|epic|target`; the `planctl_invocation` envelope key;
the events-writer hook bindings (`plugins/keeper/plugin/hooks/events-writer.ts:555-565,
773-783` — column list + `$planctl_*` bind params).

**Constraints:** §3a (rewrite historical events), §3c (cursor rewind), the **hook
rules** (the events-writer must stay exit-0, no `bun:sqlite`/`db.ts` import, no
third-party deps — renaming its column/bind strings is fine, dragging in schema is
not), never-throw-in-fold, and `keeper/api.py` whitelist.

**Approach:** follow §4. This is the heavy lift; it's an `xhigh`/`max` epic with a
careful migration, a re-fold-equivalence proof (`test/refold-equivalence.test.ts`
is the determinism charter — extend it), and `bun run test:full`.

### Problem B — commit trailers

**Emit side (rename freely):** `plugins/plan/src/commit.ts:201-202`
(`Planctl-Op:`/`Planctl-Target:`), the trailer-passthrough regex
`cli/commit-work.ts:72`, and any `Planctl-Prev-Op:` emit. → `Plan-Op:` etc.

**Read side (permanent dual-parse — §3b):** `src/git-worker.ts:947-996` (the
`%(trailers:key=…)` format string + the 8-field NUL parser) must read BOTH
`Plan-Op`/`Planctl-Op` and `Plan-Target`/`Planctl-Target`. The durable
commit-event data in `events` gets rewritten by Problem A's migration; only the
*live git-log re-scrape* needs the permanent dual-read.

**Decision:** confirm with the human that a thin permanent reader dual-parse is
acceptable (recommended) vs. accepting historical-commit attribution loss.

### Problem C — subtree de-vendor ("kill the subtree")

**What `plugins/plan/` actually is:** the entire plan plugin — it carries the
`plan:*` skills (`close defer hack next plan work`), `plugins/plan/src/cli.ts` (the
`keeper plan` CLI that `cli/plan.ts:22` imports), and `plugins/plan/src/state_path.ts`
(`DATA_DIR_NAMES` source of truth). It is a `git subtree` (`git subtree --prefix=plugins/plan`;
subtree-add commit `e6c8f01e` from upstream `2a508b80`).

**"Kill it" = de-vendor, NOT delete.** Deleting it removes `/plan:plan`,
`/plan:work`, `/plan:close`, `/plan:hack`, and `keeper plan`. The coherent reading
is: drop the `git subtree` linkage and its "never squash / extractable to a
standalone repo" discipline, and absorb `plugins/plan/` as ordinary native keeper
source. The directory **stays** where it is (agentwrap loads it as a plugin from
`plugins/`); it just stops being a subtree. This finally completes "we moved
planctl into this project."

**Steps:**
- Delete `plugins/plan/.planctl/` — the subtree's *own* dev-plan history (287
  files; *another project's* history, not keeper's). This is the one "historical"
  dir to delete rather than preserve.
- Remove the subtree constraints from `CLAUDE.md` (the "never `--squash`, never
  rebase its merge commit" block) and the `git-subtree-split` discipline.
- Once `plugins/plan/` no longer has its own `.planctl`/`.keeper` dev plan, the
  vendored-prune special-casing (`isVendoredPlanPath` in `src/plan-worker.ts:455-467`,
  the prune in `isPlanctlChangedPath`) can likely be **deleted** — verify nothing
  else relies on it.
- Decide: keep `plugins/plan/src/cli.ts` in place (simplest), or relocate the CLI
  into keeper's `cli/`/`src/`. Recommend keep-in-place.

**Note:** this problem is mechanically the most independent (no schema, no
re-fold) — a reasonable *first* phase that clears constraints and simplifies the
prune code the other problems brush against.

### Problem D — collapse the dual-path scaffolding (the finish)

After A–C land, delete the transition scaffolds: the `planctl-commit-changed` wire
kind + the daemon's dual handler (`src/daemon.ts:2484-2486`), the
`plan_invocation ?? planctl_invocation` fallback, any remaining `.planctl || .keeper`
recognition (fn-855 already makes git-worker `.keeper`-only), and the now-dead
legacy-envelope tests (`test/events-writer.test.ts:792-836`). Keep only the §3b
commit-trailer reader dual-parse — that one is permanent.

---

## 6. Open decisions (carried from the originating conversation; defaults recommended)

1. **Subtree:** de-vendor in place (keep code, drop the subtree discipline) — **default yes** (only non-catastrophic reading).
2. **Event-log rewrite:** rewrite the ~9.5k historical events + ~4.5k column rows so steady-state code is single-path `plan_*` — **default yes** (the only way to drop the legacy read path without breaking re-fold).
3. **Commit-trailer reader:** keep a thin permanent dual-parse (emit `Plan-Op:`, still read `Planctl-Op:`) — **default yes** (immutable history; the alternative is data loss).
4. **`plugins/plan/.planctl/` dev-plan history:** delete on de-vendor — **default delete** (it's the vendored dependency's history, not keeper's).
5. **New names:** `plan_*` columns / `plan_invocation` / `Plan-Op:`/`Plan-Target:` / `idx_events_plan_*` — **default yes** (`plan_` is already the half-flipped spelling, and the `'plan'` source badge precedent).

---

## 7. Suggested phasing & how to collaborate

**Run `/arthack:panel` on the migration strategy before scaffolding Problem A.** An
event-log-rewriting migration with re-fold-determinism stakes is exactly the
high-stakes design call the panel is for: feed it the raw question (rewrite-vs-dual-read,
trailer reader-compat, cursor-rewind sequencing) plus §3/§4 as neutral evidence —
not a pre-baked answer.

**Suggested order (each its own epic; confirm with the human):**
1. **Problem C (subtree de-vendor)** — mechanically independent, clears constraints
   and lets you simplify the vendored-prune code the rest touches.
2. **Problem A (DB columns + envelope rewrite)** — the keystone; panel first.
3. **Problem B (trailer emit-flip + reader dual-parse)** — small, after A's
   durable-data rewrite lands.
4. **Problem D (collapse dual-path scaffolds)** — the cleanup that makes "most of
   it go away" finally visible.

**Verify, don't assume:** before each phase, reproduce the current behavior and
re-measure the live counts (the `~9.5k/~4.5k` numbers drift). Confirm whether a
`commit_events`-style de-blobbed table exists and carries `planctl_*`.

**Never touch:** `.keeper/specs/` plan history (immutable by the human's rule),
already-written git commit messages (§3b), and re-fold-read values without the
rewrite migration (§3a).

**Resolve decisions with the human one at a time** (the §6 list), each with the
tradeoff spelled out — don't self-answer the load-bearing ones (rewrite scope,
trailer compat). Then scaffold warm.

---

## 8. What's already handled — epic `fn-855`

The *forward-facing slice* (the decided/safe part) is planned separately as epic
**`fn-855-complete-planctl-command-and-directory`** (`keeper plan cat
fn-855-complete-planctl-command-and-directory`):

- `.1` fix the broken `keeper:await` `planctl show` → `keeper plan show`
- `.2` git-worker `.keeper` reconciliation (a latent-correctness fix; makes
  git-worker `.keeper`-only, mirroring plan-worker) + the 4th-shape lockstep fix
- `.3` forward-facing `planctl` command prose sweep (conservative — leaves all the
  §2 residue)
- `.4` modernize stale `.planctl/` test fixture paths

fn-855 deliberately does **not** touch columns, trailers, the subtree, or the
dual-path scaffolds — those are this document's Problems A–D. The strip starts from
fn-855's end state.

---

## 9. Quick reference — key files & recon recipes

```
src/db.ts:50                       SCHEMA_VERSION (currently 76)
src/db.ts:1071, 3720-3736          fn-831 source-rewrite precedent (your template)
src/derivers.ts:485                plan_invocation ?? planctl_invocation (dual-read)
src/reducer.ts:5234,5245,5271-5322 envelope read + mintPlanctlFileAttributions
src/git-worker.ts:947-996          commit-trailer scrape (the permanent dual-read site)
plugins/plan/src/commit.ts:201-202 trailer EMIT site (rename freely)
cli/commit-work.ts:72              trailer passthrough regex
plugins/keeper/plugin/hooks/events-writer.ts:555-565,773-783  hook column list + binds
keeper/api.py                      SUPPORTED_SCHEMA_VERSIONS whitelist
test/refold-equivalence.test.ts    re-fold determinism charter (extend it)
plugins/plan/                      the subtree (de-vendor target)
```

```bash
# Live counts (drift over time — re-measure per phase):
sqlite3 -readonly ~/.local/state/keeper/keeper.db \
  "SELECT count(*) FROM events WHERE COALESCE(data,'') LIKE '%planctl_invocation%'"
sqlite3 -readonly ~/.local/state/keeper/keeper.db \
  "SELECT count(*) FROM events WHERE planctl_op IS NOT NULL"

# The scope contract:
git show -s 398b0183 && git show -s 57ce45a5

# Remaining planctl, excluding immutable historical artifacts:
rg -n 'planctl' --glob '!.keeper/specs/**' --glob '!plugins/plan/.planctl/**'
```
