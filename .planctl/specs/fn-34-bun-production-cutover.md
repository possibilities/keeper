## Overview

The production cutover: ~/.local/bin/planctl becomes the compiled bun binary, promoted atomically by a build-then-copy-then-rename install script with a rehearsed one-command rollback (`uv tool install --force` reinstating the Python shim). The plugin hook layer goes Python-free (pre/post hook entry points convert to bun before hooks.json flips — no guard-silent window). The four scripts/ Python one-offs are deleted. The Python package and pytest suite remain in-repo as the dormant reference until the next epic; docs invert to bun-as-production.

## Quick commands

- `bun run promote` — build (hard prerequisite) → temp-copy into ~/.local/bin → atomic rename over the planctl path; logs git rev-parse HEAD at promote
- `uv tool install --force /Users/mike/code/planctl` — the verbatim rollback (reinstates the Python shim); valid only while the Python package exists in-repo
- Soak cycle in a scratch git repo: init → scaffold → claim → done → close-preflight → audit/verdict submits → close-finalize

## Acceptance

- [ ] ~/.local/bin/planctl is the compiled bun binary, promoted by the script (which replaces the existing symlink as a path entry, never writing through it); rollback rehearsed successfully BEFORE the swap
- [ ] plugin/hooks/pre-hook.ts and post-hook.ts carry the full fail-open promptctl contract; hooks/hooks.json:10/:31 flipped to bun exec form ONLY after their tests are green; post-flip verification confirms the hooks actually fire
- [ ] Soak passes: full workflow cycle green in a scratch project against the swapped binary; first-hour watch clean per the runbook thresholds; runbook documents triggers + verbatim rollback
- [ ] scripts/ Python files (all four) deleted, __pycache__ removed, the one dangling comment reference rewritten present-tense
- [ ] README/CLAUDE.md inverted (bun = production runtime + primary install; Python = dormant reference with its own conformance row); AGENTS.md symlink untouched; no backward-facing prose
- [ ] Python fast gate + Python-reference conformance + bun gate + bun lint/typecheck/test all green

## Early proof point

Task that proves the approach: ordinal 1 (hook conversion — the strictest external contract; if the bun entry points can't reproduce the envelope-for-envelope behavioral spec, the cutover halts before any machine state changes).

## References

- Hook contract: plugin/hooks/pre-hook.py (PreToolUse Write/Edit → promptctl check-generated --on write → deny envelope on marked) and post-hook.py (PostToolUse Read → --on read → additionalContext envelope); FAIL-OPEN is contractual (exit 0 silent on any promptctl/JSON failure — a closed failure would brick every write). Exit-code semantics: 0 proceed (stdout JSON parsed), 2 hard block, anything else = non-blocking error and the action PROCEEDS — uncaught exceptions must resolve to the fail-open shape (main().catch pattern at plugin/hooks/commit-guard.ts:89). Never write stdout before the single JSON line; reuse lib.ts readStdin (TTY-safe) — Bun.stdin.json() hangs without a pipe. runPromptctl mirrors lib.ts runPlanctl (:98-129; bare name, fail-open, 5s timeout) but returns the full envelope (hooks read marked + message); verify promptctl emits a single-line envelope before relying on last-line parsing.
- hooks.json: the file is /Users/mike/code/planctl/hooks/hooks.json (repo root, co-located with .claude-plugin per CC #45296 — pinned by test_hooks_json_colocated_at_plugin_root; never relocate). Lines :10 and :31 carry the bare-executable Python commands; the flip is to the exec form mirroring the commit-guard entry (:17-21): command "bun", args ["${CLAUDE_PLUGIN_ROOT}/plugin/hooks/<name>.ts"].
- Test rewrites in tests/test_generated_guard_hook.py: _run_hook (:56-66) becomes a bun runner; wiring asserts (:98/:104/:142-146/:169-174) flip to exec form via the existing _exec_form_cmd helper (:120-132); the X_OK executability assert (:107-112) retargets; the behavioral contract tests (:248-407) define the envelope-for-envelope spec and run through the changed runner; the marker round-trip test (:481-509) stays green untouched.
- Promote mechanics: ~/.local/bin/planctl is currently a SYMLINK into the uv tool dir — the script copies dist/planctl-bun to ~/.local/bin/.planctl.tmp (same dir = same filesystem = atomic rename) then mv -f over the symlink path, replacing the symlink with a regular file and never following it; cp over the live file is forbidden (inode corruption for mid-exec processes); the script runs bun run build as a hard prerequisite in the same invocation and aborts non-zero leaving the old binary intact on any failure; logs git rev-parse HEAD. Runbook notes hash -r / rehash for long-lived shells.
- Rollback: rehearse BEFORE the swap (uv tool install --force → verify the shim answers planctl --help → proceed to promote); rollback validity ends when the Python package is deleted (next epic) — the runbook states this window. Triggers: any non-zero exit on a known-good verb during soak, any Uncaught/error: stderr pattern from planctl, or p95 invocation time > 2x the rehearsal baseline → run the verbatim rollback, no debate.
- Soak: scratch project in its OWN clean git repo (auto-commits need it; isolates confounders); the full cycle exercises the committing, locking, artifact, and saga paths; watch non-zero exit rate by verb, p95 wall time, lock contention (faster startup tightens loops), stderr patterns.
- Conformance rows post-swap: the command -v planctl row now exercises the production (bun) binary — re-documented as the live-binary check; the Python-reference row must point PLANCTL_BIN at the in-repo Python executable (e.g. the venv console script) so the dormant impl keeps a real parity surface; the in-process fast gate continues to exercise the Python package directly.
- scripts/: all four .py files externally unreferenced (two completed one-shot migrations; two mutually-referencing analysis tools with stale paths) — delete, plus __pycache__; tests/test_work_skill_consistency.py:119 carries a comment naming one — rewrite present-tense without the dead path.
- AGENTS.md is a symlink to CLAUDE.md: docs edits land in CLAUDE.md only; creating a real AGENTS.md or mirroring edits would break the symlink.

## Docs gaps

- **README.md:12-40**: requirements + install invert (Bun = production runtime, promote script = primary install; Python/uv demoted to dormant-reference + rollback note)
- **CLAUDE.md:14 + Running Things rows**: authority bullet inverts; conformance rows re-documented per the post-swap meanings

## Best practices

- **Copy-to-temp-in-same-dir + rename; never cp over a live binary** [LWN]
- **Hook exit !=2 means the action proceeds — fail-open must be deliberate, not accidental; one JSON line, stdout-clean** [Claude Code hooks docs]
- **Pre-agreed numeric rollback triggers prevent mid-incident debate** [canary practice]
- **hash -r/rehash for long-lived shells; already-exec'd processes are immune** [PATH caching]
