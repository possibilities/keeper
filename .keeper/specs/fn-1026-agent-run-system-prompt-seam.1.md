## Description

**Size:** M
**Files:** src/agent/run-capture.ts, src/agent/main.ts, src/agent/dispatch.ts, cli/agent.ts, README.md, test/agent-run-capture.test.ts, test/agent-byte-pin.test.ts

### Approach

Add `--system-file <path>` / `--system <text>` to `agent run`, composed as a `System:`-prepend into the prompt CALLER-SIDE for ALL harnesses (claude/codex/pi) — uniform, transport-proven (mirrors pair's `assemblePrompt` kludge). NO native `--append-system-prompt`, NO `LaunchPosture`/`buildPairLaunchArgv`/`native*Args` change (that's the deferred fidelity upgrade). `pair send` UNCHANGED (it keeps its own `assemblePrompt`).

- **`parseRunArgs`** (`src/agent/run-capture.ts:141`): add `--system-file <path>` and `--system <text>` VALUE flags — mirror the `--stop-timeout-ms` split-form (:152) AND `=`-form (:168) arms — placed BEFORE the unknown-flag reject (:180); add them to `ParseRunArgsResult` (:123). BOTH set → `bad_args` (mutual exclusion; two spellings of ONE input). Return the raw path/text — the parser stays PURE (no file read).
- **Handler** (`runRunCaptureSubcommand`, `src/agent/main.ts:728`): resolve `--system-file` → text via `readFileSync(path,"utf8").trim()` (mirror `loadRolePrompt`, `src/pair-command.ts:92`); a missing/unreadable file → `bad_args` (exit 2) emitted IN THE HANDLER after parse (not a throw, not the pure parser). `--system` is inline text. Empty-after-`.trim()` → NO-OP skip (mirror `assemblePrompt`'s `systemPrompt===""` skip at `pair-command.ts:132`). Compose the prompt CALLER-SIDE in block order: `[READ_ONLY_DIRECTIVE (when readOnly)]` → `[System: <text> (when system set)]` → `[user prompt]`, joined by `\n\n` (mirror `assemblePrompt` :128-136). This composes with the EXISTING read-only directive prepend at :748.
- **NO launch change** — the composed text rides as the prompt positional (`cmd.at(-1)`), exactly like the read-only directive today. `LaunchPosture` / `buildPairLaunchArgv` / `nativeClaudeArgs`/`nativeCodexArgs`/`nativePiArgs` UNCHANGED, so `pair send` and the managed launch path are untouched.
- **Docs:** `dispatch.ts` `USAGE` (:64) + `KEEPER_AGENT_HELP` (:158) `run` synopsis + the two flags; `cli/agent.ts` header (:7-11); README ~:1429 — revise in place (forward-facing, no version markers).

### Investigation targets

**Required** (read before coding):
- src/agent/run-capture.ts:141 (`parseRunArgs`), :123 (`ParseRunArgsResult`), :152/:168 (value-flag split/`=` arms to mirror), :180 (unknown-flag reject), :14-17 (dep-free/pure contract — no file read here).
- src/agent/main.ts:728 (`runRunCaptureSubcommand`), :748 (the read-only directive prepend the new compose extends).
- src/pair-command.ts:63 (`READ_ONLY_DIRECTIVE`), :92 (`loadRolePrompt` read+discriminated-result pattern), :123-136 (`assemblePrompt` block order to mirror), :132 (empty-skip).
- src/agent/dispatch.ts:64 (`USAGE`), :158 (`KEEPER_AGENT_HELP`); cli/agent.ts:7-11 (header).

**Optional** (reference as needed):
- test/agent-run-capture.test.ts:160 (`parseRunArgs` describe — add the new arms), test/agent-byte-pin.test.ts:208 (`runCommand` pin — assert the composed prompt at `cmd.at(-1)`, no `--append-system-prompt`).

### Risks

- **pair BYTE-STABLE:** pair uses its own `assemblePrompt` and is untouched — but since the compose lives ONLY in the `agent run` handler (not the shared launch builders), pair cannot be affected; confirm no shared code changes. The golden + pair-cli tests guard it.
- **Deterministic compose order** (read-only directive → `System:` → prompt) — pin it byte-for-byte; a wrong order or a stray `User:` label diverges.
- **Mutual-exclusion + empty-handling** must be ONE rule across both spellings (both-set → `bad_args`; empty-after-trim → skip) — pin both.
- **File read → `bad_args` (exit 2) in the handler**, never a throw; resolve a relative `--system-file` against the caller cwd.
- **Deliberate low fidelity:** the uniform `System:`-prepend is user-turn text, NOT a privileged system prompt — a documented choice; do NOT add `--append-system-prompt` or a `LaunchPosture` field (future upgrade).

### Test notes

`parseRunArgs` arms: `--system-file`, `--system`, `=`-form, both-set → `bad_args`, unknown-flag reject still fires. Handler compose (byte-pin): `cmd.at(-1)` === the `[directive]+[System: text]+[prompt]` composed string, IDENTICAL across claude/codex/pi; missing `--system-file` → `bad_args` exit 2; empty file/text → no-op (no `System:` block). Assert NO `--append-system-prompt` in any argv. Pure/injected seams only — no real tmux/subprocess, no file outside the test tmpdir.

## Acceptance

- [ ] `agent run --system-file <path>` / `--system <text>` parse as value flags (split + `=` forms, before the unknown-flag reject); BOTH set → `bad_args`.
- [ ] The handler reads `--system-file` (missing/unreadable → `bad_args` exit 2) and composes CALLER-SIDE as `[read-only directive]` → `System: <text>` → `[user prompt]`, UNIFORM for claude/codex/pi; empty-after-trim → no-op skip.
- [ ] NO native `--append-system-prompt`; NO `LaunchPosture`/`buildPairLaunchArgv`/`native*Args` change; the composed text is the prompt positional (`cmd.at(-1)`).
- [ ] `pair send` BYTE-STABLE (golden + pair-cli green); managed launches byte-identical.
- [ ] byte-pins: claude/codex/pi all carry the `System:`-composed prompt at `cmd.at(-1)` with no `--append-system-prompt`; `bun test` green.
- [ ] `dispatch.ts` USAGE/HELP + `cli/agent.ts` header + README ~:1429 document the flags (revise in place).

## Done summary
Added --system-file/--system to agent run: a uniform caller-side System: prepend into the prompt for all harnesses (mutually exclusive; missing file -> bad_args; empty-after-trim no-op). No native --append-system-prompt and no launch-builder change; pair send byte-stable.
## Evidence
