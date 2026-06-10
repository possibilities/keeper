## Description

**Size:** M
**Files:** skills/close/SKILL.md, tests/test_close_skill_consistency.py (new), tests/test_close_skill.py (rewrite/retire), tests/test_close_skill_wire_format.py (rewrite/retire), CLAUDE.md, AGENTS.md, README.md, docs/reference/commit-at-mutation-boundary.md, docs/diagrams/planctl-workflow.mermaid.md

### Approach

Rewrite skills/close/SKILL.md (hand-edited — do NOT create a template) to the thin coordinator, ~7KB: one injection line (pass $ARGUMENTS as a single quoted token), no Phase-1 validation ladder, no cd (pass --project from the preflight envelope). Flow: `planctl close-preflight <epic_id>` (single failure pattern: ANY {success:false} → surface error.message verbatim, stop) → spawn quality-auditor blind (config-only prompt: EPIC_ID + BRIEF_REF; keep the transient-529 backoff ladder verbatim — it is a closer-level Task concern) → parse the one-line return (`findings=N`; unparseable → treat as findings>0) → findings=0 → close-finalize; else spawn close-planner blind (EPIC_ID, BRIEF_REF, REPORT_REF, plus the [instructions] tail as an opaque directive when present) → capture planner agentId via the work-skill Phase-2a regex → on `QUESTION: <text>` return: surface to the human, end turn with the id pinned; on the human's answer SendMessage(to=planner_agent_id, "ANSWER: ...") warm resume; cold fallback (SendMessage error / fresh session) re-spawns the planner against the persisted REPORT_REF with the answer in the prompt → `planctl close-finalize <epic_id>` → total switch over the four CloseOutcome members (+ typed errors incl. STALE_ARTIFACTS) → one-line report (three formats: clean / with-followup / fatal halt). Under autopilot, QUESTION: behaves like BLOCKED — chain halts, epic stays open. Drop the stale apps/hookctl/lib/session_naming.py pointer. Kill the model= kwargs on both spawns (agent files own models). Add tests/test_close_skill_consistency.py mirroring test_work_skill_consistency.py:101 (parse bash blocks, assert --help exit 0, handle --file - heredoc verbs without executing, pin the agentId regex; extend _MULTIWORD_PREFIXES for audit/verdict/followup/close-finalize); rewrite or retire test_close_skill.py + test_close_skill_wire_format.py (the <VERDICT_JSON> extraction they cover no longer exists). Docs sweep per the epic Docs gaps section — present tense only, no backward-facing prose (house rule; Removed-verbs list is the sanctioned exception and absorbs `classifier` + `epic followup-of`).

### Investigation targets

**Required** (read before coding):
- skills/work/SKILL.md (rendered) — the crushed-coordinator register, agentId capture regex, warm/cold resume wording to mirror
- tests/test_work_skill_consistency.py:101 — the consistency-test pattern (incl. _MULTIWORD_PREFIXES)
- skills/close/SKILL.md — current 529-backoff ladder (carry verbatim), report formats, session-name paragraph to fix

**Optional** (reference as needed):
- tests/test_defer_skill_consistency.py — non-templated-skill consistency-test variant
- README.md:66 + :154-161 — reconcile entry as the model; stale close prose to rewrite

### Risks

The skill's switch must stay total over CloseOutcome — the task-3 exhaustiveness test enforces it; update both together if an outcome is added. Docs drift: CLAUDE.md edits overlap fn-768's (epic dep already wired) — rebase over whatever landed.

### Test notes

`uv run pytest tests/ -q` full-suite green. Eyeball: rewritten SKILL.md under ~8KB; grep no claude-opus-4-5 / claude-sonnet-4-6 / hookctl / VERDICT_JSON anywhere under skills/close/.

## Acceptance

- [ ] skills/close/SKILL.md is the thin coordinator (single error pattern, blind spawns without model=, QUESTION warm/cold resume, total CloseOutcome switch, 529 backoff kept)
- [ ] tests/test_close_skill_consistency.py green; old verdict-extraction tests rewritten or retired; full suite green
- [ ] Docs sweep landed (CLAUDE.md + AGENTS.md, README, commit-at-mutation-boundary §3/§13, mermaid) — present-tense, no stale pointers, Removed-verbs updated
- [ ] grep confirms no version-pinned model ids and no <VERDICT_JSON> references under skills/ and agents/

## Done summary
Rewrote skills/close/SKILL.md as the thin content-blind coordinator (single error pattern, blind quality-auditor + close-planner spawns without model=, QUESTION warm/cold resume, total CloseOutcome switch, 529 backoff kept). Added tests/test_close_skill_consistency.py and swept the docs (CLAUDE.md/AGENTS.md, README, commit-at-mutation-boundary §3/§13, workflow mermaid; Removed-verbs absorbs classifier + epic followup-of).
## Evidence
