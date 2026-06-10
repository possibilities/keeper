## Description

**Size:** S
**Files:** CLAUDE.md, README.md

### Approach

In-place edit only — AGENTS.md is a symlink to CLAUDE.md; never rm+recreate or temp-file-rename. Compress 348 → <=130 lines using the section verdicts: DELETE outright (README already owns the content): Design stance; No kernel watchers (one bullet + README pointer survives); No in-process self-heal (one-line pointer); the Autopilot section's mode/cooldown/reap narratives (keep 2-3 sentences: boots paused, level-triggered, "does nothing" usually means a readiness gate — see src/readiness.ts + README); the Writes-tightly-scoped babysitter walls (keep the five permitted RPC surfaces as a terse list + "plans are read-only"). KEEP TRIMMED: Repo facts (symlink warning, one-manifest rule, babysitters carve-out in one sentence); Event-sourcing invariants (collapse to ~4 bullet tripwires); Hook rules (4 bullets, minus perf numbers and ticket refs); Migrations (forward-only + downgrade guard + SUPPORTED_SCHEMA_VERSIONS same-commit rule); Worker contract (as-is, already terse); Test isolation (canonical home — trim narratives, keep sandboxEnv five-paths rule, two-helpers rule, two-tier test:full gate; PRESERVE any retryUntil rule present at run time); Out of scope. Strip every fn-NNN id and incident date from kept text; rewrite kept rules present-tense. Then verify README's cross-references into CLAUDE.md (the `## Test isolation` pointer near l.550 and any other match of CLAUDE.md in README) still point at sections that exist — adjust the pointer text minimally if a section was renamed or absorbed.

### Investigation targets

**Required** (read before coding):
- CLAUDE.md (all 348 lines) and the epic spec verdicts
- README.md — `grep -n CLAUDE.md README.md` for every cross-ref; `## Architecture` and l.520-553 test-isolation paragraphs to confirm coverage before deleting a CLAUDE.md section

### Risks

Over-trimming Test isolation breaks the README pointer and drops genuinely load-bearing env-var rules; the sandboxEnv five-paths list and the test:full gate are tripwires, not narration.

### Test notes

`wc -l CLAUDE.md` <= 130; `ls -la AGENTS.md` still a symlink; `grep -cE 'fn-[0-9]' CLAUDE.md` returns 0; commit via keeper commit-work.

## Acceptance

- [ ] CLAUDE.md <= 130 lines; every kept rule passes the "an agent would otherwise get this wrong" test
- [ ] Zero fn-NNN ids and zero incident dates; no backward-facing phrasing
- [ ] AGENTS.md symlink intact; retryUntil rule preserved if present at run time
- [ ] All README cross-refs into CLAUDE.md resolve
- [ ] Done summary reports lines and chars deleted

## Done summary

## Evidence
