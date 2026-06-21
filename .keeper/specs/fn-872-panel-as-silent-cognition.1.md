## Description

**Size:** M
**Files:** /Users/mike/code/arthack/claude/arthack/skills/panel/SKILL.md, /Users/mike/code/arthack/claude/arthack/skills/panel/references/panel.md, /Users/mike/code/arthack/claude/arthack/agents/panel-judge.md

### Approach

Rewrite the panel mechanism so its output is absorbed as the agent's own thinking, and drop the panelist-availability machinery. Three files:

1. **panel/SKILL.md**
   - Step 0 ("Confirm the panel", ~lines 32-44): remove the `command -v codex` precheck and the "downgrades to Opus-only / tell the judge codex was dropped" path. **Relocate the `mkdir -p /tmp/panel-${CLAUDE_CODE_SESSION_ID}` line (currently ~:39) into Step 1** (the prompt-file write) — Steps 1-2 depend on the dir existing, so it must move, not vanish. State the panel positively: it is always opus4.8-gpt5.5 (Opus 4.8 + GPT-5.5), both in parallel.
   - Step 2 (fan-out, ~:88): drop the "[pairctl] failed -> that panelist is dropped" branch. Per the assume-all-available decision, do not add replacement defensive handling.
   - Step 3 (spawn judge, ~:95-108): drop the "explicit composition list / which were dropped" bullet — both panelists are always dispatched, so pass the judge both answer-file paths with no composition accounting.
   - **Step 4 — rewrite end-to-end** (currently "Relay", ~:110-118) -> retitle "Absorb, then answer." The FIRST sentence carries the load-bearing rule: treat the judge's final answer as your own conclusion (data you received), and answer in whatever shape the question needs — never a "here's what the panel did" container, no audit dump, no composition note, no panel-naming by default. For a directly-invoked `/arthack:panel`, answer the question in its natural shape as your own answer. Reveal-on-demand is a trigger condition: *if the human asks how you reached the answer / what contributed / to see the panel*, then surface the audit + composition and point to `pairctl show-chat` / `claudectl show-session`. Substance questions ("are you sure?", "why?") get a substantive answer in your own voice, not a panel reveal. Express genuine low confidence in your own voice (the judge's contradictions / blind-spots tell you to hedge; you hedge as yourself). Keep "don't paste panelist transcripts." Keep the cost / latency note (agent-facing, informs the solo-vs-panel choice).

2. **references/panel.md** (~:40-41): remove the "dropped panelist is absent, never silent agreement" paragraph and any codex-missing fallback language. Keep the independence / no-personas / no-lenses core intact.

3. **agents/panel-judge.md**: the judge stays internal and keeps full rigor — all five audit sections (~:62-81) and the blind-adjudication / calibration rules (single-source < multi-source, same-family < cross-family; ~:65, ~:91-92) STAY. Remove ONLY the dropped-panelist machinery: the composition-list input bullet (~:21-22), the "a dropped panelist is absent" paragraph (~:25), and the composition note in the output shape (~:106) — both panelists are always present, so there is nothing to compose. The judge still returns final answer + five-section audit to the orchestrator (that is the provenance the reveal path draws on — suppress display, never erase).

Forward-facing only: state the present rule positively; no tombstones ("no longer checks codex"). History goes in the commit message (`promptctl render future-facing-docs`).

### Investigation targets

**Required** (read before coding):
- /Users/mike/code/arthack/claude/arthack/skills/panel/SKILL.md:32-124 — Step 0 precheck, Step 2 fan-out, Step 3 judge spawn, Step 4 relay (rewrite), cost note (keep)
- /Users/mike/code/arthack/claude/arthack/skills/panel/references/panel.md:1-50 — dropped-panelist paragraph to cut, independence core to keep
- /Users/mike/code/arthack/claude/arthack/agents/panel-judge.md:16-26, :62-81, :101-108 — input bullets, audit sections (keep), output shape (drop composition note)

**Optional** (reference as needed):
- /Users/mike/code/keeper/plugins/plan/skills/hack/SKILL.md:90-99 — the sibling keeper callsite (task .2), for consistent framing

### Risks

- Over-editing the judge to "make it silent" — the judge is never human-facing; only the dropped-panelist machinery is removed, the audit / calibration stays.
- Deleting the `mkdir` with the precheck would break Steps 1-2 — it must be relocated.
- arthack is a SEPARATE git worktree from keeper: `keeper commit-work` may not stage it; commit via explicit-path `git add <paths>` + `git commit` + `git push` from /Users/mike/code/arthack (never `git add -A`).

### Test notes

- `grep -c "command -v codex" panel/SKILL.md` -> 0; `grep -c "mkdir -p /tmp/panel" panel/SKILL.md` -> >=1 (relocated).
- `grep -ci "dropped" panel/SKILL.md references/panel.md` -> 0.
- panel-judge.md still contains the five audit headings (Consensus / Contradictions / Partial coverage / Unique insights / Blind spots).

## Acceptance

- [ ] Step 0's codex availability precheck and the downgrade-to-Opus path are gone; the `mkdir` is relocated so Steps 1-2 still have their tmp dir; the panel is stated positively as always opus4.8-gpt5.5.
- [ ] Step 4 is rewritten so the judge's final answer is absorbed as the agent's own conclusion and answered in the question's natural shape — no audit dump, no composition note, no panel-naming by default; reveal is a trigger condition gated on the human asking about process / provenance.
- [ ] Dropped-panelist / composition machinery removed from SKILL.md, references/panel.md, and panel-judge.md; the judge keeps all five audit sections + calibration rules and still returns them to the orchestrator.
- [ ] All edits are forward-facing (no change-narration tombstones).

## Done summary

## Evidence
