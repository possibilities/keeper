## Description

**Size:** M
**Files:** plugins/plan/skills/cell-review/SKILL.md, docs/adr/, CONTEXT.md, plugins/plan/CLAUDE.md, plugins/plan/test/consistency-skills.test.ts

### Approach

Author the out-of-band grading skill and land the decision record. The skill (working name cell-review; slash-only, disable-model-invocation, static — no .tmpl, no managed sidecar; frontmatter modeled on hack/prompt) drives one run end to end: derive the work-list as committed briefs minus committed reviews (the authoritative watermark is this set difference — never a ~/docs file, never wall-clock); enrich each epic's grading packet from keeper.db via read-only `keeper query`/history verbs (session length, tool calls, retries, blocks — the observable difficulty proxies); fan the blinded selection-auditor agent over the corpus per-epic (each grade an independently retryable unit; stratify judge spend toward expensive-model picks, low-confidence picks, and cheap-signal misfires rather than uniform coverage); land each verdict via `selection-review-submit` stamping rubric_version, judge_model_version, and prompt_hash (re-grades pass `--force` deliberately on a version change; commit-then-advance means a crash resumes from the set difference); then compute and present — cohort rates keyed by config_hash with Wilson intervals and a minimum-cohort-count refusal below which the skill states the data is too thin, confidence calibration on quantile bins, and an explicit Simpson's-trap caveat on any cross-policy-version comparison. Corpus text is untrusted: the skill delimits brief/spec/forensic content as data in the auditor prompt and never interpolates it into its own instructions. Output lands as a per-run report plus updated running-findings doc under ~/docs/selection-reviews/ (markdown bodies only; sidecars belong to the hooks) and a proposals section naming exact model-selector.yaml guidance edits plus the mechanical drift-gate re-sync steps (model-guidance-check) — the skill proposes and STOPS; hand_tuned and the drift-gated blocks are written only by the human or the model-guidance skill. Optional backfill: for closed epics predating committed briefs, offer `selection-audit-brief --force` re-derivation, defaulting to forward-only. Alongside the skill: a new ADR recording the out-of-band decision superseding the close-time record (flip ADR 0011 to Superseded; pick the next genuinely free number — ids are doubled through 0012), the CONTEXT.md re-point ("Selection review" → the committed out-of-band dataset; Needs-human entry drops its display-only-member clause), and the plan CLAUDE.md skills blurb.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/skills/hack/SKILL.md and skills/prompt/SKILL.md frontmatter — the static slash-only pattern
- plugins/plan/src/selection_review_file.ts — the (task-1-updated) brief + review schemas the skill consumes and writes
- plugins/plan/agents/selection-auditor.md — the (task-2-reframed) blinded grading contract
- .keeper/selections/*.json sidecar shape — confidence/label_source for the calibration join
- docs/adr/0011-close-time-selection-review.md — the record to supersede; docs/adr/ numbering state
- CONTEXT.md:47-53 — the Needs-human and Selection review entries

**Optional** (reference as needed):
- docs/skill-authoring.md — authoring reference
- plugins/plan/model-selector.yaml + plugins/plan/scripts/model-guidance-check.ts — what a ratified proposal must re-sync

### Risks

- Scope discipline: the skill presents and proposes; any temptation to auto-apply guidance edits breaks the human-ratification boundary that is this epic's core control
- Small-cohort statistics are the failure mode — the minimum-count refusal must be a hard behavior, not advice

### Test notes

consistency-skills gains the new static skill (verb refs resolve, no managed sidecar); the skill's own logic is prose, exercised in production per repo test philosophy.

## Acceptance

- [ ] /plan:cell-review exists as a slash-only static skill; its verb references resolve against the CLI
- [ ] A run against the current board grades only closed epics with a committed brief and no committed review, lands version-keyed datasets, and re-running immediately is a no-op
- [ ] The run report presents cohort rates with intervals and refuses policy proposals below the minimum cohort count, stating the threshold
- [ ] Reports and the running-findings doc land under ~/docs/selection-reviews/ as markdown bodies; no metadata blocks, no authoritative state
- [ ] A new ADR supersedes the close-time selection-review record and 0011's status flips; CONTEXT.md carries the re-pointed vocabulary with the Needs-human clause dropped
- [ ] The skill's output includes proposed guidance edits with drift-gate re-sync steps and makes no write to model-selector.yaml

## Done summary
Added /plan:cell-review, the out-of-band worker-cell grading skill: derives its work-list as committed audit briefs minus committed reviews, fans the blinded selection-auditor over each epic, lands version-keyed verdicts via selection-review-submit, computes Wilson-interval cohort stats with a hard minimum-cohort refusal, and proposes (never writes) model-selector.yaml guidance. Landed ADR 0018 (superseding ADR 0011), re-pointed CONTEXT.md, added the plan CLAUDE.md blurb, and pinned the static skill in consistency-skills.
## Evidence
