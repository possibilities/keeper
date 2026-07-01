## Description

**Size:** S
**Files:** plugins/plan/agents/panel-runner.md, plugins/keeper/skills/pair/SKILL.md, README.md, CLAUDE.md

### Approach

Wire the callers to the resumable contract and consolidate docs. panel-runner.md: add a
Re-entry story — a restarted runner re-issues the SAME `panel start --slug <slug>` with
the SAME prompt and it reconciles (reuse/relaunch) automatically; `wait --slug` is the
simple re-entry form; the prompt file must live at (or be re-materialized to) a path
that satisfies the identity guard on re-entry (not a throwaway `mktemp /tmp/...` that
vanishes). pair/SKILL.md: `wait --slug` as the preferred re-entry form, `status --slug`
for a non-blocking check, a `prune` housekeeping note, and an idempotent-start note.
README.md: consolidate the panel section (~:1413-1481) — deterministic state dir,
reconcile, identity guard, boot-epoch, lock, the three new verbs — and fix the "panels
are ephemeral" line (~:32): the no-DB-row/no-event claim stays, but state is now durable
under ~/.local/state/keeper/panels/, GC'd via prune. CLAUDE.md Sole-writer rules: add one
line naming `keeper agent panel start` the SOLE writer of ~/.local/state/keeper/panels/.
Forward-facing prose only (no fn-ids/provenance); consolidate, don't append.

### Investigation targets

**Required** (read before coding):
- plugins/plan/agents/panel-runner.md — Steps 1-3 (the mktemp prompt path + start/wait calls) to add the Re-entry callout
- plugins/keeper/skills/pair/SKILL.md (~:63) — the detached start/wait section
- README.md (~:1413-1481 panel section + the "ephemeral" line ~:32)
- CLAUDE.md — the "Sole-writer rules" bullet (match its one-clause-per-surface shape)

### Risks

- Docs discipline: forward-facing only, no provenance/fn-ids; `bun scripts/lint-claude-md.ts` gates CLAUDE.md size + re-narration — keep it green.
- panel-runner.md must NOT be a managed/generated file before editing (verify no .managed sibling).

### Test notes

- No code; verify `bun scripts/lint-claude-md.ts` stays green and the panel-runner/pair examples match the shipped verb surface from tasks .2/.3.

## Acceptance

- [ ] panel-runner.md carries a Re-entry story (re-issue same slug+prompt reconciles; wait --slug); the prompt path survives re-entry
- [ ] pair/SKILL.md documents wait --slug, status --slug, prune, idempotent start
- [ ] README panel section consolidated + "ephemeral" line corrected to durable-state
- [ ] CLAUDE.md Sole-writer rules gains the panels-dir sole-writer line; lint-claude-md green

## Done summary

## Evidence
