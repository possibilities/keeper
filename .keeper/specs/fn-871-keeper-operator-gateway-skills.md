## Overview

Two new agent-facing `keeper:*` gateway skills — `keeper:dispatch` and
`keeper:autopilot` — that map natural-language human intent to keeper CLI
commands, mirroring the existing `keeper:await` skill. Plus carve-out and
enumeration doc edits so the existing "plan and walk away" prose stays true
once a human-invoked operator escape hatch exists. Manual control is an
OPERATOR ESCAPE HATCH: exceptional and human-gated, NOT a philosophy shift.

## Quick commands

- `ls plugins/keeper/skills/` — dispatch/ + autopilot/ + await/ all present
- `keeper dispatch --dry-run work::<real-board-id>` — validate the dispatch skill's documented invocation + output shape
- `keeper autopilot --snapshot | tail -1` — validate the capture read-back (keeper-meta JSON + {paused,mode,armed})

## Acceptance

- [ ] `keeper:dispatch` + `keeper:autopilot` SKILL.md exist, slash-only, mirror await's structure (intent->command table, Steps, Examples, What NOT to do, Guardrails)
- [ ] `keeper:autopilot` documents the capture->drive->restore take-over lifecycle (full {paused,mode,armed}, re-read before restore, restore-failure surfaced)
- [ ] `keeper:dispatch` surfaces the race-guard refusal and asks (never auto-pauses); `--force` human-gated
- [ ] carve-out + enumeration doc edits land; planning skills never advertise the operator door; hack's "Orchestration is yours to shape" closed list NOT widened
- [ ] no plugin manifest or hooks.json edits (skills auto-discover)

## Early proof point

Task that proves the approach: `.1` (keeper:dispatch). If the gateway / intent-table shape doesn't read cleanly against `await`, rework the template mirroring before doing `.2`.

## References

- `plugins/keeper/skills/await/SKILL.md` — the structural template every section mirrors
- `cli/dispatch.ts`, `cli/autopilot.ts`, `cli/control-rpc.ts`, `src/snapshot.ts` — the CLI surfaces the skills wrap
- Committed reconciliation stance: the operator hatch is exceptional + human-gated; planning skills never advertise it; `keeper:dispatch` surfaces the race-guard refusal and asks (never auto-pauses)
- Out of scope (separate follow-up): adding `--agent-help` to `cli/dispatch.ts` / `cli/autopilot.ts` so the skills could stay thin

## Docs gaps

- **README.md (~383, CLI subsections ~872 / ~956)**: enumerate all three keeper skills in the plugin surface; cross-ref the new gateway skills from the dispatch/autopilot CLI subsections
- **CLAUDE.md (~16, symlinked AGENTS.md)**: enumerate all three keeper skills — edit in place
- **plugins/plan/CLAUDE.md (~34)**: keep consistent with the carve-out wording

## Best practices

- **description**: imperative "Use when..." trigger + near-miss exclusions (dispatch<->autopilot, dispatch<->plan:work) to prevent over-trigger
- **intent->command TABLE, not a menu**: exact invocations, never "pass any valid flags"; pre-check before acting; gate ambiguous control-plane intent with ONE clarifying question
- **capture->operate->restore**: restore wired per mutating phase, restore-failure surfaced distinctly, re-read before restore (the reconciler is level-triggered and may have drifted)
