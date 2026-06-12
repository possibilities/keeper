## Description

**Size:** M
**Files:** plugin/hooks/pre-hook.ts (new), plugin/hooks/post-hook.ts (new), plugin/hooks/lib.ts, hooks/hooks.json, tests/test_generated_guard_hook.py, plugin/hooks/pre-hook.py + post-hook.py (deleted at the end)

### Approach

Strict order: (1) write the two bun entry points reproducing the Python hooks envelope-for-envelope — stdin via lib.ts readStdin, gate on tool_name/file_path exactly as Python does, runPromptctl helper added to lib.ts (mirror runPlanctl: bare-name spawn, fail-open null on any failure, 5s timeout; return the full parsed envelope; confirm promptctl's output shape supports the parse before trusting last-line), deny/additionalContext envelopes byte-shaped, single JSON line on stdout and nothing else, main().catch fail-open wrapper, executable with the bun shebang; (2) rewrite the test runner (_run_hook → bun against the .ts) and the wiring/executability asserts to the exec form via _exec_form_cmd, leaving the behavioral contract tests' assertions (:248-407) and the marker round-trip (:481-509) semantically untouched; (3) run the full hook test file green; (4) ONLY THEN flip hooks/hooks.json:10 and :31 (the repo-root file — plugin/hooks/ has no hooks.json) to the bun exec form mirroring the commit-guard entry, keeping the file co-located; (5) delete the two .py entry points; (6) verify post-flip that the hooks actually fire in a live session (a Write into a generated-marked file gets denied; a Read of one gets the context note) — the loading check no test covers.

### Investigation targets

**Required** (read before coding):
- plugin/hooks/pre-hook.py and post-hook.py — the envelope contract being reproduced
- plugin/hooks/lib.ts:29-33 readStdin, :98-129 runPlanctl — the helpers to reuse/mirror
- plugin/hooks/commit-guard.ts — entry-point structure incl. the fail-open catch
- hooks/hooks.json — both command shapes; lines 10 and 31
- tests/test_generated_guard_hook.py:56-66, :98-174 — the runner and wiring asserts to rewrite

### Risks

An uncaught bun exception exits 1, which PROCEEDS — for these deliberately fail-open hooks that is the correct direction, but partial stdout before the crash corrupts CC's parse; keep diagnostics on stderr only. The flip-before-green ordering is the guard-silent failure mode this task's sequencing exists to prevent.

### Test notes

Full tests/test_generated_guard_hook.py green (default + conformance engines); bun lint/typecheck green; live-fire verification recorded in Evidence.

## Acceptance

- [ ] Both .ts entry points reproduce the behavioral contract tests envelope-for-envelope; fail-open proven (promptctl missing/broken/garbage → exit 0 silent)
- [ ] hooks.json flipped only after green; co-location preserved; .py entry points removed
- [ ] Live-fire post-flip check confirms deny and context paths

## Done summary

## Evidence
