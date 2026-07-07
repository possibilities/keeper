## Description

**Size:** S
**Files:** cli/tabs.ts, src/tabs-core.ts, test/tabs.test.ts

### Approach

`keeper tabs repair` (dry-run by default, `--apply` to land) heals rows whose recorded resume target names no on-disk artifact — the rot left by pre-fix resume cycles. Sweep live and killed non-claude jobs, gate each target through the disk-existence checks, and propose re-pins by matching harness session stores: pi session files under the job cwd's pi project dir matched by creation-time proximity to the job's created_at, codex rollouts by originator. Proposals land through the sanctioned resume-target back-fill write path (the same event-sourced seam the post-stop back-fill uses — never a direct jobs write). Output reports each job old → new with a confidence note; ambiguous matches are listed but never auto-applied. The standing exemplar this heals: the live arthack-123 pi tab whose job identity and recorded target diverged from its real on-disk session.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- the codex/hermes post-stop resume_target back-fill path — rg resume_target src/ to locate the synthetic event + fold arm; reuse that seam verbatim
- cli/tabs.ts:182-278 — TabsCommand parsing + main dispatch (add the verb)
- src/resume-resolve.ts — the artifact-existence gates from the resolver task

**Optional** (reference as needed):
- ~/.pi/agent/sessions/ — store layout: `<project-slug>/<iso-ts>_<uuid>.jsonl`
- src/restore-set.ts:118-144 — the jobs columns available to the sweep (harness, resume_target, cwd, created_at)

### Risks

- Time-proximity matching is a heuristic — confidence must be honest and ambiguity must refuse, or repair becomes a new poisoning vector.

### Test notes

Fixture a jobs set with a rotted pi row + a pi store containing one plausible and one implausible file: dry-run proposes the plausible with confidence; two plausible ⇒ listed, not applied; --apply emits the back-fill event and the projection re-reads repaired.

## Acceptance

- [ ] Dry-run lists each rotted job with a proposed artifact-backed target and a confidence note; --apply lands re-pins only through the event-sourced back-fill path.
- [ ] Ambiguous candidates are surfaced but never auto-applied.
- [ ] After an applied repair, keeper tabs dump emits resume lines whose targets all exist on disk.

## Done summary

## Evidence
