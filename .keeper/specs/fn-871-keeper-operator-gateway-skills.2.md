## Description

**Size:** M
**Files:** plugins/keeper/skills/autopilot/SKILL.md (new)

### Approach

Author a new gateway skill mirroring await's structure (same frontmatter
conventions; slash-only; `allowed-tools: Bash` — add `Monitor` only for the
await-integration cross-ref examples). Two layers:

**(1) Single control ops + reads.** An intent->command TABLE mapping
"pause" / "play / let it run" / "yolo / let it rip" / "only work fn-X and its
deps (armed)" / "arm fn-Y" / "disarm fn-Y" / "retry work::fn-X.3 |
approve::fn-X" / "show me what autopilot is doing" -> the matching `keeper
autopilot <sub>` (pause / play / mode yolo|armed / arm / disarm / retry /
snapshot read). A bare control op JUST RUNS — no capture/restore. Reads use
`keeper autopilot --snapshot | tail -1` (the `keeper-meta:` JSON trailer +
state sidecar) or the banner frame; NEVER `--watch` (it hangs an agent). Gate
ambiguous control-plane intent with ONE clarifying question; fail loud on
ambiguity.

**(2) The temporary take-over window (capture->drive->restore).** ONLY when the
human asks to "take over for a bit, then put it back." Capture the full
singleton {paused, mode, armed_epics} from `keeper autopilot --snapshot` BEFORE
mutating; pin it in working context across the window. The window closes on an
EXPLICIT signal (the human says "restore it / done", or an armed `keeper:await`
fires) — NOT a turn boundary. On close, RE-READ current state (the
level-triggered reconciler may have drifted), restore only the fields the
take-over changed, and surface a restore failure as a DISTINCT "autopilot state
unknown — verify with `keeper autopilot --snapshot`" error (never swallowed).
Wire restore per mutating phase; name the partial-mutation case (mode changed
but arm failed).

Teach the **risk gradient** explicitly: `arm` / `mode armed` NARROW a
still-running autopilot (low risk, walk-away-adjacent); `keeper dispatch`
BYPASSES it (you drive — cross-ref `keeper:dispatch`). "Prioritize this" stays
`plan:next` unless the human explicitly names autopilot/armed (anti-trigger).
`## Guardrails` restates exceptional + human-gated + restore-when-done.
**await-integration**: cross-ref `keeper:await` for "pause and do something
manually at a point while work runs" (a take-over plus an armed await). Add a
one-line note that the `keeper:autopilot` SKILL name collides as a string with
the `keeper autopilot` CLI subcommand — running the viewer is a Bash call, not
"open the skill."

### Investigation targets

**Required** (read before writing):
- plugins/keeper/skills/await/SKILL.md — structural template + the Monitor/await cross-ref pattern
- cli/autopilot.ts:45 — HELP / subcommands / boots-PAUSED note
- cli/autopilot.ts:73 — snapshot / `--watch` / `--timeout` flags + non-TTY auto-detect
- cli/autopilot.ts:268 / :309 / :324 — state coercers paused / mode / armed
- cli/autopilot.ts:68 — retry verb set `work|close|approve`
- src/snapshot.ts — `keeper-meta:` trailer + state-JSON sidecar (the {paused,mode,armed} capture read-back)

**Optional**:
- cli/autopilot.ts:587 — stateJson (the snapshot's {paused,mode,armed} fields)
- cli/control-rpc.ts:150 / :187 — queryCollection / sendControlRpc (what a control command prints on success)

### Risks

- Restore correctness is the keystone: capturing fewer than {paused, mode, armed_epics}, or restoring without re-reading, produces a wrong GLOBAL state (level-triggered drift, partial mutation). This is why the task is xhigh.
- Over-applying capture/restore to a bare single op would auto-undo a deliberate "pause it" — capture/restore is take-over-window-only.
- Over-trigger vs `keeper:dispatch` and vs `plan:next` — near-miss exclusions + the anti-trigger ("prioritize" != autopilot).
- `--watch` hangs an agent — must be a documented What-NOT-to-do.

### Test notes

No automated gate. Validate by running `keeper autopilot --snapshot | tail -1`
and confirming the documented keeper-meta / state shape; confirm the
capture/restore command sequence (pause/play, mode, arm/disarm) matches the real
subcommands. Frontmatter mirrors await.

## Acceptance

- [ ] plugins/keeper/skills/autopilot/SKILL.md exists, slash-only, mirrors await's structure
- [ ] intent->command table covers pause/play, mode yolo|armed, arm/disarm, retry (work|close|approve), snapshot read; bare ops do NOT capture/restore
- [ ] documents the capture->drive->restore take-over lifecycle: capture {paused,mode,armed_epics}, explicit window-close, re-read-before-restore, restore-failure surfaced distinctly, partial-mutation named
- [ ] risk gradient (arm/mode narrow vs dispatch bypasses) + anti-trigger ("prioritize" -> plan:next) taught
- [ ] reads via `--snapshot | tail -1`; NEVER `--watch` (in What NOT to do); name-vs-subcommand collision noted; `keeper:await` cross-ref present
- [ ] `## Guardrails` restates exceptional + human-gated; no plugin manifest or hooks.json edits

## Done summary

## Evidence
