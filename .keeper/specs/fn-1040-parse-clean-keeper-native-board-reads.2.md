## Description

**Size:** S
**Files:** plugins/plan/src/verbs/list.ts, plugins/plan/src/verbs/tasks.ts, plugins/plan/src/format.ts (JSON data only)

### Approach

`keeper plan list` and `keeper plan tasks` return the whole board unbounded
(454 epics / 995 tasks today), which overflows/truncates an agent's tool-output
buffer mid-string. Add a default cap (50) and wrap the JSON envelope with
`{total, returned, truncated, hint}` — `total` is a cheap directory count so
include it; `hint` names how to narrow/page (e.g. "filter with --epic/--status
or page with --limit/--offset"). Add `--limit N` / `--offset N` flags for paging.
The truncation fields live in the JSON `data` ONLY — the human render
(`--format human`) is golden-pinned byte-for-byte (`list_human.txt`) and must
not change. Append the new keys (field order is a wire contract).

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/verbs/list.ts:51-112 — build → sort → formatOutput; no cap today
- plugins/plan/src/verbs/tasks.ts:29-86 — same shape; has `--epic`/`--status` filters already
- plugins/plan/src/format.ts — `formatOutput(data, format, humanRenderer)`; add fields to JSON data, leave the human renderer callback alone

**Optional** (reference as needed):
- plugins/plan/test/verbs-query.test.ts:358 — the `list_human.txt` golden assertion

### Risks

- Golden human render is byte-pinned — any change to the human path forces a fixture update and is out of scope; keep truncation in the JSON envelope only.
- Must remain a single JSON value so the task-1 conformance guard still passes for list/tasks.

### Test notes

Assert: a board past the cap returns `truncated:true`, `returned < total`, and a
populated `hint`; `--limit`/`--offset` page correctly; `--format human` output is
byte-unchanged (golden passes); output is still one JSON value.

## Acceptance

- [ ] `keeper plan list` and `keeper plan tasks` cap at a default limit (50) and wrap JSON with `{total, returned, truncated, hint}`.
- [ ] `--limit N` / `--offset N` page the results; `hint` names how to narrow/page.
- [ ] `--format human` output is byte-unchanged (golden `list_human.txt` still passes).
- [ ] Output stays a single top-level JSON value (task-1 conformance guard passes for list/tasks).

## Done summary

## Evidence
