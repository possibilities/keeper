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

Before you escalate a test failure outside your scope, consult `keeper baseline <base sha> --wait`. It hands back a discriminated verdict — `green` / `suite-red` / `infra-error` / `timeout` — and the VERDICT, not a bare non-green, decides your move. A `green` baseline with a red in your worktree points at your worktree's environment, not the base. A confirmed `suite-red` verdict is a genuine pre-existing red the base carries independent of your diff — return `BLOCKED: SHARED_BASE_BROKEN` naming the repo, base sha, and failing test; the confirmed-red safety net is unchanged. A `timeout` or `infra-error` verdict is INCONCLUSIVE — the gate was starved or its checkout failed, NOT evidence the base is red — so never attest `SHARED_BASE_BROKEN` from it: retry `keeper baseline <base sha> --wait` with backoff (a starved host recovers), and only if it stays inconclusive escalate as tooling trouble. This mirrors the daemon's own baseline gate, where a timeout or infra-error is never counted as red. For tooling itself broken (broken runner, missing deps, env fault) or a pre-existing red you can only account for as a flake, return `BLOCKED: TOOLING_FAILURE` with evidence by reference (the failing test name + the one-line assertion delta), not the full test log. Do not commit. Do not mark done. Do not patch the test runner.

## Phase 4 — Commit

Two-commit-per-task contract: this commit ships **source** (`feat(scope): ...`) carrying a `Task: $TASK_ID` trailer; the state commit lands automatically when `keeper plan done` fires at `emit()` (Phase 5). `commit-work` runs the full check matrix internally — per-extension shellcheck/zig/lua/hadolint + npm lint per JS/TS package. Never invoke linters separately.

```bash
keeper commit-work --task-id "$TASK_ID" "<type>(<scope>): <summary>

<optional body — 1-3 bullets>"
```

`--task-id` validates the task ref and appends the sole trusted `Task:` trailer mechanically. `<type>` is usually `feat` / `fix` / `refactor` / `test` / `docs`; `<scope>` comes from the task's file list. Always run `keeper commit-work --preview-files` first and inspect its one versioned result. Automatic selection uses this invocation's exclusive tool/plan claims; Bash, inferred, package-manager, and codegen rows are observations only. Push to origin is automatic on a successful main-worktree commit.

**An inspected missing path is an explicit adoption decision.** Re-preview with repeatable exact `--adopt <path>` arguments (or a versioned `--adopt-from` manifest). Adoption is invocation-local, byte/mode-bound, and refuses any live or unknown foreign exclusive claim. Never broaden the set or fall back to raw Git.

**On `ownership_conflict`, never signal or terminate the other claimant.** Read the envelope's `request_release` pointer — it names the claimant, the contested paths, and a `keeper session release` invocation you may advise via one bounded, best-effort `keeper bus chat send` notice. Wait the grace window, then re-run `keeper commit-work`; a still-live conflict on retry is `BLOCKED: DEPENDENCY_BLOCKED` naming the claimant and paths. Decline recording is deferred, so do not expect a decline annotation.

**On `outcome:"lint_failed"`** (including `linter:"multiple"` with aggregated bounded stderr): read the named files, fix per the stderr, then re-invoke `keeper commit-work` with the same message and adoption set. A lint failure is not an attribution gap.

**Any other non-zero exit → follow its typed recovery or `BLOCKED: TOOLING_FAILURE`** with the verbatim result JSON. In particular, a committed-local post-hook/push failure is not safe to recommit. Don't patch or bypass the tool you're calling.

If you reach this phase with a clean tree (a predecessor already shipped the source commit — see Phase 1), skip it: *"tree clean, no source commit needed."*

**Trust git over the envelope (applies here and in Phase 5).** Wrapper envelopes are derived; `git log` is ground truth. Trigger on suspicion only — a `keeper commit-work` or `keeper plan done` envelope reports failure, or omits an expected field (a success envelope missing a sha is truncation, not success), while your own state says the operation should have succeeded; or any envelope contradicts what you just observed. Do not adjudicate by reasoning — run the ground-truth query: `git log -1 --format='%H %s'` and `git log --format='%H %s' --grep "Task: $TASK_ID"`. Git output wins. If git shows the commit landed, proceed — the envelope was wrong. If git agrees with the failure, retry the verb ONCE. Still inconsistent → `BLOCKED: TOOLING_FAILURE` carrying both the envelope JSON and the git output verbatim.
