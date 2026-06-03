# Cross-Project Epic Dependencies

**Status:** Authoritative
**Applies to:** planctl CLI v1 (fn-600 and later)

This memo is the single source of truth for planctl's cross-project epic-dep
contract. Other docs that describe `depends_on_epics` semantics defer here.

Before fn-600 the epic-level `depends_on_epics` field worked only within the
parent epic's own project — every dep-id lookup was scoped to the current
project's `.planctl/`. fn-600 rewires every dep-id lookup site (existence
checks, cycle detection, the readiness gate, audit source-link derivation) to
a cwd-then-global resolver so an epic in project B can declare a hard dep on
an epic in project A. The runtime semantics inherit the existing same-project
hard-gate contract: a task in project B is not workable until its declared
cross-project dep epic reaches runtime `complete`.

---

## 1. Resolver Model: cwd-first-then-global

Every dep-id lookup flows through `planctl.discovery.resolve_epic_globally`
(`apps/planctl/planctl/discovery.py`). Resolution order:

1. **Cwd short-circuit.** If the current working directory is a planctl
   project AND its `.planctl/epics/<epic_id>.json` exists, the resolver
   returns that path immediately. This is the common hot path (the dep lives
   in the parent epic's own project) and also the path that preserves
   single-repo workflows with no `roots` configured.
2. **Roots discovery.** Scan the configured `roots` (parent directories of
   project roots) via `discover_projects`. Each immediate child carrying a
   `.planctl/` directory is a candidate. Filter to projects whose
   `.planctl/epics/<epic_id>.json` exists:
   - Exactly one match → **resolved**.
   - Zero matches → **not found** (dangling).
   - Two or more matches → **ambiguous** (`dep_ambiguous_id`; see §5).

The cwd-first short-circuit does NOT count toward the ambiguity check. If the
id resolves locally the global step is never consulted. Callers that need the
full multi-project view (e.g. the integrity restamp building the global
`all_epic_ids` set) use `scan_epic_ids_global` directly instead of
`resolve_epic_globally`.

Resolution is **fail-soft on the roots step**: an unconfigured / unreadable /
empty discovery yields zero candidates, equivalent to "not found". The cwd
short-circuit still works in that degraded case (a single-repo project with no
`roots` at all keeps working unchanged — the most common configuration).

---

## 2. `roots` Config Dependency

Cross-project resolution **requires `roots` to be configured** in
`~/.config/planctl/config.yaml` (or wherever `planctl.config.load_roots`
sources it from). Without `roots`:

- The cwd short-circuit still works — same-project deps resolve as before.
- Cross-project deps cannot be resolved — they surface as
  `blocked_dangling` (see §4) at readiness-gate time, and as
  `epic_not_found` at write time (`epic add-dep` / `epic add-deps` /
  `scaffold` / `refine-apply`).

This is a single-repo escape hatch by design: a project with no `roots`
configured behaves exactly the same as a pre-fn-600 planctl install — no
regression, no new error surface. Cross-project deps only become available
once the human opts in by listing the parent directories of their planctl
projects in `roots`.

---

## 3. Hard-Gate Semantics

Cross-project deps inherit the **existing same-project hard-gate contract**.
A task in project B is not workable — never surfaces in `planctl ready` —
until every dep epic listed in its parent epic's `depends_on_epics`
reaches runtime `complete` (epic status `done` AND every task in the dep
epic has `RuntimeStatus == "complete"`).

The gate runs inside
`planctl.global_state::_compute_action_items_for_renderer`. The same code
path classifies both same-project and cross-project deps:

1. **Same-project lookup** via `epic_status[(proj, dep_id)]` — the common
   hot path, unchanged from pre-fn-600.
2. **Cross-project fallback overlay** via `dep_epic_by_id[dep_id]` — keyed by
   bare `fn-N` (no project prefix; see §6 for the syntax decision). Built in
   the same single pass as `dep_epic_lookup`.

`_dep_status` returns one of `done` / `pending` / `dangling` per dep id.
`done` clears the gate; `pending` and `dangling` both hold the epic in the
`blocked_epics` map.

There is no soft-gate, no override flag, no bypass. Cross-project
deps that don't resolve are not actionable.

---

## 4. `blocked_dangling` vs `blocked_pending`

The readiness gate distinguishes two unmet-dep classes per blocked epic
(`apps/planctl/planctl/global_state.py`, `blocked_epics` dict shape):

- **`blocked_pending`** — the dep id resolved (same-project via
  `epic_status`, or cross-project via the `dep_epic_by_id` overlay) but the
  resolved dep epic is not yet runtime-complete. The work is real and live;
  the dep just hasn't finished yet. Renderers paint a `[blocked: <dep>]`
  pill.
- **`blocked_dangling`** — the dep id resolved nowhere. The dep epic was
  deleted, never minted, or lives in a project not configured under
  `roots`. Renderers paint a distinct `[dangling: <dep>]` pill so the human
  sees the difference at a glance.

Both lists are sorted and may be empty independently; an epic appears in
`blocked_epics` only when at least one of them is non-empty. Consumers
read both lists and surface the distinction however they render
(`[dangling: ...]` vs `[blocked: ...]`).

**Why the distinction matters.** Pulumi's `getOutput` vs `requireOutput`
split is the design template. Without the dangling/pending distinction a
missing upstream looks identical to an in-progress upstream — the silent
Terraform-style failure mode where deletes go unnoticed. The dangling pill
is the loud signal that the dep id no longer points anywhere; the human
either re-creates the dep epic or rewires the edge.

---

## 5. `dep_ambiguous_id` Error Envelope

`scan_epic_ids_global` carries a "last-walked wins" comment for human-readable
error messages in dup-detection paths. That semantics is **unsafe as a
resolver**: a dep id that exists in two projects must not silently pick a
winner. `resolve_epic_globally` reports `ambiguous` instead, and every write
site (`epic add-dep`, `epic add-deps`, `scaffold`, `refine-apply`) surfaces it
as the `dep_ambiguous_id` error code.

Envelope shape (from `apps/planctl/planctl/run_epic_add_deps.py`):

```json
{
  "success": false,
  "error": {
    "code": "dep_ambiguous_id",
    "message": "One or more dep ids resolve to multiple projects",
    "details": [
      "dep epic fn-7-shared exists in multiple projects: /path/to/projA, /path/to/projB"
    ]
  }
}
```

Priority order at write time (stable, collect-all-errors):
`bad_id` → `dep_ambiguous_id` → `epic_not_found` → `dep_done` → `dep_cycle`.
A malformed id is the most basic shape failure; ambiguity is a graph-level
error class (the id exists, but the resolver refuses to silently pick); not-
found is the weakest classifier (the id exists nowhere).

`--skip-invalid` on `epic add-deps` routes the per-edge ambiguous case into
the success envelope's `results` array as `SKIPPED_AMBIGUOUS` instead of
failing the whole call (symmetric with the other `SKIPPED_*` classifiers).

The readiness gate at runtime does NOT surface `dep_ambiguous_id` — by the
time bundles materialize, `_check_global_name_unique` (the post-fix
invariant) has already prevented new dups, and the cross-project overlay
walks projects in a stable order so a residual legacy dup falls back to
"last-walked wins" only at the gate (the write-side gate is the authoritative
defender; the runtime gate is best-effort).

---

## 6. Bare `fn-N` Syntax Decision

`depends_on_epics` entries are bare `fn-N-slug` ids — never the qualified
`<project>::<epic_id>` form keeperd uses for its internal plans pool key.

Justification: epic ids are **globally unique across all projects** under the
`_find_foreign_owner` invariant (`apps/planctl/planctl/run_epic_create.py`).
`epic create` consults the global id index before minting a fresh `fn-N` and
refuses to mint over an id already owned by another project. The post-write
integrity gate (`_check_global_name_unique`, fn-600 task .2) re-enforces the
invariant at every restamp boundary. Together they make the bare `fn-N`
syntax safe: there is at most one project that can own a given id.

A future regression could in principle introduce a dup state (legacy data, a
manual JSON edit that bypasses the verb path, a botched merge across two
projects). The `dep_ambiguous_id` envelope (§5) is the loud failure for that
case — the resolver refuses to silently pick a winner, the human reconciles
by renaming one of the dup epics.

The bare syntax keeps `depends_on_epics` portable: a dep edge written in
project B does not encode project B's filesystem layout (`/Users/<x>/code/projB`
absolute path, or even `projB`'s slug). Move the project, rename its parent
directory, re-clone it on another host — the edge keeps resolving as long as
the dep epic is discoverable under some configured root.

---

## 7. Stale-Dep Semantics

What happens when project A deletes a dep epic that project B's open epic
still references? The edge stays on disk in project B's
`epics/<projB-epic>.json` but the resolver returns "not found" for the now-
missing id.

- **At readiness-gate time**: the dep classifies as `dangling`. Project B's
  task is held out of `planctl ready` and consumers can paint a
  `[dangling: <dep>]` pill. Loud signal — the human sees that the
  upstream is gone.
- **At the next restamp on project B**: the post-write integrity check
  catches the dangling ref. The 14 restamp verbs in
  `planctl.validation_restamp.VALIDATION_RESTAMP_VERBS` all run the
  cross-project existence check via `resolve_epic_globally`; a dangling
  ref surfaces as a structural error and the restamp fails. The human
  reconciles by either rewiring the edge (`epic rm-dep <projB-epic>
  <missing-id>`) or restoring the deleted upstream.
- **At consumer render time**: the `[dangling: ...]` pill is the live
  signal between the deletion and the next restamp — best-effort
  visibility for the human; the structural gate is the enforcement.

This matches Nx's eager `dependsOn` graph-construction failure shape: lazy
detection at workable-task derivation alone means dangling deps go
unnoticed until they would have mattered. Restamp catches them eagerly the
moment the dependent project's epic is next touched structurally.

---

## 8. Single-Repo Workflows (No `roots` Configured)

Single-repo projects with no `roots` configured keep working unchanged:

- `epic add-dep` / `epic add-deps` / `scaffold` / `refine-apply` resolve
  dep ids via the cwd short-circuit only — same behavior as pre-fn-600.
- The readiness gate classifies every dep against the same-project map; the
  cross-project overlay is empty (zero discovered projects).
- `dep_ambiguous_id` cannot fire — only one project's epic ids are in
  scope.

No new error surface for single-repo. The contract above is a strict
superset; the cross-project paths are additive.

---

## 9. Pointers

- Resolver: `apps/planctl/planctl/discovery.py::resolve_epic_globally`
- Readiness gate: `apps/planctl/planctl/global_state.py` (`_dep_status`,
  `blocked_epics`)
- Write-side validation: `apps/planctl/planctl/run_epic_add_deps.py`,
  `run_epic_add_dep.py`, `run_scaffold.py`, `run_refine_apply.py`
- Global id index: `apps/planctl/planctl/ids.py::scan_epic_ids_global`
- Global uniqueness invariant:
  `apps/planctl/planctl/run_epic_create.py::_find_foreign_owner` and
  `_check_global_name_unique`
- Commit contract: `docs/reference/commit-at-mutation-boundary.md` (every
  cross-project write still auto-commits its own scope inline at
  `emit()`; cross-project deps don't change the commit model)
