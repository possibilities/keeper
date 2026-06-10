## Description

**Size:** S
**Files:** agents/quality-auditor.md, agents/close-planner.md, planctl/verdict_schema.py, tests/fixtures/auditor/with_findings.md

### Approach

Four hand-written tracked files, no templates, no re-render.

1. **agents/quality-auditor.md** — (a) Add the diff-only policy at two
   sites: a new Audit-rules bullet (:185-190) and a clause in the Test
   Coverage / Test Budget sections (:108-124): the worker's
   commit-before-done gate already ran the tests; audit the diff text;
   never execute test suites, typecheckers, or linters. Suspected
   assertion-weakening or missing coverage is FLAGGED from the diff
   (file:line, what to verify), never confirmed by execution. (b) Add the
   routing predicate at the Consider section (:163-164) and echo at What's
   Good (:181-183): an observation with no concrete fix to apply, where
   shipping as-is is fine, goes in What's Good as one line; Consider holds
   only changes the auditor would actually make. The findings count formula
   at :194 stays exactly as is — the count drops because flagging-only
   items leave Consider, not because the formula changes.
2. **agents/close-planner.md** — Replace the verdict JSON example block
   (:88-98) with the same content in pretty-printed indent=2 shape, and
   extend the emission instruction (:112-114) to mandate that multi-line
   shape (the submit verb parses it identically). Leave the ASCII
   structural-punctuation rule (:107) and the section enumeration
   (:35, :49) untouched; do not add What's Good to the reading list.
3. **planctl/verdict_schema.py** — Rewrite the module docstring (:3-7) to
   state only the present contract: what the verdict schema is, who emits
   it (close-planner), what validates it (`verdict submit`). No references
   to prior schemas, tier arrays, classifier files, or fn-numbers.
4. **tests/fixtures/auditor/with_findings.md** — Keep the fixture
   format-true: its soft "would increase confidence" Consider entry either
   moves to What's Good as one line or is replaced by a genuine
   change-I-would-make Consider item, so the fixture demonstrates the
   current routing.

Do NOT touch planctl/run_verdict_submit.py or planctl/run_audit_submit.py —
the verb side already accepts and persists indented JSON. While editing,
run the close-skill consistency tests; if they pin moved strings, update
the assertions in the same commit.

### Investigation targets

**Required** (read before coding):
- agents/quality-auditor.md:82-140,154-196 — audit strategy, report format, rules, findings formula
- agents/close-planner.md:86-114 — verdict example + emission instruction
- tests/test_close_skill.py and tests/test_close_skill_consistency.py — what strings they pin

**Optional** (reference as needed):
- planctl/run_verdict_submit.py:60-95 — confirm parser/persistence need nothing
- skills/close/SKILL.md:60-70 — the findings=N spawn gate (read-only context; no edit expected)

### Risks

- The prohibition must not suppress the empty-commits short-circuit wording (quality-auditor.md:33-50) — place it in the Phase 3 path only.
- One grep to confirm nothing in keeper projects `report.meta.json.findings` before assuming the lowered count is invisible outside the close flow.

### Test notes

`uv run pytest tests/` green; eyeball the rendered Consider/What's Good
sections read as a complete present-tense contract.

## Acceptance

- [ ] Diff-only policy present at both auditor sites with the textual-flag path preserved
- [ ] Routing predicate at Consider + What's Good; findings formula at :194 byte-identical
- [ ] close-planner verdict example is indent=2 multi-line; emission instruction mandates it; ASCII rule intact
- [ ] verdict_schema.py docstring present-tense, no historical references
- [ ] Fixture format-true; verb files untouched; `uv run pytest tests/` passes

## Done summary

## Evidence
