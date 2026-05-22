## Description

**Size:** S
**Files:** src/db.ts, src/daemon.ts, src/transcript-worker.ts, test/db.test.ts, test/integration.test.ts, README.md, CLAUDE.md

### Approach

Mirror the existing plan-roots config triplet in `src/db.ts`. Add
`claudeProjectsRoot?: string` to the `KeeperConfig` interface and extend
`resolveConfig()` to parse a new `claude_projects_root:` key from the SAME YAML
document, with a fallback INDEPENDENT of `roots` (a malformed/missing/non-string
`claude_projects_root` defaults without disturbing `roots`, and vice-versa). Add a
`resolveClaudeProjectsRoot(): string` resolver mirroring `resolvePlanRoots` but
SIMPLER: tilde-expand a leading `~/` / bare `~` against `homedir()` and return the
single path — do NOT existence-filter (a not-yet-existing root must still be
returned so the worker's existing late-appearance tolerance at
transcript-worker.ts:458 applies). Default `~/.claude/projects` via a
`DEFAULT_CLAUDE_PROJECTS_ROOT` const; honor the `KEEPER_CONFIG` path override.

In `src/daemon.ts`, retire the `KEEPER_WATCH_ROOT` env read (daemon.ts:200-201):
resolve on main via `resolveClaudeProjectsRoot()` and pass the absolute path as
`workerData.watchRoot` (always populated now), mirroring how the plan worker spawn
passes `roots: resolvePlanRoots()` (daemon.ts:263-271). If
`process.env.KEEPER_WATCH_ROOT` is still set, emit a one-line deprecation
`console.error` and otherwise ignore it. Keep `workerData.watchRoot` as the
worker's input field so the direct-spawn hermetic test (transcript-worker.test.ts:321)
is unaffected; `resolveWatchRoot()` in the worker becomes a thin pass-through of the
now-always-supplied field (or the worker reads `data.watchRoot` directly).

### Investigation targets

**Required** (read before coding):
- src/db.ts:58-149 — config triplet to mirror (DEFAULT_PLAN_ROOTS, KeeperConfig, resolveConfigPath, resolveConfig, resolvePlanRoots + its tilde expander)
- src/daemon.ts:195-205 — transcript worker spawn + the KEEPER_WATCH_ROOT read to retire
- src/daemon.ts:263-271 — plan worker spawn passing resolvePlanRoots() (the clean pattern to mirror)
- src/transcript-worker.ts:56-89 — TranscriptWorkerData.watchRoot + resolveWatchRoot
- test/db.test.ts:558-625 — config-resolver test pattern (save/restore KEEPER_CONFIG, tmp YAML, missing/malformed/missing-key fallbacks)
- test/integration.test.ts:44-70 + 491-584 — beforeEach config/watchRoot setup + transcript e2e that sets KEEPER_WATCH_ROOT at line 503

**Optional** (reference as needed):
- README.md:105-121 — config install step (currently documents only `roots:`)
- CLAUDE.md — src/db.ts + transcript-worker descriptions

### Risks

- The two config keys MUST fall back independently from the same parsed YAML doc — a malformed `claude_projects_root` must not break `roots` resolution (and vice-versa). Cover both-present, each-absent, malformed, and non-string combinations.
- `resolveClaudeProjectsRoot` must NOT existence-filter (unlike `resolvePlanRoots`, which drops missing entries from a plural list) — returning a missing single path is correct.
- Don't `path.join` an already-absolute non-`~` value (leading-slash reset) — pass non-tilde paths through untouched, matching the existing expander.

### Test notes

- db.test.ts: `claude_projects_root` present → expanded path; absent → default `~/.claude/projects`; malformed YAML → default; non-string value → default; independent fallback when `roots` is malformed but the key is valid.
- integration.test.ts:503: drop `KEEPER_WATCH_ROOT` from the daemon env; add `claude_projects_root: <watchRoot>` to the tmp config YAML (beforeEach, ~line 65-70); confirm the transcript e2e still folds a title.
- transcript-worker.test.ts:321 should keep passing unchanged (worker still accepts `workerData.watchRoot`).
- Update README install step 3 + CLAUDE.md/AGENTS.md to document the new key as a SEPARATE concept from `roots`.

## Acceptance

- [ ] `KEEPER_WATCH_ROOT` is no longer read anywhere; a still-set value emits a one-line deprecation warning and is otherwise ignored
- [ ] `claude_projects_root` resolves from `~/.config/keeper/config.yaml` (KEEPER_CONFIG override honored), default `~/.claude/projects`, tilde-expanded, no existence-filtering
- [ ] Plan `roots` behavior is byte-for-byte unchanged; the two keys fall back independently from the same YAML doc
- [ ] The daemon resolves the root on main and passes it as `workerData.watchRoot` (mirrors the plan-worker spawn)
- [ ] db.test.ts covers present/absent/malformed/non-string/independent-fallback; integration.test.ts migrated off `KEEPER_WATCH_ROOT` to the config key; full `bun test --isolate` green
- [ ] README + CLAUDE.md/AGENTS.md document `claude_projects_root` as separate from `roots`

## Done summary
Migrated the transcript watch root from KEEPER_WATCH_ROOT env var to a config-driven claude_projects_root key (default ~/.claude/projects), resolved on main via resolveClaudeProjectsRoot() and passed as workerData.watchRoot. The two config keys fall back independently; a still-set KEEPER_WATCH_ROOT logs a deprecation and is ignored.
## Evidence
