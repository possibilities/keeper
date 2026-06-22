## Description

**Size:** M
**Files:** plugins/plan/skills/panel/SKILL.md, plugins/plan/skills/panel/references/panel.md, plugins/plan/skills/panel/panel.md, plugins/plan/agents/panel-judge.md, plugins/plan/skills/hack/SKILL.md, CLAUDE.md, README.md

### Approach

Two cohesive moves, both "point consumers at keeper pair." (1) **Panel recompose:** in
`panel/SKILL.md:58-84` swap the two `Monitor(pairctl send-message …)` calls for
`Monitor(keeper pair send …)`, keeping the main-session parallel-Monitor orchestration;
rewrite the notification semantics (`[pairctl]`→`[keeper-pair]`, output_file shape) and the
`pairctl show-chat` reveal path (lines ~26,61,66,72,82-87,111,119); update
`references/panel.md:24-46` transport prose (keep Opus 4.8 / GPT-5.5 model names); verify the
sibling `panel.md` and align it; `panel-judge.md` needs only a small note since the output
stays YAML-with-`message`. (2) **Deprecation flips:** in `hack/SKILL.md` replace the
frontmatter allowed-tools `Bash(pairctl:*)` and the second-opinion references at lines
15/40/101 with `/keeper:pair` — preserving the advisory-vs-authoritative distinction — and
add `keeper:pair` to the skill inventories in `CLAUDE.md` and `README.md`. **Forward-facing
prose only** (no "pairctl was/formerly"); migration narration lives in the commit message.

### Investigation targets

**Required**:
- plugins/plan/skills/panel/SKILL.md:58-84 + notification/reveal lines — the transport swap.
- plugins/plan/skills/panel/references/panel.md:24-46 + the sibling panel.md — transport prose.
- plugins/plan/skills/hack/SKILL.md:6,15,40,101 — frontmatter + second-opinion refs.
- CLAUDE.md keeper-plugin skill inventory + README.md skill enumeration (~lines 388-389).

**Optional**:
- `keeper prompt render code-comment-style` / `future-facing-docs` — the forward-facing-prose rule to honor.
- plugins/plan/agents/panel-judge.md:20 — answer-file path example (update only if the output extension changes).

### Risks

- Forward-facing-prose discipline — no tombstone wording; reviewers will catch "formerly pairctl".
- The /hack advisory (outbound, weigh-it) vs authoritative (inbound bus) distinction must survive the rename.
- Overlap with fn-889 (planctl codemod) + fn-884.6 (re-bake /hack) on these exact files — land after them (deps wired) or rebase.

### Test notes

Grep the repo for residual `pairctl` references after the change (only the follow-on package-deletion + .keeper historical specs should remain). Render-check the panel + hack skills if tooling exists.

## Acceptance

- [ ] `/plan:panel` fans out via `keeper pair` (Monitor, main session), cross-vendor diversity intact; judge still reads answer-file paths.
- [ ] panel SKILL.md + references/panel.md + sibling panel.md describe the keeper-pair transport; notification + reveal paths updated.
- [ ] `/hack` frontmatter + second-opinion refs point at `/keeper:pair`, advisory/authoritative distinction intact.
- [ ] `keeper:pair` added to CLAUDE.md + README skill inventories.
- [ ] No residual keeper-side `pairctl` references outside the follow-on's scope; all prose forward-facing.

## Done summary

## Evidence
