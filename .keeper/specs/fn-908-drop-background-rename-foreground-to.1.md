## Description

**Size:** M
**Files:** cli/setup-tmux.ts, src/dash/view-model.ts, cli/dispatch.ts,
README.md, plugins/keeper/skills/dispatch/SKILL.md,
test/setup-tmux.test.ts, test/keeper-cli.test.ts,
test/dash-view-model.test.ts, test/restore-agents.test.ts,
test/restore-set.test.ts, test/exec-backend.test.ts, test/dash-app.test.ts

### Approach

Keeper provisions three tmux work sessions today (`autopilot`,
`background`, `foreground`); collapse them to two (`autopilot`, `work`) by
dropping `background` entirely and renaming `foreground` → `work`. This is
a SITE-TARGETED rename of the session-name string in exactly three
production constants plus their docstrings, docs, and the tests that
assert on them — NOT a global find-replace.

The three production constant sites (the complete set; `RESTORABLE` and
`ALL_SESSIONS` derive from `WORK_SESSIONS`, so they update automatically —
only their comments need refreshing):
- `cli/setup-tmux.ts` `WORK_SESSIONS` → `[MANAGED_EXEC_SESSION, "work"]`
  (drop `"background"`, rename `"foreground"`→`"work"`).
- `src/dash/view-model.ts` `SESSION_PRIORITY` → `["work", "autopilot"]`.
  Keep `"autopilot"` as the raw string literal it already is — do NOT swap
  it to `MANAGED_EXEC_SESSION` (out of scope).
- `cli/dispatch.ts` `FALLBACK_SESSION` → `"work"`, AND the help-string at
  ~:136 spelling the precedence "...> $TMUX current > foreground".

Refresh every docstring/comment in the SESSION-NAME sense and the
four→three cardinality: setup-tmux header + `HELP` ("all four"→"all
three", "three work sessions"→"two work sessions", "(`foreground` or
`background`)"→"(`work`)"), the `RESTORABLE` comment (`= [background,
foreground]`→`= [work]`), the `ALL_SESSIONS` comment, and the
`sweepBusyPanes`/`killAllSessions` docstrings; dispatch docstrings
(~:33-35, :308-309, :331-332); view-model comment ~:17.

Docs: README setup-tmux step (~615-627) and its architecture mirror
(~1340-1361); README dispatch section (~1032-1040) including the
`--session background` example → `--session work` and the
`current/foreground` comment; dispatch SKILL.md `:77` + `:140`.

No new behavior: do NOT add an orphan-session sweep for the old names.
Orphan cleanup of any still-running `foreground`/`background` session is a
one-time manual operator step, explicitly out of scope.

### Investigation targets

**Required** (read before coding):
- cli/setup-tmux.ts:65-93 — `WORK_SESSIONS`/`ALL_SESSIONS` AND the
  busy-classification block (`SHELL_COMMANDS`, "non-shell foreground")
  that MUST stay untouched; both senses of the word live in this file.
- cli/setup-tmux.ts:501-640 — `RESTORABLE`, the restore-offer loop, and
  the prose to refresh (single restorable session after the change).
- src/dash/view-model.ts:137-168 — `SESSION_PRIORITY`, band rank, and the
  alphabetical "other named" fallback (governs where any leftover
  `background` job now sorts).
- cli/dispatch.ts:130-145, 300-333 — `FALLBACK_SESSION`, the help prose,
  and `resolveSession`.
- test/setup-tmux.test.ts:540-768 — the restore-offer block built around
  TWO restorable sessions; the redesign target.
- test/dash-view-model.test.ts:285-316 — band-order + title pins.
- test/keeper-cli.test.ts:415-435 — dispatch fallback assertions.

**Optional** (reference as needed):
- README.md:614-627, 1032-1040, 1340-1361 — doc sites.
- plugins/keeper/skills/dispatch/SKILL.md:77,140 — skill doc sites.
- test/restore-agents.test.ts, test/restore-set.test.ts,
  test/exec-backend.test.ts, test/dash-app.test.ts — incidental fixture
  strings (rename for consistency; NOT assertion-load-bearing).

### Risks

- **Dual-sense word.** `cli/setup-tmux.ts` and README contain
  "foreground" in BOTH the session-name sense (rename) and the
  `pane_current_command` busy sense (`isBusyCommand`, `SHELL_COMMANDS`,
  "non-shell foreground" — DO NOT rename). Edits MUST be site-targeted; a
  blind file-wide replace corrupts the busy-scan. Generic "background
  worker/task/backgrounded test" prose and README:368 "shared background
  session" (which describes the autopilot session) also stay.
- **Historical state is forward-only.** Do NOT rewrite
  `"foreground"`/`"background"` in `.keeper/specs/*` (historical specs) or
  in `events`/`jobs` history — old jobs keep their old session band by
  design (re-fold determinism). The dash renders a leftover
  `background`/`foreground` band for old jobs until they age out; accepted.
- **Test redesign, not rename.** The restore-offer matrix collapses from
  two restorable sessions to one — see Test notes.

### Test notes

- `test/setup-tmux.test.ts` restore-offer block: collapse the two-session
  matrix to a single restorable session (`work`). Target coverage: work
  absent + count>0 + TTY + y ⇒ spawns restore-agents for work; work
  present ⇒ no offer; absent + count-0 ⇒ no offer; non-TTY ⇒ never
  auto-restores; and the existing "autopilot never offered" guard stays.
  Drop the now-meaningless "offer X but not Y" selective cases. Update the
  `spawnedAnyRestore`/offer helpers that hardcode
  `["foreground","background"]`, and the `buildWorkNewSessionArgs`
  fixture argument (currently `"background"`) → `"work"`.
- `test/dash-view-model.test.ts`: reorder the band-order expectation to
  `["work","autopilot",...]`; a `background`/`foreground` fixture job (if
  kept) now sorts in the alphabetical "other named" zone, not a priority
  slot — adjust the expected ordering accordingly.
- `test/keeper-cli.test.ts`: dispatch fallback expectations
  `{session:"foreground"}` → `{session:"work"}`.
- Grep gate before committing: `rg -n '"foreground"|"background"' cli/
  src/ test/` — every remaining hit must be either an intentionally-kept
  incidental fixture or the busy-classification sense; zero session-name
  constants left.
- Run `bun run test:full` (NOT just the fast tier) — this touches
  CLI/dash/tmux process paths the fast tier skips.

## Acceptance

- [ ] `WORK_SESSIONS` is `[MANAGED_EXEC_SESSION, "work"]`; no
  `"background"` session is provisioned anywhere.
- [ ] `SESSION_PRIORITY` is `["work", "autopilot"]` (autopilot still a raw
  literal); `FALLBACK_SESSION` is `"work"` and the dispatch precedence
  help-string says `work`.
- [ ] Busy-classification (`isBusyCommand`/`SHELL_COMMANDS`/"non-shell
  foreground") and generic "background worker/task" prose are unchanged.
- [ ] setup-tmux header/`HELP`, the `RESTORABLE`/`ALL_SESSIONS` comments,
  and README reflect TWO work sessions and "all three sessions" for
  `--kill-sessions`; the README `--session background` example no longer
  names a removed session.
- [ ] dispatch SKILL.md precedence cell + attach-hint say `work`.
- [ ] No `"foreground"`/`"background"` session-name string literal remains
  as a production constant (grep-clean); `.keeper/specs/*` and event/job
  history are untouched.
- [ ] `bun run test:full` passes.

## Done summary
Dropped the background tmux session and renamed foreground to work across WORK_SESSIONS, SESSION_PRIORITY, and dispatch FALLBACK_SESSION plus all docstrings/docs/tests; collapsed the restore-offer matrix to one restorable session. Busy-classification and generic background prose left untouched.
## Evidence
