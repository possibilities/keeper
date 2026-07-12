## Description

**Size:** S
**Files:** src/backup.ts, test/backup.test.ts

### Approach

Reproduce first: confirm `reclaimInstructions()` renders placeholder launchctl
steps (`launchctl bootout <keeperd label>`, `launchctl bootstrap <keeperd domain/label>`)
that a future agent must resolve by hand. Render the RESOLVED commands instead —
the actual service target `gui/<uid>/arthack.keeperd` and the actual plist path
(`plist/arthack.keeperd.plist`, or wherever the loaded plist resolves) — so
`keeper reclaim --agent-help` / `--dry-run` prints copy-pasteable lines. Resolve
the uid and plist path from the environment/launchd at render time; keep a safe
fallback to the placeholder if resolution fails. Do not shell-interpolate unsafely.

### Investigation targets

*Verify before relying — the repo moves.*

**Required:**
- src/backup.ts:755+ — `reclaimInstructions()`; the `<keeperd label>` / `<keeperd domain/label>` placeholder lines
- the reclaim CLI wiring for `--agent-help` / `--dry-run` (renders this text)

### Test notes

Extend test/backup.test.ts: the rendered runbook contains a concrete `gui/<uid>/arthack.keeperd` target and a real plist path, not the placeholder (with the fallback path also covered).

## Acceptance

- [ ] `keeper reclaim --agent-help` renders resolved, copy-pasteable launchctl bootout/bootstrap commands (real label + plist), with a safe fallback if resolution fails.

## Done summary
reclaimInstructions() now resolves the real gui/<uid>/arthack.keeperd service target and the loaded LaunchAgent plist path (via launchctl print, falling back to the conventional ~/Library/LaunchAgents path, then to the original placeholder) so keeper reclaim --agent-help/--dry-run prints copy-pasteable launchctl bootout/bootstrap commands.
## Evidence
