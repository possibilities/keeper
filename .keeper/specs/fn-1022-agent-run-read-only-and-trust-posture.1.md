## Description

**Size:** M
**Files:** src/agent/run-capture.ts, src/agent/main.ts, src/agent/launch-handle.ts, cli/pair.ts, src/agent/dispatch.ts, README.md, test/agent-byte-pin.test.ts, test/agent-launch-handle.test.ts, test/pair-cli.test.ts, test/agent-run-capture.test.ts

### Approach

Give `agent run` the read-only posture and MOVE codex-trust + CLAUDE-env-scrub into the shared launch helper so both `agent run` and `pair` get them via one path. BEHAVIOR-STABLE for pair; `agent run codex/pi` gain `CLAUDE*`-scrub (a correct partner-isolation improvement — new verb, no external consumers; pin + document it).

- **`--read-only` flag:** add an exact-match `--read-only` boolean case in `parseRunArgs` (`run-capture.ts:133`) ABOVE the unknown-flag reject (:167); add `readOnly` to `ParseRunArgsResult` (:124). In `runRunCaptureSubcommand` (`main.ts:725`, :746) set `posture.readOnly = parsed.readOnly` and prepend the directive CALLER-SIDE: `parsed.readOnly ? \`${READ_ONLY_DIRECTIVE}\n\n${parsed.prompt}\` : parsed.prompt` (raw `\n\n` join, NO `User:` scaffold — agent run has no role framing; reuse the exported `READ_ONLY_DIRECTIVE`). The shared helper stays directive-free so pair (which prepends via `assemblePrompt`) never double-prepends.
- **codex-trust move:** inject `ensureCodexDirTrust` as a NEW `LaunchHandleDeps` seam (bound to the real fn in production at `main.ts:675` + `cli/pair.ts:468`), fired inside `launchToResolvedHandle` for `agent === "codex"` (keyed on agent, not session-id) BEFORE `launchKeeperAgentInTmux` (:150). pair DROPS its explicit call (`cli/pair.ts:442-444`). Injected-seam (not a direct import) preserves the module's "every effect via `LaunchHandleDeps`" DI contract and lets tests stub it (no real `~/.codex` write).
- **env-scrub:** in the shared helper apply `stripClaudeEnv` (reuse `pair-command.ts:390`) by AGENT (claude = full env, codex/pi = strip `CLAUDE*`) — an agent-conditional DEFAULT, NO user flag (matches pair `cli/pair.ts:422-427`). pair DROPS its own env derivation for the LAUNCH; pair's `verbDeps.env` (`:498`, feeds transcript resolution) must stay byte-stable (resolution reads homeDir/agent-dirs, not `CLAUDE*`, so byte-neutral — VERIFY).
- **Docs:** `dispatch.ts` USAGE / `KEEPER_AGENT_HELP` + `cli/agent.ts` header + README ~:1423 document `agent run --read-only` (directive + tool-strip; detection-not-prevention; NO changed-files audit on this caller) + note codex/pi scrub `CLAUDE*` by default. Forward-facing fix README ~:3337 (trust-seed now via the shared launch path, not `cli/pair.ts`).

### Investigation targets

**Required** (read before coding):
- src/agent/run-capture.ts:124 (`ParseRunArgsResult`), :133 (`parseRunArgs`), :167 (unknown-flag reject).
- src/agent/main.ts:725 (`runRunCaptureSubcommand`), :746 (posture/prompt), :675 (`launchHandleDeps` binding — add the trust seam).
- src/agent/launch-handle.ts:78 (`LaunchPosture`), :87 (`LaunchHandleDeps` — add the trust seam), :121/:150 (`launchToResolvedHandle` / the launch call).
- cli/pair.ts:422-427 (env derivation to fold), :442-444 (`ensureCodexDirTrust` to drop), :468 (`launchDeps` — bind the trust seam), :498 (`verbDeps.env` — keep byte-stable).
- src/pair-command.ts:63 (`READ_ONLY_DIRECTIVE`), :390 (`stripClaudeEnv`).
- src/codex-trust.ts:228 (`ensureCodexDirTrust` — reads `CODEX_HOME`/`KEEPER_CODEX_TRUST_LOG` off its env arg; fail-open; node-only imports, db-free).

**Optional** (reference as needed):
- test/agent-byte-pin.test.ts:104,128 (negative pin + `POSTURE_FLAGS`; comment :96-103 anticipates this increment), test/agent-launch-handle.test.ts:32 (`deps()` — sandbox `CODEX_HOME` or stub the seam), test/codex-trust.test.ts (`envFor` sandbox), test/agent-run-capture-golden.test.ts (9-key envelope).

### Risks

- **Byte-stability (pair):** the `--output` YAML + two `[keeper-pair]` lines + exit codes + the exact launch argv + the env pair's `verbDeps` sees must stay byte-identical — the golden + pair-cli tests guard it; VERIFY `verbDeps` transcript resolution is unaffected by the moved env-scrub.
- **Managed launches byte-identical:** `buildKeeperAgentLaunchArgv` (`exec-backend.ts`, hardcodes claude) does NOT route through the shared helper — the negative byte-pin (agent-byte-pin.test.ts:104,128) stays green; add POSITIVE pins for `agent run --read-only codex` (read-only strip present) AND `agent run codex` without `--read-only` (drops `CLAUDE*` carriers — the agent-conditional scrub).
- **Test isolation for the codex FS write:** any codex-agent test through the helper MUST stub the injected trust seam OR sandbox `CODEX_HOME` + `KEEPER_CODEX_TRUST_LOG` — else it writes the developer's real `~/.codex` (the `deps()` helper passes `env:{}` today → falls to `homedir()`).
- **Dep-graph:** `launch-handle.ts` gains the trust seam/import — node-only + db-free (confirmed); the depgraph grep test stays green.
- **`agent run codex/pi` behavior change:** they gain `CLAUDE*`-scrub (intended improvement, not a regression) — pin + doc it so it doesn't read as accidental.

### Test notes

Keep the negative byte-pin green + add the positive pins (agent run --read-only codex strip present; agent run codex drops `CLAUDE*`). Stub the trust seam (or sandbox `CODEX_HOME`) in codex-agent launch-handle tests. Keep the golden 9-key envelope + pair-cli + codex-trust tests green; verify pair's `verbDeps` env byte-neutral. No real tmux/subprocess/git/`~/.codex`.

## Acceptance

- [ ] `agent run --read-only <cli> <prompt>` parses the flag (exact-match, above the unknown-flag reject), prepends `READ_ONLY_DIRECTIVE` (raw `\n\n`, no scaffold) caller-side, and sets `posture.readOnly` → the per-harness tool strip.
- [ ] `ensureCodexDirTrust` is injected as a `LaunchHandleDeps` seam and fired inside `launchToResolvedHandle` for codex (fail-open); pair drops its explicit call. `stripClaudeEnv` is applied agent-conditionally (codex/pi) inside the shared helper; pair drops its own launch env derivation.
- [ ] pair stays BYTE-STABLE: `--output` YAML + two Monitor lines + exit codes + launch argv + `verbDeps` transcript resolution unchanged (golden + pair-cli green); the directive is NOT double-prepended.
- [ ] Managed launches byte-identical (negative byte-pin green); positive byte-pins added for `agent run --read-only codex` (strip present) and `agent run codex` (`CLAUDE*` dropped).
- [ ] Codex-agent tests stub the trust seam / sandbox `CODEX_HOME` (no real `~/.codex` write); dep-graph + codex-trust tests green; `bun test` green.
- [ ] `dispatch.ts` help + `cli/agent.ts` header + README ~:1423 document the flag (detection-not-prevention; no changed-files audit here) + the default codex/pi scrub; README ~:3337 trust-seed attribution moved to the shared launch path.

## Done summary
Added agent run --read-only (exact-match flag, caller-prepended directive, per-harness tool strip) and moved codex-trust seeding + agent-conditional CLAUDE* env-scrub into the shared launchToResolvedHandle helper; pair delegates both and stays byte-stable. Docs frame read-only as detection-not-prevention.
## Evidence
