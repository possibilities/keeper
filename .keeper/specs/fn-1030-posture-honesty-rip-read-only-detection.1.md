## Description

**Size:** M
**Files:** src/pair-command.ts, cli/pair.ts, src/agent/launch-handle.ts, src/agent/main.ts,
src/agent/dispatch.ts, cli/agent.ts, README.md, plugins/keeper/skills/pair/SKILL.md,
plugins/plan/skills/panel/references/panel.md, test/agent-byte-pin.test.ts,
test/pair-command.test.ts, test/agent-run-capture-golden.test.ts, test/pair-cli.test.ts

### Approach

Rip the read-only DETECTION machinery; keep the directive. The run-capture envelope is
untouched.

**REMOVE — tool-strip (layer 1):**
- `nativeClaudeArgs` read-only branch (the `--disallowed-tools Edit,Write,NotebookEdit`
  strip) — make the non-read-only shape unconditional.
- `nativePiArgs` read-only branch (the `--exclude-tools edit,write`) — pi becomes posture-
  independent.
- `nativeCodexArgs` has NO strip today — only its doc-comment (mentions the git backstop) needs
  rewriting.
- Delete the now-vestigial `readOnly` field from `PairLaunchOpts` and `LaunchPosture`, and the
  `readOnly:` args at the `buildPairLaunchArgv` call in `launch-handle.ts` and the posture-fill
  sites in `src/agent/main.ts` and `cli/pair.ts`. (If this proves too churny, see the epic's
  Early proof point for the minimal fallback.)

**REMOVE — git backstop (layer 3), all caller-side in pair:**
- Delete `diffGitSnapshots`, `parseGitPorcelain` (and their section banner) from
  `src/pair-command.ts`.
- `buildPairOutput`: remove the `changedFiles` param and the `read_only_violation` block; drop
  the `read_only` echo too (retire the whole read-only YAML surface).
- `cli/pair.ts`: remove the `diffGitSnapshots`/`parseGitPorcelain` imports, the `gitSnapshot()`
  helper, the `beforeSnapshot`/`afterSnapshot`/`changedFiles` computation, the
  `read_only_violation` stderr WARNING block, the `changedFiles` arg into `buildPairOutput`,
  and the `changed=` field on the `completed` Monitor event line.

**KEEP — directive (layer 2):**
- `READ_ONLY_DIRECTIVE` and its two prepend sites (`assemblePrompt` in pair; the `agent run`
  prompt compose in `main.ts`).
- `--read-only` parsing in `parseRunArgs` (+ `ParseRunArgsResult.readOnly`) and in `cli/pair.ts`.

**DOCS:** rewrite every read-only description (dispatch USAGE/HELP, cli/agent.ts header,
cli/pair.ts doc+HELP, pair-command.ts native*Args docs, main.ts comment, launch-handle
LaunchPosture doc, README, pair SKILL.md read-only section + output-fields, panel.md) to
prompting-only. Add a forward-facing note near `stripClaudeEnv`/`launchEnvForAgent` that the
partner env-scrub is defense-in-depth (the load-bearing gate is `launchScriptEnv`'s allowlist +
the tmux-server env; `DYLD_*`/`LD_*` already blocked on the `--x-tmux-env` channel) — add NO new
scrubbing.

### Investigation targets

**Required** (read before coding):
- src/pair-command.ts: `READ_ONLY_DIRECTIVE`; `assemblePrompt` (KEEP the directive push);
  `nativeClaudeArgs`/`nativePiArgs`/`nativeCodexArgs` (strip branches to remove + docs);
  `PairLaunchOpts.readOnly`; `diffGitSnapshots`/`parseGitPorcelain`; `buildPairOutput`
  (`changedFiles`/`read_only_violation`/`read_only`); `stripClaudeEnv`/`launchEnvForAgent`
  (doc-note target, NO behavior change).
- cli/pair.ts: the `gitSnapshot()` helper, the read-only snapshot/diff/warning block, the
  `buildPairOutput` call, the `completed` Monitor event line (`changed=`), and the module doc.
- src/agent/launch-handle.ts: `LaunchPosture.readOnly` + the `readOnly:` pass into
  `buildPairLaunchArgv`.
- src/agent/main.ts: the read-only directive prepend (KEEP) + the `posture.readOnly` fill
  (remove) + the "tool strip rides via posture.readOnly" comment (rewrite).
- src/agent/run-capture.ts: `--read-only` parse + `ParseRunArgsResult.readOnly` (KEEP,
  unchanged) — confirm the 9-key envelope has no read-only field.
- src/agent/dispatch.ts: `USAGE` + `KEEPER_AGENT_HELP` read-only wording.

**Optional** (reference as needed):
- test/agent-byte-pin.test.ts: the `--read-only` strip-present pins (rewrite to directive-only,
  assert NO `--disallowed-tools`/`--exclude-tools`); the negative/managed pins stay green.
- test/pair-command.test.ts: `nativeClaudeArgs`/`nativePiArgs` strip tests (remove),
  `parseGitPorcelain`/`diffGitSnapshots` tests (delete), `buildPairOutput` read_only_violation
  tests (delete); KEEP `assemblePrompt` directive tests.
- test/agent-run-capture-golden.test.ts: the read-only strip goldens + `changed=`/
  `read_only_violation` goldens (update/delete); KEEP the 9-key envelope golden unchanged.
- test/pair-cli.test.ts: the read-only comment (update only).

### Risks

- **Envelope contract MUST NOT change** — do not bump `RUN_CAPTURE_SCHEMA_VERSION`; the 9-key
  golden stays green byte-for-byte. Only pair's `--output` YAML + the `completed` Monitor line
  lose fields (intended).
- **Directive must survive** — `--read-only` still prepends `READ_ONLY_DIRECTIVE` on both
  `agent run` and `pair send`; do not accidentally remove the prepend with the strip.
- **No double-removal / no dangling refs** — after deleting the git helpers, grep for any
  remaining `diffGitSnapshots`/`parseGitPorcelain`/`gitSnapshot`/`read_only_violation`/
  `changedFiles` references (incl. tests) and clear them all.
- **Exit codes unchanged** — the strip was argv flags and the backstop only wrote a stderr
  WARNING + YAML fields; neither drove an outcome/exit code. The 0/1/2 (pair) and 0/1/2/4
  (run-capture) taxonomy stays identical.
- **Do NOT harden env-scrub** — this task only DOCUMENTS the env-scrub finding; adding
  `ANTHROPIC*`/`*_API_KEY` stripping (esp. to claude) is out of scope and would break auth.

### Test notes

Update the byte-pins to assert directive-present + strip-absent (no `--disallowed-tools`/
`--exclude-tools`) across claude/codex/pi; delete the git-helper + `read_only_violation` +
`changed=` tests; keep the `assemblePrompt` directive tests and the 9-key envelope golden green
and unchanged. Pure/injected seams only — no real tmux/subprocess/git.

## Acceptance

- [ ] `nativeClaudeArgs`/`nativePiArgs` have no read-only strip branch; no launched argv carries
  `--disallowed-tools`/`--exclude-tools` for a read-only run; codex unchanged.
- [ ] `diffGitSnapshots`/`parseGitPorcelain`/`gitSnapshot` deleted; `buildPairOutput` and
  `cli/pair.ts` no longer compute or emit `changed_files`/`read_only_violation`; the `completed`
  Monitor line has no `changed=` field.
- [ ] `READ_ONLY_DIRECTIVE` + `--read-only` parsing KEPT on both `agent run` and `pair send`;
  the directive is still prepended.
- [ ] Vestigial `readOnly` fields removed from `PairLaunchOpts`/`LaunchPosture` (or minimal
  fallback taken per the epic) with no dangling references.
- [ ] run-capture 9-key envelope + schema version UNCHANGED; golden green; exit-code taxonomy
  unchanged.
- [ ] All read-only docs rewritten to prompting-only; env-scrub defense-in-depth note added; NO
  new env scrubbing. `bun test` + `bun run typecheck` green.

## Done summary

## Evidence
