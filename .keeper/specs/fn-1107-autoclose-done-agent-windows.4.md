## Description

**Size:** M
**Files:** src/daemon.ts, src/exit-watcher.ts, test/daemon.test.ts, README.md, plugins/plan/skills/panel/SKILL.md

### Approach

Wire the worker into the fleet and close the labeling loop, then update docs.

**Fleet wiring (4-link chain):** WorkerName union + ALL_WORKERS (NOT WATCHER_WORKERS —
autoclose dlopens no watcher) + spawn near the renamer with onerror/close -> fatalExit
guards + the shutdown registry. The worker is ALWAYS spawned (the fleet-contract test
asserts spawned == ALL_WORKERS exactly) and self-gates per pulse on config — a runtime
enable/disable flip needs no daemon restart. Unlike the renamer, wire an onmessage
handler for the autoclose intent hint.

**Killed labeling (one producer preserved):** main keeps a consume-once hint set keyed
by jobId, validating (pid, start_time) on match, with a TTL generous enough to outlive
the exit-watcher's periodic reprobe backstop age gate (~10 minutes) — the exit event may
arrive via the kernel fast-path, the pidless-reap arm, or the reprobe backstop, and all
three flow through the single main-side verifier that mints Killed. On a hint match,
stamp kill_reason 'autoclosed' instead of 'exit_watched' (close_kind classification
unchanged). The hint is posted only immediately pre-kill, so an aborted kill never
leaves a stale entry beyond the TTL; a consumed or expired hint falls back to
'exit_watched' (mislabel, non-fatal). Autoclose never gets a second Killed producer.

**Fleet test:** the exact-ordered ALL_WORKERS literal and the length assertion go from
19 to 20 in the same commit as the source change.

**Docs (forward-facing present tense, no history narration):** panel SKILL.md — rewrite
the "panel windows stay open for inspection until you close them by hand" sentence in
place: done claude panel legs auto-close after the grace, gated by autoclose_enabled;
codex/pi legs stay open. README — add autoclose to the worker-fleet tour line in place;
document autoclose_enabled (default true; exact disable values) and
autoclose_grace_seconds (default 30) in the config paragraph.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:3015,3041 — WorkerName union + ALL_WORKERS
- src/daemon.ts:7343-7356 — the renamer spawn + guard template; shutdown registry at :7792-7794
- src/daemon.ts:4790-4855 — the exit-watcher verifier + the exit_watched Killed mint (the stamp site)
- src/exit-watcher.ts:86-99 — ExitMessage carries jobId/pid/startTime only (no pane id); emit paths at :492, :521, and the reprobe backstop :260-300 with its REPROBE_MIN_AGE_SECS gate (sizes the hint TTL)
- test/daemon.test.ts:5169-5194 — the fleet contract literal (19 -> 20)

**Optional** (reference as needed):
- plugins/plan/skills/panel/SKILL.md:74-75 — the stay-open sentence to rewrite
- README.md:~44,~67 — fleet tour line + config paragraph

### Risks

- A hint TTL shorter than the reprobe backstop mislabels slow-observed autocloses as exit_watched — size it off the backstop constant, not a guess.
- Forgetting the shutdown-registry link leaves the worker alive past daemon teardown; forgetting the guard pair makes a worker crash invisible.

### Test notes

Fleet assertions updated alongside ALL_WORKERS. Unit-test the hint set as a pure
structure (insert/consume-once/TTL-expiry/pid-startTime mismatch -> no consume).
A daemon-level test that the Killed mint stamps 'autoclosed' on a hint match and
'exit_watched' otherwise, per existing daemon test patterns (no real Worker threads).

## Acceptance

- [ ] The daemon boots 20 workers; the fleet suite is green.
- [ ] A Killed minted for a hinted (jobId, pid, startTime) carries kill_reason 'autoclosed'; unhinted deaths keep 'exit_watched'; a hint is consumed at most once and expires.
- [ ] The panel skill and README describe the new behavior in present tense with the two config keys and their defaults; no history narration.
- [ ] `bun run test:full` green.

## Done summary

## Evidence
