## Description

**Size:** S
**Files:** src/resume-descriptor.ts, test/resume-descriptor.test.ts

### Approach

Reproduce first: confirm `buildResumeCommand` (`src/resume-descriptor.ts:105`)
emits `claude --resume "<uuid>" --x-no-confirm` for the claude arm, and that
`--x-no-confirm` is a keeper launcher-ALIAS flag (module docstring) that only
resolves via the `claude → keeper agent claude` shell alias — so a paste into an
alias-less / non-interactive shell reaches the real claude binary, which rejects
the flag and insta-dies.

This is the DISPLAY / human-paste surface only. Drop `--x-no-confirm` and emit
plain `claude --resume "<uuid>"` (confirm raw-claude resume syntax during repro;
a re-introduced interactive cwd-confirm prompt on a human paste is acceptable).
Do NOT touch the launch path (`keeperAgentLaunch` / `src/exec-backend.ts`) — it
builds its own correct argv. Update the pinned fixtures
(`test/resume-descriptor.test.ts:104-114` and others that assert the flag
verbatim); do NOT touch launch-path fixtures (exec-backend/dispatch/agent-*),
which must keep their own argv.

### Investigation targets

*Verify before relying — planner-verified at authoring time, repo moves.*

**Required:**
- src/resume-descriptor.ts:96-108 — `buildResumeCommand`; docstring 85-89 explains the alias flag
- test/resume-descriptor.test.ts:104-114 — fixtures pinning `--x-no-confirm` verbatim (plus other occurrences to grep)

**Optional:**
- src/agent/harness.ts — `HARNESS_DESCRIPTORS`; non-claude arms already omit the flag

### Risks

- The emitted string is a human-facing contract pinned by fixtures — treat as stateful, grep ALL `--x-no-confirm` occurrences in tests.
- Advisory overlap with fn-1239 on the resume/restore seam — keep the change display-scoped.

### Test notes

Update every fixture that asserts the flag; add a test that the emitted claude resume string contains no `--x-` launcher-alias flag.

## Acceptance

- [ ] `buildResumeCommand`'s claude arm emits a command that runs in an alias-less shell (no `--x-no-confirm`).
- [ ] The launch path and its fixtures are unchanged.
- [ ] All display-surface fixtures asserting the old flag are updated and green.

## Done summary

## Evidence
