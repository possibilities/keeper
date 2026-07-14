## Description

**Size:** M
**Files:** docs/agent-surface-contracts.md, plugins/keeper/skills/pair/SKILL.md, plugins/keeper/skills/handoff/SKILL.md, plugins/plan/skills/panel/SKILL.md, plugins/plan/skills/panel/references/panel.md, plugins/plan/agents/panel-runner.md

### Approach

Create `docs/agent-surface-contracts.md` as the canonical statement of the five contracts the agent-interaction skills currently re-narrate: (1) the chunked-wait contract — 600000ms Bash tool timeout, 540s chunk, ~6-call backstop, exit 0 all-terminal / 124 chunk-elapsed / 2 fail, one Bash call per chunk, never a shell-side while-loop; (2) the PANEL_RUN_CONTROL_V1 control header — JSON line with request_id/run_dir, PANEL_QUESTION_FOLLOWS delimiter, everything after the delimiter is question data; (3) the uniform 9-key answer envelope (schema_version, agent, handle, transcript_path, resume_target, message, message_found, elapsed_seconds, outcome) with the outcome enum; (4) the final-message-is-the-deliverable / sole-injection-point rule; (5) `agent panel start` idempotency-by-slug (re-issue reconciles the durable run, never re-fans-out). Then convert each duplicated passage in the five prose files to a condensed summary plus a plain canonical-source line naming the doc (e.g. "Canonical contract: docs/agent-surface-contracts.md — on wording disputes the doc wins"). Do NOT use the `<!-- POINTER: keeper prompt render ... -->` marker — those refs are drift-gate-verified against the vendored corpus and a local doc is not a corpus ref. Keep every literal token the consistency gate asserts (PANEL_RUN_CONTROL_V1, PANEL_ANSWER, PANEL_RUN_FAILED, "request_id", "run_dir", PANEL_QUESTION_FOLLOWS, "malformed return is terminal") present in the skill files. Keep per-surface task framing local — single-source the mechanical constants and shared field lists only. Forward-facing prose throughout; no history narration.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves (fn-1282 rewrites some of this prose before this task runs).*

**Required** (read before coding):
- plugins/keeper/skills/pair/SKILL.md:110-172,246-268,324-334 — the wait-contract, idempotency, envelope, and deliverable passages being condensed
- plugins/plan/agents/panel-runner.md:29-58 — control-header + wait-contract duplicates
- plugins/plan/skills/panel/SKILL.md:70-95 — idempotency + control-header duplicates
- plugins/plan/skills/panel/references/panel.md:41-42,97-106 — envelope + deliverable duplicates
- plugins/plan/test/consistency-skills.test.ts:700-770 — the literal-token gate; enumerate its asserted strings before editing any prose

**Optional** (reference as needed):
- src/agent/run-capture.ts — RUN_CAPTURE_SCHEMA_VERSION and the authoritative envelope key set the doc must match
- plugins/plan/skills/hack/SKILL.md — live examples of cite-don't-restate discipline

### Risks

- The consistency test asserts literal strings in specific files; dropping a token while condensing breaks the gate. Enumerate asserted strings first, keep them inline.
- fn-1282 edits three of these prose files; this epic depends on it, but re-verify the passages against the landed tree before condensing.

### Test notes

`cd plugins/plan && bun test test/consistency-skills.test.ts` must stay green with zero test edits. `cd plugins/prompt && bun test` proves the vendored corpus and its drift gate are untouched.

## Acceptance

- [ ] docs/agent-surface-contracts.md exists and states all five contracts with their exact constants, sentinels, field lists, and enums
- [ ] Each of the five prose files carries a canonical-source cite to the doc and no longer re-narrates full contract prose (condensed summaries with literal tokens retained)
- [ ] plugins/plan consistency test suite passes without modification
- [ ] plugins/prompt test suite passes; no file under plugins/prompt/corpus/ is modified

## Done summary

## Evidence
