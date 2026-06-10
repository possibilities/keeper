## Description

**Size:** S
**Files:** planctl/discovery.py, planctl/run_epic_add_deps.py, tests/test_cross_project_epic_deps.py, tests/test_epic_add_deps.py

### Approach

Teach `resolve_epic_globally` / `find_projects_with_epic`
(planctl/discovery.py) to resolve a number-only `fn-N` id: extract the
integer via `parse_id` (planctl/ids.py:56) and match epics whose parsed
`epic_num` equals it exactly — never string-prefix matching. Within one
project the number is unique by construction; a cross-project collision
flows into the existing `ResolveResult.owners`/`ambiguous` channel
(surfaced as `SKIPPED_AMBIGUOUS` / `dep_ambiguous_id` — no new codes). The
resolver returns the full slug id/path; the dep-writing path persists the
FULL slug into `depends_on_epics` (normalize-on-write) so the readiness
gate in planctl/global_state.py, which keys by full id, never sees a
number-only edge. The resolver-level fix covers all four write-side
callers (add-dep, add-deps, scaffold, refine-apply) uniformly. If
docs/reference/cross-project-epic-deps.md §6 wording is touched, state the
present-tense rule only.

### Investigation targets

**Required** (read before coding):
- planctl/discovery.py:60-134 — resolve_epic_globally, exact-filename match sites (:100, :129), ambiguity check (:123-134)
- planctl/discovery.py:157-171 — find_projects_with_epic
- planctl/run_epic_add_deps.py:119-159 — the assert-all loop and SKIPPED_* routing; persist/normalize point near :273-292
- planctl/ids.py:11-13,56,114-142 — ID_REGEX (fn-N is already shape-valid), parse_id, scan_epic_ids_global

**Optional** (reference as needed):
- planctl/global_state.py:129-201 — readiness gate keyed by full id (why normalize-on-write matters)
- tests/test_cross_project_epic_deps.py:173-263,402 — resolver unit tests + the SKIPPED_* integration shape to mirror
- tests/conftest.py:687-703 — autouse roots isolation; a multi-project number-only test needs @pytest.mark.real_roots; same-project tests run under the plain `project` fixture

## Acceptance

- [ ] Number-only `fn-N` resolves to the unique matching epic via exact integer equality; `fn-1` does not match `fn-10`
- [ ] Persisted `depends_on_epics` entries are always full slug ids after a number-only wire
- [ ] Cross-project same-number collision surfaces as ambiguous (SKIPPED_AMBIGUOUS under --skip-invalid), never a silent pick
- [ ] Regression tests cover: same-project number-only wire through `epic add-deps`, the fn-1/fn-10 prefix trap, and the cross-project collision (marked real_roots)
- [ ] `uv run pytest tests/` passes

## Done summary

## Evidence
