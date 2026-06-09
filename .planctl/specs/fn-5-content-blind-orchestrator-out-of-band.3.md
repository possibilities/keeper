## Description

**Size:** M
**Files:** template/agents/worker.md.tmpl, template/agents/worker-codex.md.tmpl, template/skills/work.md.tmpl, tests/test_work_skill_consistency.py

Make the agent-facing prose consume the brief out-of-band: workers read `BRIEF_REF`; the orchestrator passes the handle, nudges on resume with process facts only, and auto-resumes dirty-after-done. Edit ONLY the `template/` sources — the rendered `skills/work/SKILL.md` and `work-plugins/<tier>/agents/worker.md` are gitignored generated outputs (promptctl owns rendering + the `.managed-file-dont-edit` sidecars). Do NOT hand-edit generated files.

### Approach

**worker.md.tmpl + worker-codex.md.tmpl (lockstep):** Phase 1 currently reads inlined `## Task spec` / `## Epic spec` blocks. Change to: read the brief from `BRIEF_REF` (a path in the Task prompt), parse its JSON, treat `task_spec_md`/`epic_spec_md`/`snippet_context` as the authoritative blocks (`snippet_context: ""` = no substrate). Self-check `task_id` and `target_repo` against the brief; on mismatch, missing/unreadable brief, or `schema_version != 1`, stop with `BLOCKED: TOOLING_FAILURE` (LLM-followable instruction — the reader is an agent, not Python). Rewrite the `BUNDLE_CONTEXT` config-var bullet and the `## Snippet context` note to the brief-file source. **PRESERVE the codex asymmetry**: the codex *wrapper* reads its context from the brief, but the codex *sub-prompt* (worker-codex.md.tmpl Phase 2, ~line 87) still directs codex to read specs via `planctl cat` — leave that; the wrapper extracts `snippet_context` from the parsed brief and writes it into the codex prompt file.

**work.md.tmpl:** Phase 1 — rewrite the "11-key envelope" para: `claim` returns `brief_ref` (path to `.planctl/state/briefs/<task_id>.json`), not the three prose fields. Phase 2a — drop the `## Snippet context`/`## Task spec`/`## Epic spec` assembly; the spawn prompt passes `BRIEF_REF: <brief_ref>` (plus the existing `TASK_ID`/`EPIC_ID`/`PLANCTL`/`TARGET_REPO`/`PRIMARY_REPO` config lines). Phase 2b — the warm directive and cold-resume prompt carry process facts only (`status`, `source_commit_sha`, `dirty_session_file_count`) + `BRIEF_REF` + "finish commit-then-done"; the cold path reads the typed `worker resume` envelope (task .2) and assembles a `BRIEF_REF`-carrying prompt (no narrative `prompt` field exists anymore). Phase 4 — dirty-after-done (session_files only; shared-tree rule absolute) AUTO-RESUMES: warm directive if `worker_agent_id` is addressable ("you returned done but these session files are uncommitted: <list> — commit with `keeper commit-work`, then done"), else cold respawn; folded into the existing 5-attempt budget; surface (not block) when exhausted.

Keep all prose present-tense (no "used to inline" tombstones).

### Investigation targets

**Required**:
- template/agents/worker.md.tmpl:25-29, 47-54 — `BUNDLE_CONTEXT` + Phase 1 spec-block read.
- template/agents/worker-codex.md.tmpl:25-31, 49-56, 87-88 — wrapper Phase 1 read AND the Phase 2 codex sub-prompt asymmetry (PRESERVE the latter).
- template/skills/work.md.tmpl:43-53 (Phase 1), 72-99 (Phase 2a assembly), 161-178 (Phase 2b cold path), 217 (Phase 4 dirty-after-done stop).
- tests/test_work_skill_consistency.py — parses fenced ```bash blocks for real `planctl` verbs + pins the `agentId:` regex; keep green after the prompt-shape edits.

### Risks

- **Codex asymmetry**: a naive "move everything to the brief" edit breaks codex's independent spec read — keep the Phase 2 codex sub-prompt's `planctl cat` directive.
- **Generated-file drift**: editing only templates; rendered outputs regenerate via promptctl. test_work_skill_consistency parses the template's bash blocks — any changed/removed `planctl` verb usage must keep it green.
- **Dirty-after-done is a behavior change**, not a content move — the worker already stamped `done`; the directive tells it to commit leftover session files, then it's done (no second `planctl done` needed if already stamped).

### Test notes

Run `tests/test_work_skill_consistency.py` after edits. If the project exposes a render command, regenerate and confirm the sidecar guard passes; otherwise note that the render/guard runs in CI. No new narrative `planctl cat` invocation should appear in the skill bash blocks.

## Acceptance

- [ ] Both worker templates read `BRIEF_REF` + parse JSON + self-check identity/repos with a `BLOCKED: TOOLING_FAILURE` stop on mismatch/missing/schema-mismatch; codex sub-prompt asymmetry preserved.
- [ ] work.md.tmpl Phase 1/2a pass `BRIEF_REF` with no prose inlining; Phase 2b nudges with process facts + `BRIEF_REF`; Phase 4 auto-resumes dirty-after-done within the 5-attempt budget (surface when exhausted).
- [ ] `BUNDLE_CONTEXT` / `## Snippet context` notes rewritten to the brief-file source; all prose present-tense.
- [ ] `tests/test_work_skill_consistency.py` green; ruff clean.

## Done summary

## Evidence
