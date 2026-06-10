## Description

**Size:** S
**Files:** planctl/run_scaffold.py, planctl/run_close_finalize.py, planctl/models.py, tests/test_close_finalize.py, README.md, CLAUDE.md, docs/reference/planctl-bug-history.md

### Approach

Thread an internal-only provenance arg through the close saga's scaffold step,
then flip the discovery predicate. (1) `run_scaffold.run` reads
`getattr(args, "created_by_close_of", None)` (same defensive pattern as
`allow_duplicate` at run_scaffold.py:479-485) and, when set, adds the key to the
in-memory `epic_def` dict (assembled ~run_scaffold.py:1136-1164, inside
`_epic_id_lock`, before the integrity gate at :1252 and `atomic_write_json` at
:1284) — the stamp rides the same atomic write as the epic itself. The CLI
`scaffold_cmd` (cli.py:521) gains NO flag; YAML validators learn NOTHING (a
hand-authored followup.yaml must not be able to spoof provenance). (2)
`_scaffold_followup` (run_close_finalize.py:251) passes
`created_by_close_of=epic_id` in its SimpleNamespace. (3) `_find_followup_epic`
(run_close_finalize.py:183) keeps `sorted(glob())` first-seen determinism and the
`actual_tasks` count, but its predicate becomes exactly
`ep_def.get("created_by_close_of") == source_epic_id` — drop the
`depends_on_epics` membership test entirely (not even as a sanity check; the
raw `load_json_safe` read does no type coercion, so a malformed stamp safely
fails equality and is skipped). Both call sites (:368 idempotent-replay, :443
adopt/partial) get the new behavior for free. (4) Default the field to None in
`normalize_epic` (models.py:47-119, the additive-field precedent — explicitly
NO SCHEMA_VERSION bump, matching `queue_jump`/`close_reason`). (5) Rewrite the
`_find_followup_epic` docstring present-tense (forward-only doc style — no
"ported from the retired verb" framing) and document the field as immutable
after mint. Docs: README:164 source-link sentence, CLAUDE.md:48 contract
sentence, bug-history incident entry.

Open question (verify, don't assume): confirm `_check_epic_tree`
(integrity.py) has no unknown-key rejection — reading the function shows
structural checks only, but verify the stamped `epic_def` passes the
pre-write gate before relying on it.

### Investigation targets

**Required** (read before coding):
- planctl/run_close_finalize.py:183-222 — `_find_followup_epic`: the predicate to flip; keep return shape `{epic_id, actual_tasks, depends_on_epics, status}` (consumers at :445/:462 need `actual_tasks`; `depends_on_epics` becomes incidental — keep, note it)
- planctl/run_close_finalize.py:251-299 — `_scaffold_followup`: the single SimpleNamespace call site to extend
- planctl/run_close_finalize.py:362-376 and :438-465 — the two discovery call sites (idempotent replay; adopt/partial); the `actual_tasks == expected_count` gate stays byte-identical
- planctl/run_scaffold.py:479-485 — `getattr` arg-read pattern to mirror
- planctl/run_scaffold.py:1136-1164, :1252, :1283-1295 — `epic_def` assembly, integrity gate, atomic write + unwind (proves the no-stampless-window invariant)
- planctl/models.py:47-119 — `normalize_epic` additive-default precedent (comments show the no-SCHEMA_VERSION-bump pattern)
- tests/test_close_finalize.py:299-380 — `test_crash_resume_adopts_scaffolded_followup` + `test_partial_followup_stops_without_close`: both pre-create a follow-up via `seed_epic` and hand-patch `depends_on_epics=[epic_id]`; these must now ALSO hand-patch `created_by_close_of=epic_id` (they model the closer's own crashed scaffold)

**Optional** (reference as needed):
- tests/conftest.py:592 — `seed_epic` helper (real-CLI scaffold, returns epic_id + task_ids)
- planctl/api.py:60-105 — `load_epic` normalizes via `merge_epic_state`; `_find_followup_epic` deliberately reads raw `load_json_safe`
- planctl/cli.py:521-524 — `scaffold_cmd`: must NOT change
- docs/reference/planctl-bug-history.md — incident-entry format to follow

### Risks

- The integrity gate or any normalize/scrub pass silently dropping the unknown key — verified unlikely (`normalize_epic` pops only three named dead keys; `_check_epic_tree` is structural), but the regression test seeding a stamped epic through a full scaffold→finalize round trip is the real guard
- Relaxing the count gate "because provenance matched" — explicitly forbidden; a stamped under-provisioned follow-up is a crashed mid-scaffold artifact and must stay `partial_followup`
- Scope creep into keeper: keeper's `created_by_closer_of` is job-lineage-derived and independent — zero keeper changes

### Test notes

All in tests/test_close_finalize.py (fast bucket, CliRunner in-process). New:
(a) the fn-13 regression — seed a source epic with surviving-findings artifacts
(`_seed_verdict` + `_seed_followup_yaml`), seed an unrelated open epic with
`depends_on_epics=[source]` and a DIFFERENT task count, NO stamp → finalize
must IGNORE it, scaffold the real follow-up, close the source,
return `closed_with_followup` with the freshly-minted `new_epic_id`;
(b) scaffold stamps: after the fresh closed_with_followup path, read the minted
follow-up epic JSON and assert `created_by_close_of == source`;
(c) plain `planctl scaffold` (CLI, no internal arg) mints epics WITHOUT the key
stamped to a value (absent or None both acceptable — assert it is not the source id).
Updated: crash-resume adopt + partial tests stamp their pre-created follow-ups.
Unchanged: `test_close_outcome_exhaustiveness` (outcomes don't change).
Gate: `uv run pytest tests/ -q` green.

## Acceptance

- [ ] `_find_followup_epic` predicate is exact equality on `created_by_close_of`; no `depends_on_epics` consultation remains in the function
- [ ] Minted follow-up epic JSON carries `created_by_close_of: <source_epic_id>` written in the same atomic write as the epic; CLI scaffold path and YAML schema unchanged
- [ ] fn-13 regression test passes: pre-existing open dependent ignored, real follow-up scaffolded, source closed `closed_with_followup`
- [ ] Crash-resume adopt and partial_followup tests pass keyed on the stamp; count gate unchanged
- [ ] `normalize_epic` defaults the field (no SCHEMA_VERSION bump); full fast suite green
- [ ] README.md, CLAUDE.md, and planctl-bug-history.md updated per the epic Docs gaps

## Done summary

## Evidence
