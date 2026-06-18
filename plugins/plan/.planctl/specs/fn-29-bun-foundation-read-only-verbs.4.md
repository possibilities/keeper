## Description

**Size:** S
**Files:** README.md, CLAUDE.md, AGENTS.md, package.json (if script polish needed), tests/test_readonly_verbs.py (only if a pin proves wrong)

### Approach

Cap the epic: run the full scoped gate — `PLANCTL_BIN="$PWD/dist/planctl-bun" uv run pytest tests/test_cli.py tests/test_readonly_verbs.py` — serially and with `-n`, plus the same module against the Python binary, plus the untouched Python fast gate and full Python conformance run; fix any fallout (preference order: fix the bun implementation > fix a genuinely wrong test pin; never weaken a pin to make the port pass without confirming against real Python output). Verify the compiled binary boots and passes under exactly the minimal conformance env. Then docs: README Requirements/Install fold in Bun (single block, no parallel mini-guide); CLAUDE.md and AGENTS.md Running Things tables gain the bun rows (build, lint, test, typecheck, and the scoped bun conformance invocation) in the existing two-column style, both files kept in sync; one-line polyglot authority statement (Python is the authoritative implementation; planctl-bun covers a read-only verb subset) in the Convention Divergences style. All doc prose present-tense and forward-facing.

### Investigation targets

**Required** (read before coding):
- CLAUDE.md + AGENTS.md Running Things tables — rows being extended; keep claims truthful
- README.md Requirements/Install sections — fold-in points

**Optional** (reference as needed):
- tests/conftest.py:580 — the exact minimal env to verify the binary under

### Risks

The gate may surface environment-coupling fallout (binary expecting env the harness strips); fix in the binary, not the harness — the harness's minimal env IS the contract.

### Test notes

The acceptance run is the test: scoped gate green against dist/planctl-bun (serial + -n), tests/test_readonly_verbs.py green against Python, fast gate green, full Python conformance green.

## Acceptance

- [ ] All four gate invocations green; no harness or Python-implementation changes
- [ ] README/CLAUDE.md/AGENTS.md updates landed, tables in sync, authority statement present
- [ ] Canonical scoped-gate invocation recorded in the Running Things tables

## Done summary
Capped the epic: full scoped gate green against compiled dist/planctl-bun (serial + -n), tests/test_readonly_verbs.py green against Python, Python fast gate and full conformance green, binary boots under minimal env. Landed docs: README Requirements/Install fold-in, CLAUDE.md (AGENTS.md symlink) bun rows + polyglot authority statement.
## Evidence
