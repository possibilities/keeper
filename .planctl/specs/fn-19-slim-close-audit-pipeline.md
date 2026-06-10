## Overview

Tighten the close-phase audit surfaces against the current coordinator
pipeline: the quality-auditor gets an explicit diff-only policy (the worker's
commit-before-done gate already ran the tests) and a bright-line rule routing
no-action observations to What's Good instead of Consider; the close-planner's
verdict emission switches to an indented JSON shape (the parser already
accepts it); and the verdict-schema module docstring becomes present-tense.

## Quick commands

- `grep -n "do not re-run\|never re-run\|What's Good" agents/quality-auditor.md` — policy + routing landed
- `grep -A3 '"decisions"' agents/close-planner.md` — verdict example is multi-line indented
- `uv run pytest tests/` — green

## Acceptance

- [ ] quality-auditor: explicit rule — audit the diff; never execute test suites or typechecks (the worker's passing-test gate already ran them) — present in BOTH the Audit rules and the Test Coverage/Test Budget sections, with the textual-flag path preserved (suspected assertion-weakening is flagged, not execution-confirmed)
- [ ] quality-auditor: routing predicate — an observation with no concrete fix to apply, where shipping as-is is fine, is one line in What's Good; Consider holds only changes the auditor would actually make
- [ ] The findings count formula (Critical + Should Fix + Consider) is unchanged; What's Good remains outside it and outside close-planner's reading list
- [ ] close-planner: the verdict JSON example block is itself pretty-printed (indent=2 shape) and the emission instruction mandates that shape; the ASCII structural-punctuation rule stands unweakened
- [ ] planctl/verdict_schema.py docstring states the present-tense contract with zero references to prior schemas, tiers, or the classifier
- [ ] tests/fixtures/auditor/with_findings.md is format-true to the new routing; `run_verdict_submit.py` and `run_audit_submit.py` are untouched
- [ ] No backward-facing prose anywhere

## Early proof point

Task that proves the approach: ordinal 1. If consistency tests pin exact
prompt strings that the edits move, recovery: update the assertions alongside
in the same commit — they are content guards, not behavior.

## References

- Evidence base (711 close-phase transcripts): 47% of auditor runs re-ran test suites and 17% ran full typechecks unprompted, duplicating the worker gate and double-running on timeouts; 84% of finding volume historically died unread downstream — the Consider section was the padding sink
- The closer's spawn gate reads the auditor's one-line `findings=N` return (skills/close/SKILL.md:64-68); lowering the organic count yields more findings=0 clean closes — intended
- run_verdict_submit.py:68 is a bare `json.loads` (accepts indented input today) and :90 already persists records with indent=2 — the emission change is prompt-only
- What's Good is a write-only sink: close-planner reads Critical/Should Fix/Consider only (close-planner.md:35); do not add What's Good to its reading list

## Best practices

- **Audit agents are reviewers, not CI runners:** re-executing suites adds flaky non-determinism to what should be stable textual analysis of a diff
- **Models copy examples, not mandates:** changing emitted-JSON shape requires changing the example block, not adding a sentence beside a contrary example
- **"JSON parses" is not "verdict correct":** the typed-reject loop on `verdict submit` handles syntax; decision quality is sampled over time, not asserted
