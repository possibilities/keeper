## Description

**Size:** M
**Files:** src/pair-command.ts, cli/pair.ts, src/pair/panel.ts, src/agent/main.ts, plugins/keeper/skills/pair/SKILL.md, README.md, test/pair-command.test.ts, test/pair-cli.test.ts

### Approach

STEP 1 — DE-RISK FIRST (live, via the work:tmux skill — a plain Bash call HANGS on an interactive prompt).
pi's live `--help` (v0.80.2) exposes NO approval-skip / yolo flag (only `--tools`/`--no-tools`/`--exclude-tools`,
which gate tool *availability*, not per-call approval). Probe: launch `keeper agent pi` interactively in a
scratch dir and confirm it (a) executes an `edit`/`bash` tool WITHOUT stalling on a per-tool approval prompt,
and (b) `--exclude-tools edit,write` is honored (errors or silently drops the tools — confirm the exact lowercase
token spelling). If pi stalls on tool approval and no skip mechanism exists, STOP and escalate (block the task) —
the feature is infeasible as-is; do not hack around it.

STEP 2 — allow pi through the harness gate (it is SHARED, so this auto-touches panels):
- `src/pair-command.ts`: add `"pi"` to the `PairCli` union (~:43) and the `PAIR_CLIS` set (~:45-48).
- `cli/pair.ts`: drop BOTH pi reject sites — the preset-harness check (~:264-271) and the `--cli` validation (~:317-323);
  update their message strings to `claude|codex|pi`. Update `--help` text (~:87,108) to `claude|codex|pi`.
- `src/agent/main.ts`: fix the hardcoded `preset.harness === "pi"` rejection (~:666, "claude|codex only") so
  presets-resolve ACCEPTS pi — otherwise panel.ts accepts a pi member while presets-resolve rejects it.
- `src/pair/panel.ts`: update the two now-stale "claude|codex only" messages (~:180,200) that read off the shared set.
- Keep `--effort` codex-only (cli/pair.ts:340; config.ts:347-349 already forbids effort on a pi preset). pi uses thinking, not effort — do NOT route pi through effort.

STEP 3 — `nativePiArgs(opts: PairLaunchOpts)` mirroring nativeClaudeArgs/nativeCodexArgs, and make
`buildPairLaunchArgv` dispatch THREE-WAY (~:227-228) — pi MUST route to nativePiArgs, never fall through to
nativeCodexArgs (codex's `--dangerously-bypass-approvals-and-sandbox` would crash a pi launch):
- Always emit `-na` (`--no-approve`) — ignore the repo's project-local `.pi/` resources (partner isolation, mirrors
  the CLAUDE*-strip rationale; also prevents the directory-trust hang).
- Append `--model <m>` when `opts.model` set (live `--help`: `--model <pattern>`).
- RO (`opts.readOnly`): add `--exclude-tools edit,write` (the confirmed-live tokens from step 1). RW: omit it.
  Never emit effort/thinking. Mind the variadic-last-flag gotcha (keep the assembled prompt last; value flags not dangling).
- RO remains directive-primary + git-snapshot backstop (already CLI-agnostic) — the tool-strip is reinforcement only.
- Do NOT add src/pi-trust.ts (pi's `-na`/`-a` replaces the need; trust.json is a shared profile path — a seeder would collide).
- pi omits the `KEEPER_TMUX_SESSION` carrier (claude-only, already correct) and goes down the existing stripClaudeEnv + `shouldReap` non-claude path (already correct — no change).

STEP 4 — docs: SKILL.md + README per Docs gaps. Commit via `keeper commit-work`.

### Investigation targets

**Required** (read before coding):
- src/pair-command.ts:43-48 (PairCli/PAIR_CLIS), :227-228 (dispatch), :249-274 (nativeClaudeArgs + variadic gotcha), :291-301 (nativeCodexArgs), :71-77 (READ_ONLY_DIRECTIVE), :485-519 (diffGitSnapshots backstop)
- cli/pair.ts:264-271 + :317-323 (the TWO reject sites), :87,108 (help), :340-343 (effort gate — leave codex-only), :370 (shouldReap — already pi-correct), :433-438 (env strip — already pi-correct), :453-455 (codex trust seed call site)
- src/pair/panel.ts:180,200 (shared-gate messages), src/agent/main.ts:~666 (hardcoded pi reject — the consistency fix)
- src/agent/config.ts:233 (PresetHarness incl pi), :347-349 (pi+effort forbidden)
- test/pair-command.test.ts:112-200 (nativeClaudeArgs/nativeCodexArgs byte-pin pattern), test/pair-cli.test.ts:194 (preset-valid pattern), :260-277 (the pi-preset-fails-loud test to INVERT)

**Optional:**
- src/codex-trust.ts (the pattern to NOT mirror), src/agent/transcript-watch.ts:230-252 (pi dir resolution — already done)

### Risks

- pi tool-approval STALL (step-1 probe gates the whole feature; block + escalate if it stalls — do not work around).
- `--exclude-tools` tokens silently ignored → RO degrades to directive+git only (still safe; the backstop, not the strip, is the guarantee). Confirm live before byte-pinning the test.
- PAIR_CLIS is shared: pair-send + panel.ts + main.ts:666 MUST move together or an accept/reject inconsistency remains.
- Do not add a pi-trust seeder — trust.json is a shared profile path (state-sharing.ts); a writer would collide.

### Test notes

Fast in-process tier only, faked (no real pi/subprocess/tmux — the live probe in step 1 is a manual de-risk, NOT a unit test).
- test/pair-command.test.ts: add a `nativePiArgs` byte-pin block (RW = `-na` [+ `--model` when given], no codex/claude flags, no effort; RO = also `--exclude-tools edit,write`) and a `buildPairLaunchArgv` pi case (argv routes to pi, contains NONE of `--dangerously-bypass-approvals-and-sandbox`/`--permission-mode`/`--disallowed-tools`, no `--agentwrap-tmux-env` carrier, prompt last).
- test/pair-cli.test.ts: INVERT the "pi preset fails loud (exit 2)" test (~:260-277) → pi preset now ACCEPTED, reaches launch and exits 1 (started+failed, cli=pi) like the preset-valid test at :194 (fixture preset uses model:/thinking:, NOT effort:). ADD a positive `--cli pi` test (reaches launch, exit 1).
- If step 1 forces a pi-trust.ts after all (only if `-na` proves insufficient), mirror test/codex-trust.test.ts — but default is no seeder.

## Acceptance

- [ ] Step-1 live tmux probe done: pi runs edit/bash tools without stalling (or task blocked + escalated), and exact `--exclude-tools` tokens confirmed
- [ ] `"pi"` in PairCli + PAIR_CLIS; both cli/pair.ts reject sites dropped + messages/help updated to claude|codex|pi
- [ ] `nativePiArgs` emits `-na` always, `--model` when given, `--exclude-tools edit,write` only in RO, never effort; `buildPairLaunchArgv` routes pi 3-way (never codex flags)
- [ ] pi consistent across pair-send + panel + presets-resolve (src/agent/main.ts:666 fixed; src/pair/panel.ts messages updated)
- [ ] RO = directive + git backstop + tool-strip; NO src/pi-trust.ts added
- [ ] SKILL.md + README updated per Docs gaps
- [ ] fast-tier tests added/inverted (nativePiArgs RO/RW, buildPairLaunchArgv pi, inverted pi-preset test, positive --cli pi); `bun test` green; `ty` clean; committed via keeper commit-work

## Done summary
pi is now a first-class keeper pair AND panel partner in read-only and read-write: widened PairCli/PAIR_CLIS to include pi, added nativePiArgs (-na always, --model when set, --exclude-tools edit,write in RO only, never effort) with 3-way buildPairLaunchArgv dispatch, and removed the pi-reject sites in pair-send, panel, and presets-resolve so accept is consistent. Live probe confirmed pi auto-runs tools (no per-tool approval gate) and honors --exclude-tools edit,write.
## Evidence
