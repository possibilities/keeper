## Description

**Size:** S
**Files:** plist/arthack.babysitter.performance.watch.plist, plist/arthack.babysitter.performance.watchdog.plist, README.md (new), CLAUDE.md (new)

### Approach

Copy both plists from keeper/plist/ into sitter/plist/ and edit:
ProgramArguments (`bun run /Users/mike/code/sitter/performance/...`),
WorkingDirectory (`/Users/mike/code/sitter` — NOT the agent-spawn cwd,
which is separate per-sitter config and stays keeper), and the
install/uninstall comment blocks. Keep StartInterval (300s/600s),
RunAtLoad, ProcessType, and the PATH line (`~/.local/bin` for claude +
botctl) as-is. State paths under ~/.local/state/babysitters/ unchanged.

Cutover with no monitoring gap (launchd has no hot-swap): bootstrap
the sitter-path jobs FIRST, verify one healthy tick
(`launchctl print` + heartbeat.json mtime advances), then bootout the
keeper-path jobs and repoint the ~/Library/LaunchAgents symlinks to
sitter/plist/. The keeper-side plist file deletion is task 5.

Write sitter README.md: what the daemon set is, architecture note
(out-of-process read-only scanner, no synthetic events, no RPC, no
keeper imports), launchd install/uninstall (copy-edit keeper README's
babysitter blocks before task 5 deletes them), the schema-fixture
regen one-liner, and a pointer to keeper as the observed system.
Write sitter CLAUDE.md in keeper's short rule-bullet style: pure
read-only external observer invariant (moved from keeper CLAUDE.md),
zero-keeper-import fence, whitelist+fixture-move-together rule,
always-exit-0 hook... (launchd) posture, state-dir carve-out.

### Investigation targets

**Required** (read before coding):
- plist/arthack.babysitter.performance.watch.plist — every hardcoded path + the comment block
- plist/arthack.babysitter.performance.watchdog.plist — same
- README.md:452-505,1176-1183 (keeper) — the install/uninstall prose to copy-edit before it's pruned

**Optional** (reference as needed):
- CLAUDE.md:17-19,74 (keeper) — the invariant bullets moving to sitter's CLAUDE.md
- ~/Library/LaunchAgents/arthack.babysitter.performance.*.plist — current symlinks to repoint

### Risks

- Both old and new watch jobs briefly coexist during cutover — they
  share seen.json; the overlap window is one tick worst-case and the
  seen-state dedup makes a double-page unlikely, but keep the window
  short (verify-then-bootout in one sitting).
- launchd caches by Label: same Label at a new path needs bootout
  before bootstrap, or kickstart -k after repointing.

### Test notes

`launchctl print gui/$(id -u)/arthack.babysitter.performance.watch`
shows the sitter path; heartbeat.json advances within one interval;
`launchctl list | grep babysitter` shows exactly two jobs.

## Acceptance

- [ ] Both jobs run from /Users/mike/code/sitter paths; heartbeat advances
- [ ] No interval elapsed with zero watch jobs loaded (no monitoring gap)
- [ ] ~/Library/LaunchAgents symlinks point into sitter/plist/
- [ ] README.md + CLAUDE.md exist with install/uninstall, invariants, and the fixture regen command

## Done summary

## Evidence
