## Description

**Size:** M
**Files:** scripts/autopilot.ts (new), README.md

### Approach

Clone `scripts/keeper-frames.ts` wholesale into `scripts/autopilot.ts`,
keeping every cross-cutting concern verbatim: the single reconnect loop
with capped backoff (`connectWithRetry`/`connectOnce`), the steady poll
(`POLL_MS`) + refetch coalescing (`queryInFlight`/`refetchDirty`/`scheduleRefetch`),
the `emitFrameIfChanged` byte-compare-on-rendered-body contract, the per-pid
`/tmp` sidecars (`writeSidecars`), the per-connection `LineBuffer`, the sticky
`gotResult` + `lastBody=null`-on-teardown reprint behavior, the terminal-error
guard, and the SIGINT clean-unsubscribe. Honor the read-only fence: only
`query`/`unsubscribe` are ever sent.

Then make exactly three behavioral changes:
1. **Hardcode the collection to `epics`** (`pk = "epic_id"` constant). Drop
   `PK_BY_COLLECTION`, the jobs `?? "job_id"` fallback, the `--collection`
   flag, and the `--state`/`--state-ne` jobs-only flags. Keep `--sock`,
   `--status`/`--status-ne` (epic-scope override), and `--help`. Send NO
   `filter` key when no status flag is passed (the `{}` spread path, not
   `filter: {}`) so the server's `defaultFilter {status:"open"}` applies and
   the page is the open-epic set.
2. **Replace the render layer.** Remove `projectRow` (jobs branch),
   `projectTask`, `renderEpicItem`, and the epics/jobs branching in
   `renderBody`. New `renderBody()` walks the epic page in server order and,
   for each epic, emits one line per task in `epic.tasks` (already sorted
   `(task_number, task_id)` by the reducer — no client re-sort). Guard
   `Array.isArray(row.tasks)`. One line = `- ${yamlScalar(line)}` where
   `line = "${repo} ${epicRef}.${seg(task.task_number)} ${seg(epic.title)} · ${seg(task.title)}"`.
   `repo = epic.project_dir == null ? "" : basename(String(epic.project_dir))`.
   `epicRef` is derived from `epic_id` via `/^(.+?-\d+)/` (e.g.
   `fn-5-live-subscribe-total-signal` → `fn-5`), falling back to
   `#${epic_number}` (then raw `epic_id`) when the regex misses. No
   `[status]` bracket on the line. Empty flat line set (no epics, or epics
   with zero tasks) renders `"[]"` exactly like the source.
3. **Retarget identity.** Rename every `keeper-frames` string literal — the
   file-header doc-comment, the `HELP` template, the `die()` prefix, the
   lifecycle/sidecar notes — to `autopilot`, and rename the sidecar paths to
   `/tmp/autopilot.${pid}.state.json` / `/tmp/autopilot.${pid}.frame.yaml`.
   Rewrite the header doc + `--help` text to describe the flat cross-epic
   task stream rather than the jobs/epics pager.

Finally, update **README.md**: correct the dual "No consumer ships yet"
claim (lines ~45 and ~184) to name both example scripts, and add a concise
`## Example clients` section listing `keeper-frames.ts` and `autopilot.ts`
with purpose + `bun scripts/<name>.ts` invocation. Optionally add a one-line
breadcrumb comment in both scripts noting the connection/coalescing logic
mirrors its sibling (extract a shared module if a 3rd client appears).

### Investigation targets

**Required** (read before coding):
- `scripts/keeper-frames.ts` — the entire clone source; the render block
  (~`projectRow`/`projectTask`/`renderEpicItem`/`renderBody`), the
  `parseArgs`/filter-build block, `yamlScalar`, `epicNumFromId`/`taskNumFromId`,
  and the sidecar/lifecycle string literals.
- `src/types.ts:104-143` — `Epic.tasks: Task[]` and `Task` shape; note
  `epic_number`/`task_number` are nullable.
- `src/server-worker.ts:275-302` — confirms unfiltered epics → `status:"open"`
  default scope; sort order.

**Optional** (reference as needed):
- `src/protocol.ts` — `encodeFrame`/`LineBuffer`/`QueryFrame`/`ServerFrame`/`FilterValue`.
- `src/db.ts` — `resolveSockPath()`.

### Risks

- **Empty-filter vs `filter:{}`**: the server default scope only applies when
  NO `filter` key is sent. Preserve keeper-frames' `{}`-spread shape (no key),
  not an explicit empty object, or the open-epic default is bypassed.
- **Byte-compare regression**: if any field that churns independently (e.g.
  task status) leaks into the line, frames will print on invisible churn.
  The line deliberately omits `[status]`.
- **Null `epic_number`/`task_number`**: both are nullable; `seg()`/the
  epicRef fallback must not emit `#null`/`.null`.

### Test notes

keeper-frames.ts ships untested and Biome lint is scoped to `src test` (not
`scripts`), so a test is not required for parity. Cheapest meaningful
coverage if desired: a pure-function test feeding sample `Epic[]` rows
(incl. an empty-tasks epic and a null-number epic) to the flat `renderBody`
and asserting the YAML lines + the `"[]"` empty case. Manual proof: run
`bun scripts/autopilot.ts` against a live keeperd and confirm the flat stream
format and that Ctrl-C unsubscribes cleanly.

## Acceptance

- [ ] `bun scripts/autopilot.ts` streams a flat one-line-per-task YAML doc
  across all open epics, format `- {repo} {epicRef}.{task_number} {epic title} · {task title}`, no `[status]`.
- [ ] `epicRef` renders as the `fn-N` epic-id prefix (e.g. `fn-5.1`), with a
  safe fallback when the regex misses; null task/epic numbers don't leak `null`.
- [ ] Empty page (no epics, or epics with no tasks) renders `[]`.
- [ ] No `--collection`/`--state` machinery remains; unfiltered query relies
  on the server's open-epic default scope; `--sock`/`--status`/`--help` work.
- [ ] All `keeper-frames` literals and `/tmp` sidecar paths are retargeted to
  `autopilot`; reconnect, poll/coalescing, byte-compare emit, and SIGINT
  unsubscribe behave as in the source.
- [ ] README's dual "No consumer ships yet" claim is corrected and an
  `## Example clients` section documents both scripts.

## Done summary
Cloned scripts/keeper-frames.ts → scripts/autopilot.ts with all plumbing preserved verbatim, hardcoded epics + flat one-line-per-task render (`{repo} {epicRef}.{task_number} {epic title} · {task title}`, no [status]), retargeted identity strings + /tmp sidecar paths, fixed README's dual 'No consumer ships yet' and added an ## Example clients section. Live run against keeperd confirmed the flat stream format.
## Evidence
