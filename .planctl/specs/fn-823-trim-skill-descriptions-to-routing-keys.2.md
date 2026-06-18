## Description

**Size:** S
**Files (relative to /Users/mike/code/arthack):** claude/arthack/skills/panel/SKILL.md, claude/work/skills/gmail/SKILL.md, claude/work/skills/tmux/SKILL.md, claude/arthack/skills/design-taste/SKILL.md, claude/arthack/skills/mrtasty/SKILL.md

### Approach

Same principle as the keeper task: trim each `description:` to a minimal routing key keeping BOTH "what it does" and "Use when…", removing internal mechanism, caveats, and synonym-dumps, and preserving genuine disambiguators. None of these arthack skills are promptctl-generated — re-confirm by checking for sibling `.managed-file-dont-edit` markers, then edit all in place.

Apply the drafted rewrites for panel and gmail. Light-review tmux/design-taste/mrtasty and trim only bloat: tmux's interactive-CLI examples (vim/htop/less/fzf, login-shell) do real disambiguation — keep them; design-taste's "distilled from analysis of 45+ elite websites" credential tail can go (it's not routing signal); mrtasty is `disable-model-invocation` (slash-only) — keep it readable.

Drafted rewrites (starting points):
- panel: "Fan a hard question out to a panel of models answering in parallel and independently, then fuse their answers into one with consensus and blind spots surfaced. Use for any non-tiny inquiry where being confidently wrong is expensive, or whenever the human wants a multi-model / panel / ensemble answer or a cross-checked, higher-confidence answer — even if they don't say \"panel\". Skip it for tiny or low-stakes questions where one direct answer will do." (Drop the runtime mechanism — "fan-out runs in main session via pairctl + Monitor; judge runs in subagent" — and the model-version specifics "Opus 4.8 and GPT-5.5 via codex" which drift; KEEP the non-tiny/expensive gate.)
- gmail: "Work with Gmail: send, read, search, draft, and reply to email, and manage labels, drafts, and filters. Use when the user mentions email, their inbox, or Gmail — e.g. \"check my email\", \"send an email to …\", \"search my inbox\", \"reply to that email\"."

### Investigation targets

**Required** (read before coding):
- claude/arthack/skills/panel/SKILL.md:1-20 — the 170-word/1042-char description; drop mechanism, model-version specifics, and the five-section audit enumeration; keep the non-tiny gate.
- claude/work/skills/gmail/SKILL.md:1-15 — the 77-word synonym pile to collapse.

**Optional** (reference as needed):
- claude/work/skills/tmux/SKILL.md, claude/arthack/skills/design-taste/SKILL.md, claude/arthack/skills/mrtasty/SKILL.md (light review).

### Risks

- panel's "skip for tiny/low-stakes" gate is load-bearing (the panel fan-out is expensive) — preserve it.
- Re-confirm no arthack skill is generated before editing (check for `.managed-file-dont-edit` siblings); edit in place only.

### Test notes

- Measure char counts (target ≤ ~600, cap 1024); confirm what + when preserved.
- Forward-facing present-tense prose only.

## Acceptance

- [ ] All 5 arthack skill descriptions are a routing key (what + when), ≤ ~600 chars, no mechanism/caveat/synonym-dump.
- [ ] panel reduced from ~1042 chars to ≤ ~600; non-tiny gate preserved.
- [ ] gmail synonym pile collapsed to a few representative triggers.
- [ ] tmux disambiguating examples kept; design-taste credential tail dropped; mrtasty kept human-readable.
- [ ] Forward-facing present-tense prose only.
- [ ] arthack repo committed via `keeper commit-work` (run from /Users/mike/code/arthack).

## Done summary
Trimmed all 5 arthack skill descriptions to routing keys: panel (1042 to 482 chars, mechanism/model-specifics dropped, non-tiny gate kept), gmail (synonym pile collapsed), design-taste (credential tail dropped). tmux and mrtasty already on-principle, left intact.
## Evidence
