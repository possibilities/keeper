## Description

**Size:** M
**Files:** src/store.ts, src/models.ts, src/ids.ts, src/verbs/detect.ts, src/verbs/status.ts, src/verbs/epics.ts, test/*.test.ts additions

### Approach

Port the remaining spine against the Python sources as spec, then the three verbs. store.ts: loadJsonSafe (null on missing or corrupt — never throw), the state-store read paths including the runtime overlay (.planctl/state/tasks/<id>.state.json) with the read-never-creates contract (reading must not create files or dirty the tree); nowIso honoring the PLANCTL_NOW contract (validate by exact shape, return the override AS-IS without any Date round-trip; wall clock = toISOString padded to a 6-digit fractional field) and getActor (PLANCTL_ACTOR → git config user.email → user.name → USER → unknown) — both land as spine utilities with bun:test units pinning the contracts even though these verbs never stamp. models.ts: normalizeEpic/normalizeTask/mergeTaskState (absent runtime → status todo). ids.ts: parseId with the unparseable-sorts-as-999 behavior epics relies on. Verbs: detect (found-false bare envelope, no hard error, schema_version default 0), status (resolve_project hard-error path, epic/task glob semantics — epics/<eid>.json and tasks/<eid>.M.json — schema_version default 1; the 0/1 asymmetry with detect is intentional, do not unify), epics (parse_id ordering plus the human text renderer matching run_epics.py's _render_human exactly — this is the only --format human surface in the epic).

### Investigation targets

**Required** (read before coding):
- planctl/store.py:125-295 — load_json_safe, LocalFileStateStore read paths, get_actor, now_iso + PLANCTL_NOW
- planctl/models.py — normalize_epic/normalize_task/merge_task_state
- planctl/ids.py:56-80 — parse_id and the sort fallback
- planctl/run_detect.py, run_status.py, run_epics.py — the three verbs incl. _render_human
- tests/test_readonly_verbs.py — the pins these verbs must satisfy (yaml/human/non-ASCII/trailer)

**Optional** (reference as needed):
- tests/test_now_iso_contract.py — the PLANCTL_NOW contract spec (its unit tests are the authority on accepted/rejected shapes)
- src/ from the prior task — established patterns; do not fork emitter conventions

### Risks

The human renderer and yaml output are the two surfaces where small divergences (spacing, ordering, block-scalar style) fail byte pins — iterate against the task-1 expected strings, not against eyeballed output. Glob/sort determinism must match Python (sorted, locale-independent).

### Test notes

Exit: full tests/test_readonly_verbs.py green against dist/planctl-bun; bun test units for store/models/ids/nowIso/getActor green; Python fast gate untouched.

## Acceptance

- [ ] detect/status/epics implemented; all tests in tests/test_readonly_verbs.py green via the compiled binary
- [ ] nowIso + getActor land with contract-pinning bun:test units (PLANCTL_NOW returned verbatim, malformed rejected, 6-digit wall-clock field)
- [ ] Runtime-overlay reads never create files; schema_version asymmetry preserved
- [ ] biome/tsc/bun test green; no Python file touched

## Done summary
Ported the store/models/ids spine (loadJsonSafe, read-never-creates runtime overlay, nowIso/getActor contracts, normalize/merge, parseId) and the detect/status/epics read-only verbs to planctl-bun; the full tests/test_readonly_verbs.py is green against the compiled binary, with bun:test units pinning nowIso/getActor and the schema_version 0/1 asymmetry preserved.
## Evidence
