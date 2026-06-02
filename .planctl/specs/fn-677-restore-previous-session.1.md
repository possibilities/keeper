## Description

**Size:** M
**Files:** src/resume-descriptor.ts (new), src/db.ts, scripts/resume.ts, CLAUDE.md, README.md, test/resume-descriptor.test.ts (new)

### Approach

Extract the pure resume-command logic from `scripts/resume.ts` into a new
`src/resume-descriptor.ts` so the worker (T3), the util (T4), and
`resume.ts` all build byte-identical descriptors and commands. Move
`resumeTarget(job)` and `buildResumeCommand(cwd, target, tier)` verbatim
(both already pure). Extract the tier lookup as a PURE function
`tierForJobFromEpics(job, epicsById: Map<string, Epic>): string | null`
— the existing `tierForJob` does lazy per-epic UDS fetches; keep that
fetch loop in `resume.ts` but have it call the pure core once it has the
epic, so the worker (which reads ALL epics at once) can pass its own map.
Add `resolveRestorePath()` to `src/db.ts` cloning the
`resolveDbPath`/`resolveSockPath`/`resolveDeadLetterDir` env-override-wins
pattern: `KEEPER_RESTORE_FILE` wins, else
`join(homedir(), ".local", "state", "keeper", "restore.json")`. Pure, no
I/O (caller mkdirs). Refactor `resume.ts` to import from the new module
(no behavior change — its output must stay byte-identical) and prune its
header's now-stale self-description. Add `KEEPER_RESTORE_FILE` to the
CLAUDE.md test-isolation env-var list and `restore.json` to the README
`~/.local/state/keeper/` file inventory.

### Investigation targets

**Required** (read before coding):
- scripts/resume.ts:306-376 — `tierForJob` / `buildResumeCommand` / `resumeTarget` / `jobLabel` to extract
- src/db.ts:68-89 — `resolveDbPath` / `resolveSockPath` env-override pattern to clone
- src/db.ts:335 — `resolveDeadLetterDir` (the third resolver sibling)
- src/autopilot-worker.ts:159 — `workPluginDir(tier)` that `buildResumeCommand` depends on

**Optional** (reference as needed):
- CLAUDE.md "Test isolation" bullet — the three-var list to extend
- README.md `~/.local/state/keeper/` file inventory section

### Risks

`resume.ts` output must stay byte-identical post-refactor — assert with a
before/after diff of `bun scripts/resume.ts` against a fixture daemon, or
a unit test pinning the command string. The pure/lazy split on tier is the
one place a regression could creep in.

### Test notes

New `test/resume-descriptor.test.ts` drives the pure exports directly
(`resumeTarget` fallback to job_id, `buildResumeCommand` with/without
tier, `tierForJobFromEpics` hit/miss). No daemon, no UDS. `resolveRestorePath`
env-override + default asserted with `KEEPER_RESTORE_FILE` set/unset.

## Acceptance

- [ ] `src/resume-descriptor.ts` exports pure `resumeTarget`, `buildResumeCommand`, `tierForJobFromEpics`.
- [ ] `resolveRestorePath()` added to `src/db.ts`, `KEEPER_RESTORE_FILE` override, default sibling of the DB.
- [ ] `scripts/resume.ts` imports the shared module; its output is byte-identical to before.
- [ ] CLAUDE.md test-isolation list includes `KEEPER_RESTORE_FILE`; README file inventory lists `restore.json`.
- [ ] `test/resume-descriptor.test.ts` covers the pure exports + the resolver.

## Done summary

## Evidence
