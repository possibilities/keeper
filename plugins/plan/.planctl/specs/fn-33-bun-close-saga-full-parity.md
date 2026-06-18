## Overview

Final verb wave of the Python→Bun migration: planctl-bun gains the close saga — epic close, close-preflight, close-finalize, the verdict/followup/audit submit trio, reconcile, worker resume, find-task-commit, and gist — reaching full CLI parity. Exit criterion is the program's parity finish line: `PLANCTL_BIN="$PWD/dist/planctl-bun" uv run pytest tests/ --run-slow` green with only python_only skips, and the bun gate row collapsed to that full-suite shape. After this, only the cutover epic remains.

## Quick commands

- `bun run build && PLANCTL_BIN="$PWD/dist/planctl-bun" uv run pytest tests/ --run-slow` — the finish line
- `PLANCTL_BIN="$(command -v planctl)" uv run pytest tests/ --run-slow` — the Python reference run the bun run must match

## Acceptance

- [ ] All close-saga verbs land: epic close, close-preflight, close-finalize, verdict/followup/audit submit, reconcile, worker resume, find-task-commit, gist
- [ ] Full-suite bun conformance green (serial and -n, with --run-slow); remaining skips are python_only only — no third category
- [ ] tests/test_gist.py exists (first coverage for gist; gh PATH-shim pattern); 4-way trailer round-trip proven (both engines write, both engines read)
- [ ] commit_set_hash canonicalization byte-identical across engines; audit artifacts written commit-free WITHOUT touched-log entries
- [ ] Verdict validation hand-rolled with python-jsonschema message parity on the pinned {loc,type,msg} surface (top-3 truncation, first-path schema fragment, true error_count)
- [ ] Python gates untouched; bun lint/typecheck/test green; docs collapsed to full-parity statements (authority bullets lose the surface enumeration; gate rows become the full-suite invocation), mirrors together
- [ ] global_state.py recorded as api-only/no-CLI-reach — deliberately unported this wave (cutover epic decides its fate)

## Early proof point

Task that proves the approach: ordinal 2 (the artifact/submit/schema spine — if hand-rolled message parity fights the pinned strings, the fallback is ajv plus a message-translation table; the golden assertions are the arbiter).

## References

- Program: ⑤b; only ⑥ cutover remains. Python sources are the executable spec.
- Verb classification (load-bearing): epic close is the ONLY self-committing verb here (emit verb=close → `chore(planctl): close <epic>`; plain emit_error shape — "Epic not found: …", "… is already done", "Cannot close …: N task(s) not done: …"; --force overrides; stamps status/updated_at/closer_done_at/close_reason; restamp NON-member). close-preflight, the submit trio, and worker resume are runtime-state-only (zero commits; artifacts under state/audits/, briefs under state/briefs/). reconcile and find-task-commit are read-only. close-finalize is conditionally-mutating with no own commit (orchestrates epic close + scaffold which carry their own). gist is read-only locally but shells gh.
- close-finalize saga (run_close_finalize.py:395): NO saga-state file — position derived from observable state; reversible checks first, irreversible epic close LAST; idempotent re-run returns the prior outcome; verdict read or SYNTHESIZED empty when report.meta says findings==0; commit_set_hash re-derived fresh, mismatch → STALE_ARTIFACTS; fatal → fatal_halt; zero survivors → closed_clean; survivors → adopt wired follow-up (matched by created_by_close_of provenance, NOT deps) / partial_followup (completeness: distinct non-null kept/merged ordinals == follow-up task count) / scaffold-then-close. IN-PROCESS delegation: Python chdirs + captures stdout from run_scaffold.run/run_epic_close.run and parses the minted epic_id (skipping the planctl_invocation line) — the bun port calls its OWN ported scaffold/epic-close functions in-process with captured output, same shape; created_by_close_of flows as an internal arg (no CLI flag) and bun scaffold must stamp it. CloseOutcome enum (closed_clean/closed_with_followup/fatal_halt/partial_followup) is exhaustiveness-tested against the /plan:close skill. Clears the session close marker at the single outcome chokepoint. epic followup-of must NOT exist as a command (a conformance test asserts No such command).
- Submit spine: audit_artifacts.py — path helpers, AUDIT_SCHEMA_VERSION=1, compute_commit_set_hash (canonical order-independent SHA-256 folding schema_version; sorted, compact separators, sort_keys, ensure_ascii), write_artifact (atomic mkstemp→fsync→replace→parent-fsync→0600, COMMIT-FREE and NEVER touched-logged — distinct from atomicWrite; a touched-logged artifact would get swept into the next mutating commit). submit_common.py — MAX_STDIN_BYTES 1 MiB, read_payload_capped, resolve_audit_context (brief load + schema_version gate), emit_submit_error. Verbs: verdict submit (VERDICT_INVALID with {loc,type,msg} rows: top-3 only, schema fragment for first failing path, true error_count; schema uses type/required/additionalProperties:false everywhere/minLength/pattern only — no enum/$ref/oneOf; cross-field pass: fatal⇒fatal_reason, merge target fid exists, culled⇒task null, kept/merged⇒int ordinal with bool explicitly rejected); followup submit (reuses scaffold validate dry-run — surfaces the scaffold code set verbatim + VERDICT_MISSING/TASK_COUNT_MISMATCH); audit submit (--findings/--risk, BAD_RISK).
- Git lookup: commit_lookup.py find_commit_groups — per repo: `git log --grep="Task: <id>" -F --pretty=%H` prefilter, then per-sha `%B | git interpret-trailers --parse` confirming exact Task trailer; touched_repos tri-state (None→[primary], []→[], list→resolved); AllReposBrokenError only when EVERY repo broken (single broken → stderr note + skip); clean miss → empty success; flat envelope fields sha/repo. reconcile uses the OTHER technique — `git log --format=%H%x1f%(trailers:key=Task,valueonly=true)` with exact-equality split (kills fn-5.1/fn-5.10 prefix collisions) — port BOTH faithfully; _GitError fail-closed (any unexpected git failure → tooling_error verdict, never a clean verdict); _run_git_raw for expected-non-zero (unborn HEAD); state_head_visible via cat-file blob HEAD:.planctl/tasks/<id>.json against the state repo; _compute_verdict is the pure truth table the exhaustiveness test drives. worker resume: git status --short + diff HEAD --stat (FileNotFoundError-tolerant), log -1 --grep Task --fixed-strings (None on any failure), brief regen via the landed brief module, work marker write, stderr Note: lines.
- gist: shells `gh gist create --desc … [--public] <files>`, last stdout line is the URL, webbrowser.open unless --no-open; plain emit_error; GH_TOKEN/GITHUB_TOKEN ride ambient env untouched; no planctl test exists today — this wave adds the first (PATH-shim fake gh recording argv/env, slow-bucket or wire marker).
- global_state.py: imported by NO run_* verb; test_global_state.py is pure-import with zero run_cli — no conformance reach. Deliberately unported; the cutover epic decides port-or-retire.
- Long-tail strategy for the finish line: cluster failures by (error type, frame, message prefix) BEFORE fixing; fix shared infrastructure first; order by failures-unlocked-per-hour; message-text failures are real parity failures, not cosmetic.

## Docs gaps

- **CLAUDE.md + AGENTS.md**: authority bullets collapse to the full-parity statement (drop surface enumerations); Bun conformance rows become the full-suite invocation, excluded-files caveats deleted
- **README.md:34**: bun prose drops the parenthetical surface list

## Best practices

- **Hand-rolled validator for a frozen small schema** — own the message strings; ajv's wording diverges from python-jsonschema (best_match vs errors[0]) and would need a translation table anyway [ajv docs, python-jsonschema docs]
- **git interpret-trailers --parse as the trailer oracle** (implies --only-input — config-driven trailers stay out); never regex %(trailers) display output; per-commit parsing, never concatenated bodies [git-scm]
- **Irreversible step last; idempotent re-entry from observable state** — no journal needed when state is re-derivable [saga pattern]
- **gh: bare name on PATH, ambient env untouched, exit code is the contract, stderr only for broad categories** [gh manual]
- **Cluster-then-fix for the 800-test long tail**; quarantine flakes out of the bucket counts [practice-scout]
