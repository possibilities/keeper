## Description

**Size:** M
**Files:** src/pair-command.ts, cli/pair.ts, src/codex-trust.ts (new), test/pair-command.test.ts, test/codex-trust.test.ts (new), plugins/keeper/skills/pair/SKILL.md, plugins/plan/skills/panel/SKILL.md, plugins/plan/skills/panel/references/panel.md, CLAUDE.md

### Approach

Two coupled code changes that MUST land together — the argv flip alone regresses (codex would hang on an untrusted cwd).

1. **Flip `nativeCodexArgs` to interactive** (src/pair-command.ts:272-288). Drop `exec`, `--skip-git-repo-check` (exec-only, no interactive analog), and the deprecated `--enable web_search_request`. Keep `--dangerously-bypass-approvals-and-sandbox` + `-m <model>` + `-c model_reasoning_effort="<effort>"` (all valid global/interactive flags — verified live: pane showed "permissions: YOLO mode" and ran the turn). The prompt stays the trailing positional appended by `buildPairLaunchArgv`. Rewrite the function doc-comment AND the `buildPairLaunchArgv` "headless one-shot reaped CLI-side" line (src/pair-command.ts:194) forward-facing: interactive, still UNTRACKED — codex fires no keeper hooks either way, so the `KEEPER_TMUX_SESSION` carrier stays claude-only and the synchronous reap `shouldReap = pairCli !== "claude"` (cli/pair.ts) is UNCHANGED. read-only posture is unaffected (carried by the prompt directive in `assemblePrompt`, not a codex flag).

2. **New dep-free trust-seed helper** `src/codex-trust.ts` (leaf-module discipline: `node:fs`/`node:os`/`node:path` only — no `bun:sqlite`/`./db`, no third-party deps; no subprocess needed). One exported, injectable-for-tests function (e.g. `ensureCodexDirTrust({ cwd, env, home })`) that:
   - resolves CODEX_HOME via the transcript-watch shape: `(env.CODEX_HOME ?? "").trim() || join(home, ".codex")`; config path = `<codexHome>/config.toml`.
   - canonicalizes the key with `realpathSync(cwd)` (inside the try — macOS symlink correctness).
   - FAST PATH (no lock): read the config if present, scan line-by-line for an EXACT trimmed header `[projects."<escaped-key>"]`; if found, return `already-trusted` and skip (respect any existing entry — do NOT override a user's explicit value). Trust is NOT inherited (verified) → EXACT-MATCH only, no ancestor walk.
   - SEED PATH (header absent): acquire an O_EXCL/`wx` lockfile (e.g. `<codexHome>/config.toml.keeper-trust.lock`) mirroring docs-pusher's `tryAcquireLock`/`stampLock`/`isLockStale` (pid-stamped + `process.kill(pid,0)` liveness + `LOCK_STALE_MS`) — BUT bounded WAIT-AND-RETRY (~2s, small backoff), NOT docs-pusher's skip-on-contention. After acquiring, RE-READ + re-scan (a lock winner may have just seeded it) → if now present, release + return. Else create the dir/file if absent and append a single complete snippet in ONE write: `\n[projects."<escaped-key>"]\ntrust_level = "trusted"\n`. TOML key escaping: replace `\`→`\\` then `"`→`\"` (the only basic-string escapes a POSIX path needs). Release the lock.
   - FAIL-OPEN everything: wrap in try/catch, never throw; on lock-timeout / unwritable / realpath error, best-effort log to a `KEEPER_*`-overridable path (mirror docs-pusher's `KEEPER_DOCS_PUSH_LOG`, e.g. `KEEPER_CODEX_TRUST_LOG`) and return a status token. The caller proceeds to launch regardless.

3. **Wire it in cli/pair.ts** on the codex path only: call the helper best-effort after `cwd` is resolved (~:272) and BEFORE `buildPairLaunchArgv`/`runAgentwrap` (~:373/387), gated `pairCli === "codex"`. Mirror the `gitSnapshot` try/catch fail-open call style; never gate the launch on its result.

4. **Doc accuracy** — the existing "codex is headless" framing becomes actively WRONG (an agent reading it would be misled; that is the carve-out for a doc-update acceptance item): update plugins/keeper/skills/pair/SKILL.md (launch-mode line + `--cli codex` row + one-line trust-seed note), plugins/plan/skills/panel/SKILL.md (~:81) + references/panel.md (~:30-32) (codex now interactive TUI; read-only still via directive), and add ONE forward-facing CLAUDE.md invariant (cli/pair.ts codex pre-launch trust-seed is the only keeper surface writing codex's config dir, fail-open).

### Investigation targets

**Required** (read before coding):
- src/pair-command.ts:236-288 — `nativeClaudeArgs` (interactive precedent), `nativeCodexArgs` (target), `buildPairLaunchArgv` codex/claude split + the carrier injection.
- cli/pair.ts:271-296, 358-387 — launch block, cwd resolution, codex env strip, `shouldReap` gate, the launch/wait/reap sequence; where the seed call slots in (the `gitSnapshot` fail-open call style at :120-134 is the pattern).
- plugins/keeper/plugin/hooks/docs-pusher.ts:288-384 — the O_EXCL/`wx` lock model to mirror (`tryAcquireLock`/`stampLock`/`isLockStale`/`releaseLock`, `LOCK_STALE_MS`, `process.kill(pid,0)`); ADAPT to wait-and-retry, not skip.
- src/agent/transcript-watch.ts:219-220 — the `${CODEX_HOME:-~/.codex}` resolution shape to reuse.
- test/pair-command.test.ts:165-193, 242-268 — the byte-pin tests that must flip (currently assert `exec`/`web_search_request` present).
- src/doc-commit.ts:8-13, 78-99 — dep-free leaf + injectable-runner conventions to mirror for the new helper.

**Optional**:
- test/helpers/sandbox-env.ts — only if a spawn test is added; prefer pure in-process unit tests with an injected tmpdir CODEX_HOME.
- src/dead-letter.ts:11-13 — dep-free leaf precedent.

### Risks

- **Torn append on crash mid-write:** a single append of a small complete snippet is atomic enough given the seed-completes-before-codex-launch ordering (no concurrent codex reader; other pair writers are lock-serialized). Accept — the atomic-temp-rename alternative rewrites the whole ~571KB and is unnecessary. Note the tradeoff in the helper doc-comment.
- **Existing header with a non-`trusted` value (user explicitly set untrusted):** the exact-header check treats it as present and skips (respects the user's choice); codex then prompts and the pair may time out (the timeout path still reaps the window). Vanishingly rare — accept.
- **realpath-key vs raw-cwd asymmetry with `findCodexTranscriptPath` (transcript-watch.ts:226 matches raw `opts.cwd`):** pre-existing; the pair flow resolves the transcript by run-id handle, not cwd, so it is NOT on the critical path. One-line note only — do not "fix" it here.
- **A different keeper component writing config.toml:** none today (this is the only writer); the lock covers concurrent pair launches only.

### Test notes

- Update byte-pins (test/pair-command.test.ts): `nativeCodexArgs` no longer contains `exec`/`--skip-git-repo-check`/`web_search_request` (add `.not.toContain` negative guards); keep `--dangerously-bypass-approvals-and-sandbox` + model/effort pins; flip the `buildPairLaunchArgv` codex argv assertion.
- New test/codex-trust.test.ts — pure, in-process, injected tmpdir CODEX_HOME, NO real codex spawn, NO real `~/.codex` write. Assert: (a) skip when exact header already present; (b) append the exact expected snippet when absent; (c) idempotent re-run (second call no-ops); (d) a child of a trusted ancestor STILL gets seeded (trust is not inherited); (e) fail-open when CODEX_HOME points at an unwritable/junk path (returns a status, never throws); (f) TOML key escaping for a synthetic path containing a quote.
- Run `bun run test:full` (routes through scripts/test-gate.ts) before landing.

## Acceptance

- [ ] `nativeCodexArgs` launches codex interactively (no `exec`/`--skip-git-repo-check`/`--enable web_search_request`); byte-pin tests updated with negative guards; the pair wait-for-stop / show-last-message / synchronous reap flow still returns the partner's final message.
- [ ] `src/codex-trust.ts` seeds `[projects."<realpath(cwd)>"] trust_level = "trusted"` into `${CODEX_HOME:-~/.codex}/config.toml` only when no exact header exists; idempotent; exact-match only (no ancestor-inheritance assumption).
- [ ] the helper is concurrency-safe (O_EXCL lock + post-acquire re-check, wait-and-retry not skip) and fail-open (never throws, never blocks the launch); wired codex-path-only in cli/pair.ts before the launch.
- [ ] new helper unit tests + updated byte-pins pass with NO real codex spawn and NO write to the real `~/.codex`; `bun run test:full` green.
- [ ] docs no longer describe codex as headless (pair/SKILL.md, panel SKILL.md + panel.md) and CLAUDE.md carries the one-line fail-open trust-seed invariant.

## Done summary
Flipped nativeCodexArgs to launch the codex pair/panel partner as an interactive TUI (dropped exec/--skip-git-repo-check/deprecated web_search flag) and added the dep-free fail-open src/codex-trust.ts seeder that pre-seeds codex per-directory trust (idempotent, O_EXCL-locked), wired codex-path-only in cli/pair.ts before launch; docs + CLAUDE.md updated.
## Evidence
