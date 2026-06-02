## Description

**Size:** M
**Files:** scripts/restore-agents.ts (new), test/restore-agents.test.ts (new)

### Approach

New util `scripts/restore-agents.ts` (mirrors `scripts/resume.ts`'s
one-shot shape). Flags: `--session <name>` (restore one zellij session) or
all sessions by default; `--dry-run` (DEFAULT) prints what would be
restored, `--apply` actually relaunches; `--sock` override; `--help`.
Read `resolveRestorePath()`, `JSON.parse` inside try/catch — any
malformed/absent file => "nothing to restore", exit 0, clear message (no
stack). Check the file's top-level `schema_version`: an unknown FUTURE
version => refuse to restore (clear message), older/missing => apply safe
defaults. Build the live-jobs skip-set by querying `jobs` over a fresh UDS
round-trip (reuse `resume.ts`'s `roundTrip`/`fetchJobs` shape — extract or
copy); a daemon-down / connect-fail degrades to an EMPTY skip-set (restore
everything — the disaster-recovery path) rather than aborting. For each
agent in the selected session(s) whose `job_id` is NOT currently live
(working/stopped), build the resume command via T1's `buildResumeCommand`
and, on `--apply`, `ensureLaunched(session, argv, cwd)` (T2) — argv is the
`buildLaunchArgv`-style shell wrap; no tab name. Continue past a single
agent's launch failure (don't abort the batch); print a summary
(restored / skipped-live / failed counts). When `--apply` and autopilot is
unpaused, print a one-line warning (restored tabs aren't `verb::id`-named,
so autopilot's fn-674 probe can't see them — double-dispatch risk; suggest
pausing first). Refactor `resume.ts` only if extracting `roundTrip` is the
clean path; otherwise copy it (it's already copied from commands.ts).

### Investigation targets

**Required** (read before coding):
- scripts/resume.ts:120-218 — `roundTrip` one-shot UDS helper
- scripts/resume.ts:228-255 — `fetchJobs` + the live-vs-all state filter precedent
- scripts/resume.ts:392-429 — `main()` arg parsing + stanza output shape
- src/resume-descriptor.ts (T1) — `buildResumeCommand` / `resumeTarget`
- src/exec-backend.ts ensureLaunched (T2) — the launch entry point
- src/autopilot-worker.ts:467-473 — `buildLaunchArgv` shell-wrap shape

**Optional** (reference as needed):
- cli/autopilot.ts / src/reducer.ts autopilot_state — how to read the paused flag for the warning

### Risks

The dedup must query LIVE jobs only (working/stopped) — querying all states
would match the re-folded `killed` rows and skip everything. Daemon-down
must NOT abort (empty skip-set => restore all). A promoted `title` shared
by two jobs makes `--resume "<name>"` ambiguous, but that's the
human-run-it-manually shape (out of scope to disambiguate per resolved
decisions).

### Test notes

`test/restore-agents.test.ts` drives the pure pieces: schema_version gate
(known/unknown/missing), parse-failure => no-op, session filter, and the
dedup diff (skip-set from a fake live-jobs list) against a fixture
restore.json. Inject a fake `ensureLaunched` capturing intended launches so
`--apply` is asserted without real zellij; `--dry-run` asserts no launch
calls. Sandboxed env incl. `KEEPER_RESTORE_FILE`.

## Acceptance

- [ ] `scripts/restore-agents.ts`: `--dry-run` default, `--apply` explicit, `--session <name>` or all, `--help`.
- [ ] Parse-safe (malformed/absent => exit 0 no-op) + `schema_version` future-refuse gate.
- [ ] Dedups against LIVE jobs (working/stopped); daemon-down => empty skip-set => restore all.
- [ ] `--apply` relaunches via `ensureLaunched` + `buildResumeCommand` (no tab name); continues past single-agent failure; prints summary counts.
- [ ] Warns when autopilot is unpaused; `test/restore-agents.test.ts` covers gate/filter/dedup/dry-run-vs-apply.

## Done summary
Added scripts/restore-agents.ts (dry-run default, --apply / --session / --help) replaying surviving agents from restore.json via ExecBackend.ensureLaunched + buildResumeCommand. Parse-safe (missing/malformed=>exit-0 no-op), future-schema_version refuse gate, live-jobs dedup with daemon-down=>empty skip-set, autopilot-unpaused warning. test/restore-agents.test.ts (26 tests) covers schema gate, dedup, plan, shell-wrap, apply-vs-dry-run via fake ensureLaunched, and loadRestoreFile branches.
## Evidence
