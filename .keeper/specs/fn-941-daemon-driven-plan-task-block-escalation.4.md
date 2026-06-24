## Description

**Size:** S
**Files:** plugins/plan/template/skills/work.md.tmpl (edit), plugins/plan/skills/work/SKILL.md (regenerated, do not hand-edit)

Strip the orchestrator-side escalation. The wielder's only job on a block becomes: stamp `keeper plan block` (if not already blocked) and surface-and-stop. The daemon (tasks 2+3) owns escalation. This lands LAST so there is never a window where a block goes un-escalated.

### Approach

Edit the TEMPLATE `plugins/plan/template/skills/work.md.tmpl` (never the generated SKILL.md — it is overwritten on render):
- Delete the entire Phase 2c escalation block (the bus send to `planner@<epic>`, the delivered/queued_for_wake branch, the auto-wake, the yield, the on-reply reconcile+resume) and its Guardrails summary bullet.
- Revise the `blocked` reconcile-verdict arm and the `BLOCKED: <category>` short-circuit: stamp `keeper plan block <task_id> --reason "<CATEGORY>: <text>"` (formatted with the category prefix the daemon producer parses) IF reconcile isn't already `blocked`, then surface the breadcrumb and STOP. No bus, no wake, no yield, no resume machinery.
- Remove `Bash(keeper bus chat send:*)` from the `allowed-tools` frontmatter (line 10) — the skill no longer sends on the bus.
- Keep the worker template (`worker.md.tmpl`) UNCHANGED — it still returns the `BLOCKED:` text breadcrumb.
- Forward-facing prose only: describe the new stamp-and-stop path; no "Phase 2c was removed" tombstone.

Regenerate the rendered skill: `keeper prompt render-plugin-templates --project-root /Users/mike/code/keeper`. Commit BOTH the template and the regenerated SKILL.md.

### Investigation targets

**Required** (read before coding):
- plugins/plan/template/skills/work.md.tmpl — Phase 2c region (~171-197), the blocked arm (~126), the BLOCKED short-circuit (~169), the RESUME_EXHAUSTED self-block (~146), allowed-tools (line 10), Guardrails summary (~218-223).
- plugins/plan/skills/work/SKILL.md — the generated mirror (confirm the .managed-file sidecar / render command).

**Optional:**
- plugins/plan/template/agents/worker.md.tmpl:188-202 — confirm the worker stays unchanged (still emits BLOCKED text).

### Risks

- Editing the generated SKILL.md instead of the template → silently lost on next render. Edit the .tmpl, regenerate.
- Leaving `Bash(keeper bus chat send:*)` in allowed-tools → stale unused permission.
- Landing before task 3 → a block-detection window with no escalator (the dep enforces order).
- Merge collision with fn-938 on the same template section (epic dep on fn-938 sequences this after it).

### Test notes

No code test surface (skill prose). Verify by rendering: after `render-plugin-templates`, diff the generated SKILL.md and confirm Phase 2c is gone, the stamp-and-stop path is present, and allowed-tools is tightened. Sanity-check the render didn't leave the template and SKILL.md out of sync.

## Acceptance

- [ ] Phase 2c escalation (bus send/wake/yield/resume) removed from the template; Guardrails updated.
- [ ] Blocked arm + BLOCKED short-circuit now stamp `keeper plan block --reason "<CATEGORY>: ..."` then surface-and-stop.
- [ ] `Bash(keeper bus chat send:*)` removed from allowed-tools; worker template unchanged.
- [ ] SKILL.md regenerated from the template and committed in sync; forward-facing prose only.

## Done summary

## Evidence
