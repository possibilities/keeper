## Description

**Size:** S
**Files:** scripts/classify_worker_dropoffs.py, migrate_acks_to_state.py, probe_worker_durability.py, scrub_draft_field.py (deleted), scripts/__pycache__ (removed), tests/test_work_skill_consistency.py, README.md, CLAUDE.md

### Approach

Delete the four Python scripts and the pycache; rewrite the tests/test_work_skill_consistency.py:119 comment so it states its constraint present-tense without naming the removed file. Invert the docs: README requirements list Bun as the production runtime with the promote script as the primary install, Python/uv as the dormant reference with the rollback note; CLAUDE.md:14 authority bullet states the bun binary is production and the Python package is the dormant reference (one sentence, present tense); Running Things rows re-documented — the command -v planctl conformance row described as the live-binary check, a Python-reference row pointing PLANCTL_BIN at the in-repo Python executable so the dormant implementation keeps a real parity surface, the fast gate row unchanged, and a promote row added. AGENTS.md is a symlink to CLAUDE.md — touch only CLAUDE.md; never create a real AGENTS.md.

### Investigation targets

**Required** (read before coding):
- README.md:12-40 and CLAUDE.md:14 + Running Things table — the lines being inverted
- tests/test_work_skill_consistency.py:119 — the dangling comment

### Risks

Backward-facing prose is the failure mode — every edited line states the present-tense fact; the rollback note is a forward rule.

### Test notes

Fast gate + skill-consistency tests green; `bun run lint`/typecheck green; a docs read-through confirms no tombstones.

## Acceptance

- [ ] scripts/ Python-free; dangling reference rewritten; suite green
- [ ] README + CLAUDE.md inverted, symlink intact, conformance rows truthful

## Done summary
Deleted the four unreferenced scripts/ Python one-offs + pycache and rewrote the dangling test comment present-tense; inverted README + CLAUDE.md so the bun binary is the production runtime/install and the Python package is the dormant reference + rollback target, with conformance rows re-documented and a promote row added.
## Evidence
