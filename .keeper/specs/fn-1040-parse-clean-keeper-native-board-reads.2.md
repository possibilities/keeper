## Description

**Size:** S
**Files:** plugins/plan/src/verbs/list.ts, plugins/plan/src/verbs/tasks.ts, plugins/plan/src/format.ts (JSON data only)

### Approach

`keeper plan list` and `keeper plan tasks` return the whole board unbounded
(454 epics / 995 tasks today), overflowing an agent's tool-output buffer. Add a
default cap of 50 plus `--limit N` / `--offset N`, and wrap the JSON envelope with
`{total, returned, truncated, hint}` — the truncation fields live in the JSON
`data` ONLY (the `--format human` render is golden-pinned byte-for-byte,
`list_human.txt`, and must not change). Append the new keys (field order is a wire
contract).

Cap unit + total semantics, pinned:
- **`list`** is an epic→tasks tree — the cap counts **epics** (top-level rows);
  `total` = number of epics in scope; each capped epic's nested tasks render
  inline (bounded by epic size). `list` has no `--epic`/`--status` filters, so its
  `hint` points at `--limit`/`--offset` or `keeper query epics`.
- **`tasks`** caps **tasks**; `total` = count of the **filtered** set (after
  `--epic`/`--status`). `tasks` already loads every row and computes status
  post-merge to sort (`tasks.ts:55-68`), so the filtered count is free — do NOT
  use a raw directory count (it is wrong under `--status`). The cap applies AFTER
  filter+sort so `truncated`/`total` are meaningful; `hint` names `--epic`/`--status`
  and `--limit`/`--offset`.

Envelope + paging semantics, pinned:
- `{total, returned, truncated, hint}` are ALWAYS present — un-capped results carry
  `truncated:false` and `hint:null` so agents can rely on the keys.
- `--offset` past `total` → `returned:0`, `truncated:false` (definite terminal
  signal for a paging agent).
- `--limit 0` / negative / non-numeric → CLI misuse, exit 2 with a clear message
  (mirror the `keeper board --timeout` validation pattern); do NOT silently treat
  as "no cap".
- The pre-cap sort must be fully deterministic so `--offset` paging is stable: add
  a secondary tiebreaker on the id string for the unparseable-id bucket (currently
  all keyed 999 with no tiebreaker, relying on `readdirSync` order — `list.ts:69/93`,
  `tasks.ts:59-68`).

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/verbs/list.ts:51-112 (build→sort→formatOutput; :69/:73-106/:93 sort + tree nesting) — no cap today
- plugins/plan/src/verbs/tasks.ts:29-86 (:55-68 status-merge + sort) — `--epic`/`--status` filters already exist
- plugins/plan/src/format.ts — `formatOutput(data, format, humanRenderer)`; add fields to JSON data, leave the human renderer callback alone

**Optional** (reference as needed):
- plugins/plan/test/verbs-query.test.ts:358 — the `list_human.txt` golden assertion
- cli/board.ts `--timeout` validation — the exit-2 CLI-misuse pattern to mirror for bad `--limit`/`--offset`

### Risks

- `tasks` `total` under `--status` MUST be the post-filter count, not a directory count — the status is only known after loading + merging runtime.
- Golden human render is byte-pinned — keep truncation in the JSON envelope only.
- Output must remain a single JSON value so the task-1 conformance guard passes for list/tasks.
- A default cap can silently starve an internal consumer (epic-scout runs `keeper plan tasks --epic <id>`); the always-present `truncated`/`hint` fields make the cap detectable and the `hint` points at how to page or raise the limit.

### Test notes

Assert: a board past the cap returns `truncated:true`, `returned < total`, populated
`hint`; un-capped returns `truncated:false`, `hint:null`, all keys present;
`--limit`/`--offset` page deterministically (stable across repeated calls);
`--offset` past `total` → `returned:0, truncated:false`; `--limit 0`/negative/
non-numeric → exit 2; `list` cap counts epics, `tasks` cap counts filtered tasks;
`--format human` byte-unchanged (golden passes); output is one JSON value.

## Acceptance

- [ ] `keeper plan list` caps at 50 **epics** (`total` = epic count) and `keeper plan tasks` caps at 50 **tasks** (`total` = count of the `--epic`/`--status`-filtered set, computed post-filter — never a raw directory count), each wrapping JSON with `{total, returned, truncated, hint}`.
- [ ] The `{total, returned, truncated, hint}` keys are ALWAYS present; un-capped output carries `truncated:false`, `hint:null`.
- [ ] `--limit N` / `--offset N` page deterministically (stable secondary sort tiebreaker); `--offset` past `total` → `returned:0, truncated:false`; `--limit 0`/negative/non-numeric → exit 2 with a clear message.
- [ ] `hint` names the right narrowing/paging levers per verb (`list` → `--limit`/`--offset` or `keeper query epics`; `tasks` → `--epic`/`--status` + `--limit`/`--offset`).
- [ ] `--format human` output is byte-unchanged (golden `list_human.txt` still passes).
- [ ] Output stays a single top-level JSON value (task-1 conformance guard passes for list/tasks).

## Done summary

## Evidence
