## Phase 2 — Implement

Implement per the spec's Approach + Acceptance. Match existing code style. Stay in scope. Add tests when Acceptance requires them. If you break something mid-implementation, fix it before moving on. Never use `TodoWrite`.

**Write file CONTENT with Write/Edit, never streamed Bash heredocs.** For whole-file or large multi-line content, use the Write/Edit tools — never stream the content through a `cat > file <<'EOF'` heredoc. A killed stream mid-heredoc leaves a partial, silently-truncated file; a failed Write is detectable and retryable. Scope: file content only — multi-line `keeper commit-work` commit messages stay sanctioned as heredocs.

## Phase 3 — Tests

Run project tests before staging anything. If they fail, you do not commit and you do not mark done.

Pick a test command from the project's manifest:

- `package.json` with a `test` script → `pnpm test` / `bun test` / `npm test`
- `Cargo.toml` → `cargo test`
- `build.zig` → `zig build test`

Prefer the epic's `## Quick commands` if present — they may include integration smoke tests beyond unit suites.

**Run the ladder, do not loop the suite.** Your test phase is bounded:

1. **Targeted tests first.** Scope from the task `Files:` list plus the tests you wrote or changed, using the ecosystem's file-arg form (`bun test <file>`, jest/vitest paths, `cargo test <filter>`). When the ecosystem has no per-file selector (e.g. `zig build test`), targeted collapses into the single full pass — that is expected, not a failure of the ladder.
2. **Then ONE full-suite pass** to confirm nothing else broke.

**Hard cap: two full-suite runs per worker invocation.** The cap bounds full passes only — fix-then-targeted-rerun iteration on your own failing code is not capped by it.

- **Failures confined to tests you did not touch** → re-run just those files serially once. A pass means proceed to commit; record the flake in `Tests:` (mixed pass/fail across runs = flaky — annotate and proceed; 100% fail across runs = deterministic — fix or escalate). Never code-fix-loop a flaky untouched test.
- **Failures in your own touched tests or code** → stay in the fix-then-rerun loop, but re-runs are TARGETED, never another full pass. If a small fix lands the targeted tests green, you do not owe a second full pass beyond the cap.
- If you cannot get your touched tests green, the typed escalation applies — do not commit, do not mark done.

**Never background a test run and never idle-wait on one.** Run tests in the foreground and act on the exit code.

**Hard-blocked — never do this to get green:** adding skip markers, commenting out assertions, weakening matchers, or deleting tests. Budget pressure does not license disabling a test; if you cannot make the real assertion pass, escalate.

**Independent source of truth for expected values.** Any test you write asserts against an expected value that comes from an independent source of truth — a hand-computed constant, a fixture, a spec — never one re-derived by the same code path under test. A test that computes its expectation from the implementation asserts nothing; the quality-auditor flags exactly this at audit time, so write it right the first time.

If tests pass, continue.

Before you escalate a test failure outside your scope, consult `keeper baseline <base sha> --wait` — the baseline answers "red at this sha in a healthy environment", so a baseline-confirmed red is genuinely pre-existing and not yours to fix, while a failure green at the baseline but red in your worktree is your environment, not the base. If the failure is in tooling itself (broken runner, missing deps, env issue) or in a baseline-confirmed pre-existing test you cannot account for as a flake, return `BLOCKED: TOOLING_FAILURE` with evidence by reference (the failing test name + the one-line assertion delta), not the full test log. Do not commit. Do not mark done. Do not patch the test runner.

## Phase 4 — Commit

Two-commit-per-task contract: this commit ships **source** (`feat(scope): ...`) carrying a `Task: $TASK_ID` trailer; the state commit lands automatically when `keeper plan done` fires at `emit()` (Phase 5). `commit-work` runs the full check matrix internally — per-extension shellcheck/zig/lua/hadolint + npm lint per JS/TS package. Never invoke linters separately.

```bash
keeper commit-work "<type>(<scope>): <summary>

<optional body — 1-3 bullets>

Task: $TASK_ID"
```

`<type>` is usually `feat` / `fix` / `refactor` / `test` / `docs`; `<scope>` comes from the task's file list. `commit-work` scopes to session-touched files and hard-stops a runaway list (`file_list_too_large`) on its own — run `keeper commit-work --preview-files` first only if you're unsure what's staged. Push to origin is automatic on success.

**On `lint_failed`** (`{"success": false, "error": "lint_failed", "linter": "<which>", "files": [...], "stderr": "<verbatim>", "recovery": "<fix→restage→re-invoke contract>"}`, or `"linter": "multiple"` with aggregated stderr): read the named files, fix per the stderr, re-stage with `git add`, re-invoke `keeper commit-work` with the same message. The only `commit-work` failure you handle inline.

**Any other non-zero exit → `BLOCKED: TOOLING_FAILURE`** with the verbatim envelope JSON (`commit_failed`, `push_*`, `lock_timeout`, sanitization, etc.). Don't patch the tool you're calling.

**Escape hatch — if `commit-work` won't stage the full file set, drop to git directly:** stage only the files you're committing by explicit path (`git add <path> …` — never `git add -A` / `git add .`), then `git commit` and `git push`. This never applies to a `lint_failed` envelope — that has exactly one recovery (fix, re-stage, re-invoke `commit-work` per above), never a bare `git commit` or `--no-verify`.

If you reach this phase with a clean tree (a predecessor already shipped the source commit — see Phase 1), skip it: *"tree clean, no source commit needed."*

**Trust git over the envelope (applies here and in Phase 5).** Wrapper envelopes are derived; `git log` is ground truth. Trigger on suspicion only — a `keeper commit-work` or `keeper plan done` envelope reports failure, or omits an expected field (a success envelope missing a sha is truncation, not success), while your own state says the operation should have succeeded; or any envelope contradicts what you just observed. Do not adjudicate by reasoning — run the ground-truth query: `git log -1 --format='%H %s'` and `git log --format='%H %s' --grep "Task: $TASK_ID"`. Git output wins. If git shows the commit landed, proceed — the envelope was wrong. If git agrees with the failure, retry the verb ONCE. Still inconsistent → `BLOCKED: TOOLING_FAILURE` carrying both the envelope JSON and the git output verbatim.
