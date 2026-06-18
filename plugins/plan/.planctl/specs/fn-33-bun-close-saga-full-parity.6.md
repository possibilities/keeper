## Description

**Size:** M
**Files:** CLAUDE.md, AGENTS.md, README.md, src/** fixes, python_only markers only where genuinely warranted

### Approach

The finish line. Run `PLANCTL_BIN="$PWD/dist/planctl-bun" uv run pytest tests/ --run-slow` and drive it green: cluster failures by (error type, top frame, message prefix) before fixing anything; fix shared infrastructure first; order by failures-unlocked; message-text mismatches are real parity failures. Every remaining non-green test is either fixed in src/ or python_only-classified with a reason — no third category. Verify -n parallel and serial both green, plus the fast bun selection. Then collapse the docs: authority bullets in CLAUDE.md and AGENTS.md become the full-parity statement (no surface enumeration); Bun conformance rows become the full-suite invocation with the excluded-files caveats deleted; README's bun prose drops the parenthetical list; record global_state.py's api-only/no-CLI-reach status where the cutover epic will find it (the authority bullet or a Convention Divergences line — one sentence, present tense). Mirrors together, no narration.

### Investigation targets

**Required** (read before coding):
- The failing-test clusters themselves — run the gate first, read nothing else until bucketed
- CLAUDE.md/AGENTS.md/README.md — the lines being collapsed

### Risks

The long tail is genuinely unknown-sized; the bucketing discipline is what keeps it tractable. Reclassifying a fixable test as python_only to hit green is the failure mode to refuse.

### Test notes

The acceptance run IS the task: full suite vs bun (serial + -n + --run-slow), full suite vs Python (unchanged), fast gate (unchanged), bun unit/lint/typecheck.

## Acceptance

- [ ] Full-suite bun conformance green with only python_only skips; parallel and serial
- [ ] Docs collapsed to full-parity statements; gate rows truthful; global_state status recorded

## Done summary
Drove the bun conformance finish line: full-suite parity green serial + parallel (888 passed, 31 skipped, only python_only) matching the Python reference run byte-for-byte. Collapsed CLAUDE.md/README.md docs to full-parity statements, made the gate row truthful, and recorded global_state.py as api-only/no-CLI-reach for the cutover epic. No src/ fixes or new python_only markers needed.
## Evidence
