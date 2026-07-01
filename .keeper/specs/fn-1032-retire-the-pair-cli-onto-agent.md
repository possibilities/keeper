## Overview

Delete the `keeper pair` CLI now that `keeper agent` has full parity (P1: `agent panel
start|wait` + ad-hoc single-member + role port; and `agent run` for the blocking single-shot).
Two moves:

1. **Relocate the shared launch cluster** out of `src/pair-command.ts` into a neutral
   `src/agent/` module (it is already consumed ONLY from `src/agent/`): `buildPairLaunchArgv` +
   `nativeClaudeArgs`/`nativeCodexArgs`/`nativePiArgs` + `stripClaudeEnv` + `PairLaunchOpts` +
   `PairCli`/`PAIR_CLIS` + `READ_ONLY_DIRECTIVE` + `resolvePairKeeperAgentPath` + the role
   resolver (`loadRolePrompt` + the role prompt assets). Rename to neutral identifiers.
2. **Delete the pair surface + repoint every consumer.** Remove `cli/pair.ts`, the `pair` verb
   in `cli/keeper.ts`, the pair-only leftovers in `src/pair-command.ts` (`assemblePrompt`,
   `buildPairOutput`/`pairOutputYaml`, `stopTimeoutMsFromSeconds`, `DEFAULT_PAIR_SESSION`, the
   pair-YAML output), and `test/pair-cli.test.ts`. Rewrite the `keeper:pair` SKILL onto `agent
   panel`/`agent run` (drop Monitor; mirror `plan:panel-runner`'s detached-start + chunked
   blocking-`wait` loop). Repoint `panel-runner.md`, `panel/references/panel.md`, `hack/SKILL.md`,
   and README from `keeper pair` → `keeper agent`. Add a retired-name lint guard pinning `keeper
   pair` at zero (reuse the existing `scripts/lint-retired-name.sh` pattern).

The `keeper:pair` SKILL survives as the human-facing pairing CAPABILITY — only its transport
changes to `keeper agent`. Monitors + hooks reference no pair CLI, so they need no change.

## Quick commands

- `bun run test` — full suite green
- `bun run typecheck` — `tsc --noEmit` clean
- `bun run lint` — biome clean
- (guard) the retired-name lint reports zero `keeper pair` references outside its own allowlist
- (out-of-band) `keeper pair send …` now errors (unknown verb); `keeper agent panel`/`agent run`
  cover it

## Acceptance

- [ ] `cli/pair.ts` + the `pair` verb are gone; the shared launch cluster lives in a neutral
  `src/agent/` module with neutral names; all importers (launch-handle, main, panel, tests)
  compile against it.
- [ ] `keeper:pair` SKILL drives `keeper agent panel start|wait` (Monitor-free, mirroring
  panel-runner) for long/multi and `agent run` for the quick single-shot; panel-runner.md /
  panel.md / hack / README reference `keeper agent`, never `keeper pair`.
- [ ] A retired-name guard pins `keeper pair` at zero; `bun test` + `typecheck` + `lint` + the
  guard all green.

## Early proof point

Do the code relocation (task .1) FIRST as a behavior-stable move (pair still works against the
relocated module), prove the suite green, THEN delete + repoint (task .2). If the neutral-module
move entangles the byte-pins, land the move with the pair verb still delegating, and delete the
verb in a tight follow-up commit within the same task.

## References

- The shared cluster is already consumed ONLY under `src/agent/` (launch-handle, main, panel) —
  the move is a relocation, not a redesign. `READ_ONLY_DIRECTIVE` is already load-bearing for
  `agent run`.
- Drive loop = `plan:panel-runner`: detached `start` (returns at once) + a re-issued blocking
  `wait --chunk 540` loop, backstop-bounded, token-free. The rewritten `keeper:pair` SKILL uses
  exactly this — NO Monitor, NO `[keeper-pair]` event contract. The quick/subagent case uses
  blocking `agent run` (≤10 min) or background+poll for longer.
- Reading the answer: each leg's `--output` is the uniform `agent run` JSON envelope
  (`message`/`transcript_path`/`handle`/`elapsed_seconds`/`outcome`) — the SKILL reads that, not
  the retired pair YAML.
- The retired-name guard already exists for the prior CLI rename; reuse `scripts/lint-retired-name.sh`
  + `test/lint-retired-name.test.ts` + the frozen-allowlist mechanism — add `keeper pair` (with a
  scoped allowlist for `.keeper/` board history + this guard's own files).
- `AGENTS.md`/`CLAUDE.md`: the codex-trust sole-writer invariant now names `agent run`; verify its
  wording stays true (it names the module, not the pair caller).

## Docs gaps

- **`plugins/keeper/skills/pair/SKILL.md`**: full rewrite of transport (Monitor-in-main +
  `keeper pair send` → `keeper agent panel start|wait` mirroring panel-runner; the quick case →
  `agent run`); output-fields section → the JSON envelope; drop the read-only YAML fields
  (already gone post-fn-1030). Keep the capability framing (second opinion / cross-vendor / audit).
- **`plugins/plan/agents/panel-runner.md`** + **`plugins/plan/skills/panel/references/panel.md`**:
  `keeper pair panel|send` → `keeper agent panel`.
- **`plugins/plan/skills/hack/SKILL.md`**: `allowed-tools: Bash(keeper pair:*)` → `Bash(keeper
  agent:*)`; the `/keeper:pair` skill-name cross-references survive.
- **README**: every `keeper pair …` → `keeper agent …`; drop the pair-CLI section.

## Best practices

- **Move then delete** — relocate the shared cluster behavior-stable (task .1), verify green,
  then delete the verb + repoint (task .2). Two reviewable steps.
- **Forward-facing docs only** — the rewritten SKILL/README describe `keeper agent` as it is now;
  no "formerly keeper pair" tombstones (the retired-name guard carries the history, per the
  plan plugin's sanctioned exception).
- **Reuse the retirement machinery** — do not invent a new guard; extend the existing
  lint-retired-name + frozen-allowlist.
