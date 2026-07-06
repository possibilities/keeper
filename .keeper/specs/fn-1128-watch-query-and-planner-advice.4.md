## Description

**Size:** S
**Files:** plugins/plan/skills/plan/SKILL.md, plugins/plan/skills/plan/references/operator-orchestration.md

### Approach

Plan-side advice lands where each reader needs it: mechanics and framing in the disclosure reference, one-line pointer bullets in the skill. In references/operator-orchestration.md: (a) the multi-epic section gains a Research-epics bullet — a normal planned epic whose deliverable is knowledge; follow-ups gate on `complete` (the section's existing landed-vs-complete POINTER already covers the distinction); spec-time rule: every research task names its retrieval path, default acceptance-criteria-writes to `~/docs/<slug>.md`, Done summary for lightweight results; sizing — a bounded one-shot ask goes to `keeper:handoff` or `keeper:pair` instead. (b) The blocked-agent section gains a short plan-time design note: specs MAY name deliberate check-in points where the worker returns `BLOCKED: DESIGN_CONFLICT` / `SPEC_UNCLEAR` rather than guessing — the daemon wakes `planner@<epic>` once per block instance with the resume recipe; carry both caveats (TOOLING_FAILURE and unparseable categories never escalate and mint a silent sticky suppression; the wake requires the epic's creator edge — offline-known creators are queued and auto-woken, purged or foreign creators receive nothing). The note must not contradict the section's existing once-per-instance semantics or its bus-resume-PRIMARY / cold-re-dispatch-FALLBACK precedence. In plan/SKILL.md: extend the Phase 6 operator-branch bullet cluster with reference-shaped one-liners for both additions (research epics; designing check-ins) and the pilot-etiquette clause (manual piloting only on explicit human request or after asking) — detail stays in the reference file. Constraints: any fenced `keeper plan <verb>` command must match its --help (the plan consistency test validates them); keep docs/skill-authoring.md's Phase 3c anchor valid; no new render cites; forward-facing prose; never fork a divergent wording of the blocked-protocol mechanics.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/skills/plan/references/operator-orchestration.md:8-17 — the multi-epic section (existing POINTER at :14); :19-34 — the blocked-agent section both notes extend
- plugins/plan/skills/plan/SKILL.md:533 — the Phase 6 heading; :577-579 — the operator-branch bullet cluster to extend
- plugins/plan/test/consistency-skills.test.ts — which files and fenced commands it validates
- docs/skill-authoring.md:109 — the Phase 3c anchor that must stay valid
- src/daemon.ts:521-528 and src/reducer.ts:804-826 — the escalation denylist and once-per-block-instance latch the caveats state

**Optional** (reference as needed):
- plugins/plan/template/agents/worker.md.tmpl:211-227 — the worker BLOCKED brief and category vocabulary the check-in advice names
- src/bus-wake.ts — the offline-creator wake path

### Risks

- Wording fork of the blocked-protocol mechanics across surfaces — the reference file stays the single source; SKILL.md carries only pointers.
- The plan consistency test rejects fenced `keeper plan` commands that drift from --help.

### Test notes

`cd plugins/plan && bun test` (consistency-skills et al.); `bun scripts/vendor-corpus.ts --check`; prompt suite (reachability walks plan/skills).

## Acceptance

- [ ] The reference file carries the research-epic bullet (complete-gated, retrieval-path rule with the `~/docs/<slug>.md` default, sizing clause) and the plan-time check-in note with both caveats, without contradicting the existing once-per-instance and bus-resume-primary text
- [ ] The plan skill's operator-branch cluster carries one-line reference-shaped bullets for research epics, check-in design, and ask-first pilot etiquette — no mechanics restated in the skill body
- [ ] The plan test suite, vendored-corpus drift check, and prompt suite pass; the skill-authoring doc's Phase 3c anchor still resolves

## Done summary
Added research-epic and plan-time check-in advice to operator-orchestration.md plus reference-shaped pointer bullets in plan/SKILL.md's operator-branch cluster.
## Evidence
