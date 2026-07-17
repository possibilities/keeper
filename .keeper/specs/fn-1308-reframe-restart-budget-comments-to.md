## Overview

The restart-budget fix landed two constant comments in `cli/restart.ts`
that narrate the change in past tense ("the full 30s this used to allow")
and describe a now-defunct 1s kickstart budget in the present tense — both
at odds with CLAUDE.md rule #0 (forward-facing advice only; history lives
in docs/adr and commit messages). The why-this-number rationale is genuinely
useful and must be preserved; only the historical/misleading framing is
reworked to state current behavior.

## Acceptance

- [ ] The `DEFAULT_RESTART_TIMEOUT_MS` and `KICKSTART_TIMEOUT_MS` comments in
      `cli/restart.ts` describe current behavior only — no past-tense
      provenance, no reference to the retired 1s kickstart budget as if live.
- [ ] The forward-facing why-this-number rationale (why 150s / why 15s) is
      retained so a future reader will not shrink the budgets back down.
- [ ] `bun scripts/lint-claude-md.ts` stays green and existing restart tests pass.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | cli/restart.ts:15-24 @381292a4 — past-tense provenance comments violate CLAUDE.md rule #0 and the "1s subprocess budget" clause misleads about the now-15s kickstart path. |
| F2 | culled | — | Duplicated RestartDeps mock is advisory-only test-fixture cleanliness (auditor tagged Consider/optional) — no user impact, no correctness defect. |

## Out of scope

- Any change to the budget values themselves (150s deadline, 15s kickstart) — the numbers are correct; only the comment framing is reworked.
- The duplicated RestartDeps test-mock scaffolding (F2, culled) — left as-is.
