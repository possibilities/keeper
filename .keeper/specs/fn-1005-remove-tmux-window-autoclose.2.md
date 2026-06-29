## Description

**Size:** S
**Files:** README.md, plugins/keeper/skills/pair/SKILL.md, plugins/plan/skills/panel/SKILL.md, ~/.config/keeper/config.yaml

### Approach

Forward-facing doc scrub + the operator's personal-config edit. State the end
behavior ("keeper no longer auto-closes any managed tmux window; windows stay open
for manual GC / inspection") and prune all autoclose machinery prose. No code reads
these, so this is parallel-safe with the code task. Note: `~/.config/keeper/config.yaml`
is OUTSIDE the repo — edit it directly; it is NOT part of the `keeper commit-work`
commit (call that out in the Done summary).

### Investigation targets

**Required** (read before coding):
- README.md:444-447 (delete window-reaper sentence -> "managed windows stay open for manual GC"), 467-475 (delete both config-key entries), 503-504 (delete the two `config.yaml` example comment lines), 2664-2666 (delete "window-reaper is its narrow ... successor"), 3160 (trim the "killWindow, the reaper's only kill op" parenthetical), 3196-3221 (delete the autoclose deep-dive paragraph), 3486-3516 (delete the "twelfth Worker thread is the tmux window-reaper" tour paragraph).
- README.md renumber after the deletion: 3518 thirteenth->twelfth (bus), 3556-3558 delete the "agentbus window is autoclosed by the window-reaper..." clause + rephrase, 3575 "restore/renamer/reaper workers"->"restore/renamer workers", 3584 fourteenth->thirteenth (handoff), 3598-3599 "fourteen workers ... all fourteen"->"thirteen" (x2).
- plugins/keeper/skills/pair/SKILL.md:63-65 (delete the codex/claude split-reap sentence) + 126 (prune the `--session` row's fire-and-forget / daemon-reaper / `disable_autoclose` text -> windows stay open for inspection).
- plugins/plan/skills/panel/SKILL.md:70-72 (delete "panel window autocloses... set `disable_autoclose: ['panels:*']`" -> panel windows stay open; `tmux attach -t panels`).
- ~/.config/keeper/config.yaml — remove the `disable_autoclose:` block (the `panels`/`pair`/`work` entries) at the end of the file.

### Risks

- **README:1784 "reaper regressed" STAYS** (it is the server-worker connection reaper, not the window-reaper).
- **Ordinal renumbering must be complete** — a missed thirteenth/fourteenth or the "fourteen workers" count word leaves the tour internally inconsistent.
- **CLAUDE.md needs no edit** (its "four reapers" = autopilot-internal).

### Test notes

No automated test covers prose. Verify by re-grepping `disable_autoclose|autoclose_grace_seconds|window-reaper` across README + the two SKILL.md (expect zero) and `disable_autoclose` in `~/.config/keeper/config.yaml` (expect zero). Commit the repo docs via `keeper commit-work`; the `config.yaml` edit is not committed.

## Acceptance

- [ ] README worker tour has the window-reaper paragraph removed and the ordinals + the "thirteen workers" count are internally consistent.
- [ ] README config-key docs, example comments, and the autoclose deep-dive are pruned; README:1784 untouched.
- [ ] pair/SKILL.md + panel/SKILL.md state forward-facing "windows stay open for inspection"; no `disable_autoclose` / autoclose prose remains.
- [ ] `~/.config/keeper/config.yaml` no longer contains the `disable_autoclose` block.
- [ ] `keeper commit-work` lands the repo doc changes; the personal-config edit is noted as a non-committed operator step.

## Done summary

## Evidence
